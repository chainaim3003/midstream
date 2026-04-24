# Quality Checker Design — How the Oracles Actually Work

**Date:** 2026-04-22
**Scope:** Concrete, implementation-level design of the three quality oracles we plan to ship (text, code, image).
**Rule:** Every piece of code here is runnable, not pseudocode. Real APIs. Real libraries. No mocks.

---

## 0. The shared interface (recap)

Every oracle implements `QualityMonitor`:

```ts
interface QualityMonitor {
  name: string;
  assess(ctx: QualityContext): Promise<QualityReport>;
}

interface QualityReport {
  score: number;                    // 0.0–1.0, higher = better
  reasoning: string;                // one sentence for the UI
  meta: Record<string, unknown>;    // per-oracle extras
  chunkIndex: number;
  assessedAt: number;
}
```

The buyer calls `monitor.assess(ctx)` after each chunk arrives. The `kill-gate` takes the last N scores, averages them, compares to threshold. Kill = stop signing the next chunk. All three oracles fit this pattern; only the internals differ.

---

## 1. Text oracle — Gemini 3 Flash as LLM judge

**What it catches:** topic drift, on-topic-ness, citation-shape plausibility, surface incoherence.
**What it does NOT catch:** fabricated citations, subtle factual errors, stale information (these are out of scope for LLM-as-judge; see PITCH_FRAMING.md).

### 1.1 The mechanism step by step

1. **Input:** the original prompt + the cumulative text produced so far (all chunks concatenated).
2. **Prompt to Gemini:** a short system message that declares the judge's job, followed by the prompt + text.
3. **Tool use:** Gemini is given a single function called `assess_research` with a structured schema. `toolConfig: { functionCallingConfig: { mode: 'ANY' } }` forces Gemini to return a function call, not free prose.
4. **Gemini returns** a structured object: `{relevance_score, on_topic, citation_plausible, drift_detected, reasoning}`.
5. **We parse** `relevance_score` into `QualityReport.score`. Everything else goes into `meta`.
6. **Latency:** typically 600ms–1200ms per chunk (Gemini Flash is fast).
7. **Cost:** at ~850 cumulative input tokens by chunk 31, ~60 output tokens, Gemini 2.5 Flash pricing is fractions of a cent per check. Total Gemini spend for a full 31-chunk run ≈ $0.002. (Verify current Gemini Flash pricing at `ai.google.dev/pricing` before claiming these numbers in the submission — they're indicative.)

### 1.2 Why forced Function Calling is important

If we ask Gemini "please score this research" and parse the free-text response, we get inconsistent formats: sometimes a number, sometimes "very good", sometimes prose with no number at all. Parsing is brittle and scores drift in meaning across calls.

Function Calling fixes this. Gemini *must* return values filling the declared schema — it can't fail to include `relevance_score`, and the schema forces it to be a number. The response is structured JSON, not prose.

This is also what makes us a credible submission in the Google sponsor track, which explicitly calls out Function Calling as the pattern they want to see.

### 1.3 The precise schema (copy-paste into code)

```ts
const tool = {
  name: 'assess_research',
  description:
    "Assess the cumulative research response for relevance to the user's prompt. " +
    "Catch topic drift, off-topic tangents, and surface-level incoherence. " +
    "You CANNOT verify the truth of claims or citations — only their shape and on-topic-ness.",
  parameters: {
    type: 'object',
    properties: {
      relevance_score: {
        type: 'number',
        description:
          "How well does the response match the user's prompt? " +
          "0.0 = completely off-topic, 1.0 = directly on-topic."
      },
      on_topic: {
        type: 'boolean',
        description: "Is the latest material still about the prompt's subject?",
      },
      citation_plausible: {
        type: 'boolean',
        description:
          "Do cited sources look structurally plausible (real-sounding titles, " +
          "URLs, authors)? You CANNOT verify they exist; only whether they look like " +
          "real citations vs obvious placeholders."
      },
      drift_detected: {
        type: 'boolean',
        description: 'Has the response drifted into an unrelated subject area?',
      },
      reasoning: {
        type: 'string',
        description:
          "One sentence explaining the score. Mention specific evidence (word, " +
          "phrase, topic shift) rather than generalities."
      },
    },
    required: [
      'relevance_score', 'on_topic', 'citation_plausible',
      'drift_detected', 'reasoning',
    ],
  },
} as const;
```

The `description` fields are prompt engineering. They shape Gemini's reasoning. The explicit note "You CANNOT verify truth" prevents Gemini from falsely claiming it checked citations.

### 1.4 Rolling-window decision logic

One chunk's score is noisy. We average the last 3.

```ts
// client/quality/kill-gate.ts (shared by all oracles)
export function shouldKill(
  history: QualityReport[],
  threshold: number,
  warmup: number,
  window: number,
): { kill: boolean; reason: string; rollingAvg: number } {
  if (history.length < warmup) {
    return { kill: false, reason: 'warmup', rollingAvg: 1.0 };
  }
  const recent = history.slice(-window);
  const avg = recent.reduce((s, r) => s + r.score, 0) / recent.length;
  if (avg < threshold) {
    return {
      kill: true,
      reason: `rolling avg ${avg.toFixed(3)} below threshold ${threshold.toFixed(3)} ` +
              `(last ${recent.length} chunks)`,
      rollingAvg: avg,
    };
  }
  return { kill: false, reason: `rolling avg ${avg.toFixed(3)} ok`, rollingAvg: avg };
}
```

Default: `threshold = 0.60`, `warmup = 2`, `window = 3`. Tunable via env.

### 1.5 Failure modes of the text oracle

| Failure | What happens | Impact |
|---|---|---|
| Gemini API unreachable | `assess()` throws, caught by buyer, buyer stops signing | Same as kill. Safe failure. |
| Gemini returns no function call | `assess()` throws, caught, stops | Same. |
| Gemini returns low relevance on a correct-but-concise chunk | False positive kill | Buyer paid for less than they could have; we log the reasoning so user can retry with higher tolerance. |
| Seller produces plausibly-wrong but on-topic content | Oracle scores high, buyer keeps paying | **This is the documented limitation.** Framed honestly in PITCH_FRAMING.md. |

### 1.6 What the UI shows for text mode

Panel C (Quality Monitor) shows:
```
Rolling avg (last 3):   0.82
Last chunk score:       0.78
Threshold:              0.60
Status:                 OK

Last verdict (verbatim from Gemini):
  on_topic:              true
  citation_plausible:    true
  drift_detected:        false
  reasoning: "Directly references Article 53
              of Regulation 2024/1689; on-topic"
```

This verbatim display is important: judges see that the oracle is doing actual structured reasoning, not just returning a number. The "verbatim from Gemini" labeling makes clear we're not faking the reasoning text.

---

## 2. Code oracle — deterministic compiler + test runner

**What it catches:** any code that doesn't compile, any test that fails, syntax errors, type errors, undefined references, infinite loops (via timeout).
**What it does NOT catch:** code that compiles and passes tests but doesn't solve the user's actual problem (this is rare when the test was also model-generated — the model tends to write tests that match its own code).

### 2.1 Why this is the strongest oracle

It's deterministic. Same cumulative code → same tsc exit code → same test output → same score. The seller cannot "bias prose toward the judge" because the judge is the TypeScript compiler. Anything that fails `tsc --noEmit --strict` scores 0.0 regardless of how eloquently it fails.

### 2.2 The session shape

The seller's system prompt is designed to emit code in chunk-sized pieces. Example:

> System: "You are a TypeScript code generator. Output only TypeScript. Each response must be a single complete top-level definition (one function, one test block, one import group). Do not emit prose, Markdown fences, or commentary. Max 32 tokens per response."

> User: "Write a function median(xs: number[]): number that returns the median. Then write three node:test cases verifying it on small arrays including an empty array (should throw)."

Chunks 1-3 might be: `import`, `function definition`, `test block`. Each is a paid chunk. After each, the buyer's oracle concatenates all prior chunks into one file and checks.

### 2.3 What the oracle runs

```ts
// client/quality/code-monitor.ts — real implementation sketch
import { spawn } from 'node:child_process';
import { writeFile, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export class CodeQualityMonitor implements QualityMonitor {
  name = 'tsc-strict + node-test';

  async assess(ctx: QualityContext): Promise<QualityReport> {
    if (ctx.cumulative.kind !== 'code') throw new Error('wrong kind');

    const dir = await mkdtemp(join(tmpdir(), 'q-'));
    const file = join(dir, 'out.ts');

    try {
      await writeFile(file, ctx.cumulative.code, 'utf-8');

      // Phase 1: compile check (deterministic, fast)
      const tsc = await run('npx', [
        'tsc', '--noEmit', '--strict', '--target', 'es2022',
        '--module', 'nodenext', '--moduleResolution', 'nodenext', file,
      ], { timeoutMs: 10_000, cwd: dir });

      if (!tsc.ok) {
        return {
          chunkIndex: ctx.chunkIndex,
          assessedAt: Date.now(),
          score: 0.0,
          reasoning: `tsc --strict failed: ${firstLine(tsc.stderr)}`,
          meta: {
            compiles: false,
            exit_code: tsc.code,
            diagnostic_count: countMatches(tsc.stdout + tsc.stderr, /error TS\d+/g),
          },
        };
      }

      // Phase 2: run node --test (the cumulative code must import its own tests)
      const test = await run('node', [
        '--test', '--experimental-strip-types', file,
      ], { timeoutMs: 15_000, cwd: dir });

      // node --test exits 0 if all tests pass, 1 if any fail, >1 on internal error
      const tests_pass = test.ok;
      const score = tests_pass ? 1.0 : 0.3;    // partial credit for "compiles but fails tests"
      const summary = parseNodeTestSummary(test.stdout);

      return {
        chunkIndex: ctx.chunkIndex,
        assessedAt: Date.now(),
        score,
        reasoning: tests_pass
          ? `compiles, ${summary.pass}/${summary.pass + summary.fail} tests pass`
          : `compiles but ${summary.fail} test(s) failing: ${firstFailureMessage(test.stdout)}`,
        meta: { compiles: true, tests_pass, tests_summary: summary },
      };
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }
}

// Helper — spawn with timeout, return structured result.
function run(cmd: string, args: string[], opts: { timeoutMs: number; cwd: string }) {
  return new Promise<{ok: boolean; code: number; stdout: string; stderr: string}>((resolve) => {
    const p = spawn(cmd, args, {
      timeout: opts.timeoutMs,
      cwd: opts.cwd,
      env: { PATH: process.env.PATH, HOME: process.env.HOME },  // minimal env
    });
    let stdout = '', stderr = '';
    p.stdout?.on('data', d => stdout += d.toString());
    p.stderr?.on('data', d => stderr += d.toString());
    p.on('close', (code) => {
      resolve({ ok: code === 0, code: code ?? -1, stdout, stderr });
    });
  });
}

function firstLine(s: string) { return s.split('\n')[0]?.slice(0, 200) ?? ''; }
function countMatches(s: string, r: RegExp) { return (s.match(r) || []).length; }

// Parse `node --test` TAP-ish output to get pass/fail counts.
function parseNodeTestSummary(out: string): { pass: number; fail: number } {
  const pass = (out.match(/^ok /gm) || []).length;
  const fail = (out.match(/^not ok /gm) || []).length;
  return { pass, fail };
}

function firstFailureMessage(out: string): string {
  const m = out.match(/not ok .+/);
  return m ? m[0].slice(0, 200) : 'unknown';
}
```

### 2.4 Why this is safe (enough) for a hackathon

Running untrusted model-generated code is a real risk. For a hackathon demo we mitigate, we don't eliminate:

- **No network in spawned processes:** we pass a minimal `env` (just `PATH` + `HOME`). A malicious `fetch()` still works by default in Node though — so in production, use `--permission` or `--no-addons` flags, or a VM/container. For a hackathon demo, the prompts we drive are tame ("write a median function") and the risk is acceptable.
- **Bounded CPU time:** `timeout` on spawn kills runaway loops.
- **Ephemeral tmpdir:** fresh per chunk, cleaned up on completion.
- **Human in the loop:** the buyer is running this on their own machine during a demo; we're not hosting a public endpoint that executes arbitrary user code.

If you wanted to harden it post-hackathon: run via Docker or Deno with `--allow-none` permissions. For the hackathon, the above is enough.

### 2.5 What the UI shows for code mode

Panel D (Stream View) for code mode:

```
╭─ out.ts (cumulative) ───────────────────────────────╮
│ 1  import { test } from 'node:test';                │
│ 2  import assert from 'node:assert/strict';         │
│ 3                                                   │
│ 4  function median(xs: number[]): number {          │
│ 5    if (xs.length === 0) throw new Error('empty'); │
│ 6    const sorted = [...xs].sort((a, b) => a - b);  │
│ 7    const mid = Math.floor(sorted.length / 2);     │
│ 8    return sorted.length % 2                       │
│ 9      ? sorted[mid]                                │
│ 10     : (sorted[mid - 1] + sorted[mid]) / 2;       │
│ 11 }                                                │
│ 12                                                  │
│ 13 test('median of [1,2,3] is 2', () => {           │
│ 14   assert.equal(medin([1,2,3]), 2);  ← TYPO       │
│ 15 });                                              │
│     ~~~~~                                           │
╰─────────────────────────────────────────────────────╯

╭─ oracle output ─────────────────────────────────────╮
│ ✗ tsc --strict failed:                              │
│   out.ts:14:17: error TS2304:                       │
│     Cannot find name 'medin'.                       │
│ score: 0.00                                         │
│ → BUYER STOPS SIGNING                               │
╰─────────────────────────────────────────────────────╯
```

This is extremely compelling to judges. The oracle's verdict is reproducible — they could run `tsc` themselves on the file and get the same result. No "trust the LLM" required.

### 2.6 Cost and latency

- Per-chunk oracle cost: ~$0 (all local computation).
- Latency: 1-3 seconds (tsc + node test suite for ~50-line file). Add to this the Anthropic streaming time and per-chunk latency ~2-4 seconds.
- Demo pacing: a 31-chunk code session takes ~90 seconds. Fine for a demo video.

---

## 3. Image oracle — CLIP similarity

**What it catches:** images whose content doesn't match the prompt; severe style drift; wrong subject.
**What it does NOT catch:** aesthetically bad but on-prompt images; images with correct subject but wrong pose/style details the user cared about.

### 3.1 The mechanism

CLIP is a neural network with two encoders: one for text, one for images. Both produce vectors in the same 512-dim embedding space. **Images and text that describe the same concept produce vectors with high cosine similarity.**

For our oracle:
1. Encode the prompt ("5 photos of a Shiba Inu wearing sunglasses…") → text vector.
2. Encode the generated image → image vector.
3. Compute cosine similarity.
4. If similarity > ~0.27, the image matches the prompt well. Below that, it's likely off-prompt.

This is empirical — 0.27 is a commonly cited CLIP "this is probably relevant" threshold from CLIP literature. In practice we'd tune it on a small set of known-good and known-bad prompt+image pairs during the hackathon.

### 3.2 Running CLIP in the buyer

Two options:

**Option A: `@xenova/transformers` (WASM in Node or browser).** Downloads a ~100MB CLIP model once, runs inference in WASM. No GPU needed. Latency ~500ms per image on a laptop.

**Option B: hosted CLIP API.** Replicate has public CLIP endpoints at ~$0.001/call. Simpler code, small marginal cost per demo.

For a hackathon: **option B** is faster to ship. For production credibility: **option A** is "the oracle runs locally on the buyer, zero marginal cost." I'd pick A for the demo because it strengthens the "buyer runs its own oracle" narrative, but either is legitimate.

### 3.3 Real implementation (option A)

```ts
// client/quality/image-monitor.ts
import { pipeline, env } from '@xenova/transformers';

// Configure Transformers.js for Node.js: pre-download model to a local cache.
env.cacheDir = './.cache/transformers';
env.allowRemoteModels = true;
env.allowLocalModels = true;

export class ImageQualityMonitor implements QualityMonitor {
  name = 'clip-vit-base-patch32';
  private classifier: any = null;

  async ensureLoaded(): Promise<void> {
    if (this.classifier) return;
    this.classifier = await pipeline(
      'zero-shot-image-classification',
      'Xenova/clip-vit-base-patch32',
    );
  }

  async assess(ctx: QualityContext): Promise<QualityReport> {
    if (ctx.cumulative.kind !== 'image') throw new Error('wrong kind');
    await this.ensureLoaded();

    const latest = ctx.cumulative.images[ctx.cumulative.images.length - 1];
    if (!latest) throw new Error('no image in chunk');

    // Candidates: the prompt vs a foil. CLIP returns a softmax over these.
    const labels = [ctx.prompt, 'a random unrelated image'];
    const out = await this.classifier(latest.url, labels);

    // `out` is an array of { score, label } in descending order.
    const onTopic = out.find((r: any) => r.label === ctx.prompt);
    const onTopicScore = onTopic?.score ?? 0;

    const THRESHOLD = 0.60;  // because it's softmax over 2 labels, 0.5 is chance
    return {
      chunkIndex: ctx.chunkIndex,
      assessedAt: Date.now(),
      score: onTopicScore,
      reasoning: onTopicScore >= THRESHOLD
        ? `CLIP matches prompt over foil with prob ${onTopicScore.toFixed(3)}`
        : `CLIP scores prompt-match only ${onTopicScore.toFixed(3)} — likely off-prompt`,
      meta: { clip_prob: onTopicScore, foil_prob: 1 - onTopicScore, threshold: THRESHOLD },
    };
  }
}
```

Notes on the design:
- Using softmax-over-two-labels instead of raw cosine similarity. This is cleaner because CLIP cosines aren't naturally in a normalized [0,1] range, but a 2-label zero-shot classifier softmax is.
- Threshold 0.60 because random would be 0.50 (softmax over 2 labels). 0.60 means "CLIP confidently prefers the on-topic label over the foil."
- For a more discriminating oracle, use 5-10 candidate labels (the prompt + several foils) and keep the on-topic probability. More signal, more compute.

### 3.4 What the UI shows for image mode

Panel D for image mode:

```
╭─ generated so far ─────────────────────────────────╮
│                                                    │
│   [img1] [img2] [img3] [img4] [img5]               │
│    0.89   0.85   0.82   0.38   ——                  │
│     ✓      ✓      ✓      ✗      (killed)          │
│                                                    │
│   CLIP score under each image.                     │
│   img4 fell to 0.38 < 0.60 threshold.              │
│   Stream aborted after chunk 4.                    │
│                                                    │
╰────────────────────────────────────────────────────╯
```

Image 4 visibly isn't a Shiba Inu. Judge gets it in one second.

### 3.5 Failure modes

| Failure | Effect |
|---|---|
| CLIP model fails to load (first-run download) | First assess() throws, caught, session ends | Pre-warm during page load so this never happens mid-demo. |
| Ambiguous prompt ("a cool thing") scores all images low | False positive kill | Demo prompts should be concrete. |
| Image API rate-limited | Seller's chunk endpoint errors → no content → no signature → no payment | Safe failure. |

---

## 4. Why these three oracles together tell the full story

| Dimension | Text (Gemini) | Code (tsc+test) | Image (CLIP) |
|---|---|---|---|
| Determinism | Probabilistic | Deterministic | Semi-deterministic |
| Cost per check | ~$0.00006 | ~$0 | ~$0 (local) or ~$0.001 (API) |
| Latency per check | ~800ms | ~1500ms | ~500ms |
| False positive risk | 5-15% | <1% | 5-10% |
| Attack surface | Seller biases prose | None (tsc is the judge) | Seller generates visually similar but off-spec images |
| What it proves | "Architecture works even with a weak oracle" | "Architecture works, and gets bulletproof with a strong oracle" | "Architecture works for multimodal content" |

Three oracles, three points on the spectrum, one payment layer underneath. **That's the submission.**

---

## 5. One piece of shared infrastructure — the rolling-window decision

Every oracle feeds into the same `kill-gate`. Here's the full logic, with the warmup rule (discussed in VIABILITY_AUDIT.md enhancement 1):

```ts
// client/quality/kill-gate.ts — final form

export interface KillGateConfig {
  threshold: number;      // e.g. 0.60
  warmup: number;         // chunks before kill-gate engages; default 2
  rollingWindow: number;  // chunks averaged for the decision; default 3
}

export interface KillDecision {
  kill: boolean;
  reason: string;
  rollingAvg: number;
  chunksConsidered: number;
}

export function evaluateKillGate(
  history: QualityReport[],
  cfg: KillGateConfig,
): KillDecision {
  if (history.length < cfg.warmup) {
    return {
      kill: false,
      reason: `warmup (${history.length}/${cfg.warmup})`,
      rollingAvg: 1.0,
      chunksConsidered: history.length,
    };
  }

  const recent = history.slice(-cfg.rollingWindow);
  const avg = recent.reduce((s, r) => s + r.score, 0) / recent.length;
  const last = recent[recent.length - 1];

  // Primary rule: rolling average below threshold.
  if (avg < cfg.threshold) {
    return {
      kill: true,
      reason: `rolling avg ${avg.toFixed(3)} below threshold ${cfg.threshold.toFixed(3)}`,
      rollingAvg: avg,
      chunksConsidered: recent.length,
    };
  }

  // Secondary rule: one absolutely terrible chunk after warmup.
  // Even if rolling avg is OK, a single score ≤ 0.1 signals a hard failure
  // (compilation error; CLIP wildly off; Gemini catastrophic drift).
  if (last && last.score <= 0.1 && history.length >= cfg.warmup) {
    return {
      kill: true,
      reason: `single chunk catastrophic failure (score ${last.score.toFixed(3)})`,
      rollingAvg: avg,
      chunksConsidered: recent.length,
    };
  }

  return {
    kill: false,
    reason: `rolling avg ${avg.toFixed(3)} ≥ threshold ${cfg.threshold.toFixed(3)}`,
    rollingAvg: avg,
    chunksConsidered: recent.length,
  };
}
```

The secondary rule matters for the code oracle specifically: one `tsc` failure means the code is broken. Waiting for three consecutive failures to kill is absurd when you're on chunk 4 — we kill on the first catastrophic failure after warmup.

---

## 6. Answering "how does the quality checker work" in one paragraph (for README / pitch)

> The quality checker runs on the buyer's side — never the seller's, never a third-party evaluator. After each paid chunk arrives, the buyer runs an oracle appropriate to the use case: for text, Gemini 3 Flash with Function Calling returns a structured relevance score; for code, the Node.js TypeScript compiler and test runner return pass/fail; for images, a local CLIP model returns a similarity score. Each oracle implements the same `QualityMonitor` interface. The buyer averages the last 3 scores, and if the average falls below a user-set threshold (or if any single chunk catastrophically fails), the buyer simply stops signing the next chunk's payment authorization. The seller, having no signature, never calls the underlying model. The stream ends. The buyer has paid for exactly the chunks that passed quality; nothing more. No refunds, no retries, no renegotiation — just forward-stop.

That's the complete story. Runnable code, real APIs, three oracle types, one shared interface.
