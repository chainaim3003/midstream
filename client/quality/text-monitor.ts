// client/quality/text-monitor.ts
//
// Gemini 2.5 Flash judge for text (deep-research) use case.
//
// Uses Function Calling to force a structured response. Without forced mode,
// the model sometimes returns prose and our parser breaks. With mode: "ANY",
// every response is a function call with the declared schema.
//
// What this catches: topic drift, obvious off-topic tangents, missing the
// user's specific angle, surface incoherence, citation-SHAPE plausibility
// (does the citation look real?).
//
// What this does NOT catch: whether cited sources actually exist, subtle
// factual errors, stale information. See docs/PITCH_FRAMING.md §0.
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
    "Assess the cumulative research response for relevance to the user's prompt.",
    "Catch topic drift, off-topic tangents, and surface-level incoherence.",
    "You CANNOT verify the truth of claims or the existence of cited sources —",
    "only whether they look structurally plausible vs. obvious placeholders.",
  ].join(" "),
  parameters: {
    type: SchemaType.OBJECT,
    properties: {
      relevance_score: {
        type: SchemaType.NUMBER,
        description:
          "How well does the response match the user's prompt? " +
          "0.0 = completely off-topic, 1.0 = directly on-topic.",
      },
      on_topic: {
        type: SchemaType.BOOLEAN,
        description: "Is the latest material still about the prompt's subject?",
      },
      citation_plausible: {
        type: SchemaType.BOOLEAN,
        description:
          "Do cited sources look structurally plausible " +
          "(real-sounding titles, URLs, authors)? " +
          "You CANNOT verify they exist; only whether they look like real citations.",
      },
      drift_detected: {
        type: SchemaType.BOOLEAN,
        description: "Has the response drifted into an unrelated subject area?",
      },
      reasoning: {
        type: SchemaType.STRING,
        description:
          "One sentence explaining the score, mentioning specific evidence " +
          "(word, phrase, topic shift) rather than generalities.",
      },
    },
    required: [
      "relevance_score",
      "on_topic",
      "citation_plausible",
      "drift_detected",
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

    const prompt = [
      `User asked: "${ctx.prompt}"`,
      ``,
      `Response so far (${ctx.cumulative.text.length} chars):`,
      `-----`,
      ctx.cumulative.text,
      `-----`,
      ``,
      `Assess this cumulative response using the assess_research tool.`,
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
        const rawScore = Number(args.relevance_score ?? 0);
        const score = Math.max(0, Math.min(1, Number.isFinite(rawScore) ? rawScore : 0));

        return {
          score,
          reasoning: String(args.reasoning ?? ""),
          meta: {
            on_topic: Boolean(args.on_topic),
            citation_plausible: Boolean(args.citation_plausible),
            drift_detected: Boolean(args.drift_detected),
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
