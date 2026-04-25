// client/quality/text-monitor.ts
//
// Gemini 2.5 Flash judge for text (deep-research) use case.
//
// Uses Function Calling to force a structured response. Without forced mode,
// the model sometimes returns prose and our parser breaks. With mode: "ANY",
// every response is a function call with the declared schema.
//
// LAYERED quality oracle — three independent signals, one combined score:
//
//   Layer 1 (Gemini)        — topic drift detection
//   Layer 2 (Gemini)        — spec adherence: the response respects concrete
//                             identifiers stated in the prompt (field names,
//                             endpoints, versions, exact strings, etc.)
//   Layer 3 (deterministic) — backtick-quoted identifiers in the prompt MUST
//                             appear verbatim in the response. Pure regex,
//                             no LLM, can't be gamed.
//
// final_score = min(layer1, layer2, layer3). Any single layer can pull the
// score below threshold and fire the kill gate. The reasoning text names
// the layer that flagged the chunk so the dashboard timeline shows which
// signal fired.
//
// Why three layers and not one: each catches a different failure mode.
//   - Layer 1 catches "model wandered off the prompt's subject" (drift).
//   - Layer 2 catches "model stayed on subject but contradicted prompt
//     specifics, e.g. used the wrong domain name, invented a field."
//   - Layer 3 is the cheap, undeniable backstop: if you backticked
//     `signTypedData` in the prompt and the response writes `signMessage`,
//     the regex catches it before the next chunk gets paid for. This is
//     the classic "prompt-engineer wrote a curl with the wrong field names,
//     paid for the whole thing, then discovered the bug in Postman" failure
//     mode — caught at chunk N, not at the end.
//
// What this does NOT catch: external truth. Whether cited sources exist,
// claims about the world the prompt didn't state, subtle factual errors
// against ground truth not provided inline. For ground-truth API validation
// against an EXTERNAL reference (OpenAPI spec, JSON schema), pair this with
// a domain-specific schema validator. See docs/PITCH_FRAMING.md §0.
//
// Retry policy: transient 503/429/5xx errors get up to 5 retries with
// exponential backoff (2s, 4s, 8s, 16s, 30s cap). Paid-tier Gemini-2.5-flash
// still returns 503 "high demand" during peak hours; Google's guidance is
// to back off for up to 60s. Worst-case total wait per chunk is ~60s,
// which is acceptable for a demo.

import {
  GoogleGenerativeAI,
  FunctionCallingMode,
  SchemaType,
  type FunctionDeclaration,
} from "@google/generative-ai";
import type { QualityMonitor, QualityContext } from "../../shared/types.js";
import type { QualityReport } from "../../shared/events.js";

const ASSESS_TOOL: FunctionDeclaration = {
  name: "assess_research",
  description: [
    "Score the cumulative response on TWO independent axes:",
    "(1) topic drift — has the response stopped being about what the user asked?",
    "(2) spec adherence — if the prompt provided concrete identifiers (field names,",
    "endpoint paths, HTTP methods, library names, version numbers, domain values,",
    "exact strings, often delimited by backticks or stated as 'must include' /",
    "'use exactly' / 'the domain is'), does the response use those EXACT identifiers?",
    "Inventing new names or contradicting prompt specifics is a strong negative",
    "signal even when the response is on-topic.",
    "You CANNOT verify external truth — only consistency with what the prompt provided inline.",
  ].join(" "),
  parameters: {
    type: SchemaType.OBJECT,
    properties: {
      relevance_score: {
        type: SchemaType.NUMBER,
        description:
          "Layer 1 score, 0.0–1.0. How on-topic is the response relative to the prompt's subject? " +
          "0.0 = completely off-topic, 1.0 = directly on-topic.",
      },
      spec_adherence_score: {
        type: SchemaType.NUMBER,
        description:
          "Layer 2 score, 0.0–1.0. How faithfully does the response follow concrete " +
          "identifiers from the prompt (field names, endpoint paths, HTTP methods, " +
          "library names, version numbers, domain values, exact strings)? " +
          "1.0 = every prompt-specified identifier appears verbatim, OR the prompt was " +
          "generic with no specifics to violate. " +
          "0.0 = the response invents new names or contradicts identifiers the prompt " +
          "explicitly stated. Score this even if relevance_score is high.",
      },
      on_topic: {
        type: SchemaType.BOOLEAN,
        description: "Layer 1: is the latest material still about the prompt's subject?",
      },
      drift_detected: {
        type: SchemaType.BOOLEAN,
        description: "Layer 1: has the response drifted into an unrelated subject area?",
      },
      specifics_violated: {
        type: SchemaType.BOOLEAN,
        description:
          "Layer 2: did the prompt provide concrete identifiers AND the response invent " +
          "new ones or contradict them? false if prompt was generic OR every " +
          "prompt-specified identifier appears in the response unchanged. " +
          "true is a STRONG signal that should pull spec_adherence_score below threshold.",
      },
      citation_plausible: {
        type: SchemaType.BOOLEAN,
        description:
          "Do cited sources look structurally plausible (real-sounding titles, URLs, " +
          "authors)? You CANNOT verify they exist; only whether they look like real citations.",
      },
      reasoning: {
        type: SchemaType.STRING,
        description:
          "One sentence explaining the LOWER of the two scores, naming WHICH axis " +
          "(drift or specifics) flagged the chunk and citing specific evidence " +
          "(word, phrase, identifier mismatch) rather than generalities.",
      },
    },
    required: [
      "relevance_score",
      "spec_adherence_score",
      "on_topic",
      "drift_detected",
      "specifics_violated",
      "citation_plausible",
      "reasoning",
    ],
  },
};

// Gemini 2.5 Flash paid tier pricing as of early 2026 (verify at
// https://ai.google.dev/pricing).
const GEMINI_25_FLASH_INPUT_USD_PER_MTOK = 0.075;
const GEMINI_25_FLASH_OUTPUT_USD_PER_MTOK = 0.30;

function rateFor(modelName: string): { inputPerM: number; outputPerM: number } {
  if (!modelName.includes("flash")) {
    console.warn(
      `[text-monitor] cost estimates assume Gemini 2.5 Flash pricing; ` +
      `you are using "${modelName}" which may be more expensive. Verify at https://ai.google.dev/pricing`,
    );
  }
  return {
    inputPerM: GEMINI_25_FLASH_INPUT_USD_PER_MTOK,
    outputPerM: GEMINI_25_FLASH_OUTPUT_USD_PER_MTOK,
  };
}

const RETRYABLE_HTTP_CODES = [429, 500, 502, 503, 504];

function isRetryable(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  const msg = err.message;
  if (!msg) return false;
  return RETRYABLE_HTTP_CODES.some((code) =>
    msg.includes(`[${code} `) ||
    msg.includes(` ${code} `) ||
    msg.includes(`${code} Service`) ||
    msg.includes(`${code} Too Many`),
  );
}

// Parse "Please retry in 49.3s" hint from 429 body if present.
function parseRetryAfterMs(err: unknown): number | null {
  if (!(err instanceof Error)) return null;
  const m = err.message.match(/retry in (\d+(?:\.\d+)?)s/i);
  if (!m) return null;
  const seconds = Number(m[1]);
  if (!Number.isFinite(seconds)) return null;
  return Math.min(60_000, Math.ceil(seconds * 1000)); // cap at 60s
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

// ---------------------------------------------------------------------------
// Layer 3 — deterministic spec checker
// ---------------------------------------------------------------------------
//
// Pulls backtick-quoted identifiers out of the prompt, then checks how many
// of them appear verbatim in the cumulative response. Returns coverage in
// [0, 1]. This is the cheap, undeniable layer — no LLM judgment, no
// gameability. If you wrote `signTypedData` in the prompt and the model
// emitted `signMessage`, this fires.
//
// Why backticks: that's the typography programmers already use to mark
// "these are the exact tokens that matter." The convention pre-exists; we
// just promote it to a hard contract. Generic prose with no backticks =
// Layer 3 inactive (coverage = 1.0, no penalty).
//
// We deliberately do not try to extract dot.qualified.paths or ALLCAPS
// constants automatically — that path leads to false positives. The user
// declares what matters by putting it in backticks.

const BACKTICK_RE = /`([^`\n]{1,100})`/g;

function extractRequiredIdentifiers(prompt: string): string[] {
  const ids = new Set<string>();
  let m: RegExpExecArray | null;
  BACKTICK_RE.lastIndex = 0;
  while ((m = BACKTICK_RE.exec(prompt)) !== null) {
    const id = m[1].trim();
    if (id.length >= 2) ids.add(id);
  }
  return Array.from(ids);
}

interface CoverageResult {
  required: string[];
  present: string[];
  missing: string[];
  coverage: number; // [0, 1]
}

function checkIdentifierCoverage(text: string, required: string[]): CoverageResult {
  if (required.length === 0) {
    return { required: [], present: [], missing: [], coverage: 1.0 };
  }
  const present: string[] = [];
  const missing: string[] = [];
  for (const id of required) {
    if (text.includes(id)) present.push(id);
    else missing.push(id);
  }
  return {
    required,
    present,
    missing,
    coverage: present.length / required.length,
  };
}

// Layer 3 stays dormant while the response is too short for prompt-specified
// identifiers to reasonably have appeared yet. Roughly aligns with the
// kill-gate's warmup of 2 chunks at ~32 tokens each ≈ ~256 chars.
const MIN_RESPONSE_LEN_FOR_SPEC_CHECK = 200;

export interface CostEstimate {
  callCount: number;
  inputTokens: number;
  outputTokens: number;
  estimatedUsd: number;
  modelName: string;
}

export class TextQualityMonitor implements QualityMonitor {
  readonly name = "gemini-text-judge";
  readonly useCase = "text" as const;

  private readonly model: any;
  private readonly modelName: string;
  private readonly maxAttempts = 5;

  private inputTokens = 0;
  private outputTokens = 0;
  private callCount = 0;

  constructor(apiKey: string, modelName = "gemini-2.5-flash") {
    this.modelName = modelName;
    const genai = new GoogleGenerativeAI(apiKey);
    this.model = genai.getGenerativeModel({
      model: modelName,
      tools: [{ functionDeclarations: [ASSESS_TOOL] }],
      toolConfig: {
        functionCallingConfig: { mode: FunctionCallingMode.ANY },
      },
    });
  }

  getCostEstimate(): CostEstimate {
    const rate = rateFor(this.modelName);
    const estimatedUsd =
      (this.inputTokens / 1_000_000) * rate.inputPerM +
      (this.outputTokens / 1_000_000) * rate.outputPerM;
    return {
      callCount: this.callCount,
      inputTokens: this.inputTokens,
      outputTokens: this.outputTokens,
      estimatedUsd,
      modelName: this.modelName,
    };
  }

  async assess(ctx: QualityContext): Promise<QualityReport> {
    if (ctx.cumulative.kind !== "text") {
      throw new Error(
        `TextQualityMonitor requires cumulative.kind = "text", got "${ctx.cumulative.kind}"`,
      );
    }

    // ----- Layer 3 (deterministic) -------------------------------------
    // Pull backticked tokens out of the prompt; check verbatim presence in
    // the cumulative response. Stays dormant for very short responses so
    // the warmup chunks aren't penalized for not yet having emitted the
    // identifiers.
    const requiredIds = extractRequiredIdentifiers(ctx.prompt);
    const cumText = ctx.cumulative.text;
    const layer3: CoverageResult =
      cumText.length < MIN_RESPONSE_LEN_FOR_SPEC_CHECK
        ? { required: requiredIds, present: [], missing: [], coverage: 1.0 }
        : checkIdentifierCoverage(cumText, requiredIds);

    // ----- Layers 1+2 (Gemini) -----------------------------------------
    const prompt = [
      `User asked: "${ctx.prompt}"`,
      ``,
      `Response so far (${cumText.length} chars):`,
      `-----`,
      cumText,
      `-----`,
      ``,
      `Assess this cumulative response using the assess_research tool.`,
      `Score BOTH relevance_score (Layer 1: topic drift) AND`,
      `spec_adherence_score (Layer 2: did the response use the EXACT identifiers,`,
      `field names, version numbers, library names the prompt specified?).`,
      `If the prompt provided no concrete identifiers, score Layer 2 as 1.0.`,
    ].join("\n");

    let lastErr: unknown = null;
    for (let attempt = 0; attempt < this.maxAttempts; attempt++) {
      if (attempt > 0) {
        // Exponential backoff: 2s, 4s, 8s, 16s, capped at 30s.
        // Override with server-provided "retry in Xs" hint when present.
        const exponential = Math.min(30_000, 2_000 * 2 ** (attempt - 1));
        const hinted = parseRetryAfterMs(lastErr);
        const backoff = hinted ?? exponential;
        console.warn(
          `[text-monitor] retry ${attempt}/${this.maxAttempts - 1} after ${backoff}ms` +
          `${hinted ? " (server-hinted)" : ""}: ` +
          `${lastErr instanceof Error ? lastErr.message.split("\n")[0].slice(0, 180) : lastErr}`,
        );
        await sleep(backoff);
      }

      try {
        const result = await this.model.generateContent(prompt);

        const usage = result.response.usageMetadata;
        if (usage) {
          this.inputTokens += Number(usage.promptTokenCount ?? 0);
          this.outputTokens += Number(usage.candidatesTokenCount ?? 0);
        }
        this.callCount++;

        const fnCalls = result.response.functionCalls?.();
        if (!fnCalls || fnCalls.length === 0) {
          throw new Error(
            `Gemini (${this.modelName}) returned no function call despite mode=ANY. ` +
            `Raw text: "${(result.response.text?.() ?? "[no text]").slice(0, 200)}"`,
          );
        }

        const args = (fnCalls[0].args ?? {}) as Record<string, unknown>;

        const clamp = (n: number, def = 1): number =>
          Math.max(0, Math.min(1, Number.isFinite(n) ? n : def));
        const layer1 = clamp(Number(args.relevance_score ?? 0), 0);
        const layer2 = clamp(Number(args.spec_adherence_score ?? 1), 1);
        const layer3Score = layer3.coverage;

        // Combined score: any layer can pull below threshold.
        const finalScore = Math.min(layer1, layer2, layer3Score);

        // Identify which layer flagged the chunk for the human-readable
        // reasoning surfaced in the dashboard timeline.
        const geminiReasoning = String(args.reasoning ?? "");
        let layeredReasoning: string;
        if (layer3Score < layer1 && layer3Score < layer2) {
          const sample = layer3.missing.slice(0, 3).map((id) => "`" + id + "`").join(", ");
          layeredReasoning =
            `[layer 3 / deterministic] ${layer3.missing.length} of ${layer3.required.length} ` +
            `required identifier(s) missing from response: ${sample}` +
            (layer3.missing.length > 3 ? " …" : "");
        } else if (layer2 < layer1) {
          layeredReasoning = `[layer 2 / spec adherence] ${geminiReasoning}`;
        } else {
          layeredReasoning = `[layer 1 / topic drift] ${geminiReasoning}`;
        }

        return {
          score: finalScore,
          reasoning: layeredReasoning,
          meta: {
            // Layer breakdown
            layer1_topic_score: layer1,
            layer2_spec_score: layer2,
            layer3_coverage: layer3Score,
            // Layer 1+2 details from Gemini
            on_topic: Boolean(args.on_topic),
            drift_detected: Boolean(args.drift_detected),
            specifics_violated: Boolean(args.specifics_violated),
            citation_plausible: Boolean(args.citation_plausible),
            gemini_reasoning: geminiReasoning,
            // Layer 3 details
            required_identifiers: requiredIds,
            present_identifiers: layer3.present,
            missing_identifiers: layer3.missing,
            spec_check_active: cumText.length >= MIN_RESPONSE_LEN_FOR_SPEC_CHECK,
            // Run metadata
            model: this.modelName,
            attempts: attempt + 1,
            input_tokens: usage?.promptTokenCount ?? null,
            output_tokens: usage?.candidatesTokenCount ?? null,
          },
          chunkIndex: ctx.chunkIndex,
          assessedAt: Date.now(),
        };
      } catch (err) {
        lastErr = err;
        if (!isRetryable(err)) {
          throw err;
        }
      }
    }

    throw lastErr instanceof Error
      ? lastErr
      : new Error(`Gemini assess failed after ${this.maxAttempts} attempts: ${String(lastErr)}`);
  }
}
