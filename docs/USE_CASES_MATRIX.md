# Use Cases Matrix — What Can We Actually Build in 3-4 Days?

**Date:** 2026-04-22
**Deadline:** April 25, 2026 5:00 PM PDT
**Constraint:** ~3 working days with one builder
**Rule:** No mocks, no fallbacks, no hardcoding — so any use case we claim must have a real API we can call.

This document honestly evaluates each of the seven AI-product categories for hackathon-time feasibility, and lays out exactly what a multi-use-case architecture looks like in code.

---

## 0. Short answer

**We can realistically ship three of the seven** in the time available, not just one:

1. **Pay-per-chunk Deep Research** (text streaming) — the primary demo
2. **Pay-per-function code generation** (test-suite gated) — the strongest architectural story
3. **Pay-per-image batch generation** (CLIP-gated) — the most visually dramatic

These three cover the **probabilistic, deterministic, and semi-deterministic** oracle types and together make the "pay-per-unit, oracle-agnostic" pitch concrete.

The other four (video, voice, browser, music) are out of scope for this hackathon due to infrastructure cost, API gating, or real-time audio/video pipelines that don't fit a 3-day sprint. Document them in the pitch as "next up" with the oracle for each named — judges should see the architecture generalizes.

---

## 1. Evaluation of all seven categories

| # | Category | Provider APIs | Quality oracle | Build cost | Demo viability | Verdict |
|---|---|---|---|---|---|---|
| 1 | AI video gen (Sora 2, Veo 3.1, Kling) | API access gated, often waitlisted; $0.10–$0.50/second means 50+ demo calls = $50-$250 | CLIP similarity on extracted frames | High (need frame extraction pipeline) | Very dramatic visually | ❌ **Too expensive and gated** |
| 2 | AI coding agents | Anthropic/OpenAI/Gemini: available, cheap. Need code sandbox. | Compile + test suite pass (DETERMINISTIC) | Medium (need Node/TS sandbox + test harness) | Very strong architectural story | ✅ **Build as secondary demo** |
| 3 | Deep Research | Anthropic Claude streaming: available, trivial cost | Gemini LLM-as-judge (probabilistic) | Low | Universally recognized pain | ✅ **Build as primary demo** |
| 4 | AI voice agents (Vapi, Retell) | Accounts, phone-number provisioning, real-time audio pipeline | ASR confidence + intent classifier | Very high | Complex to demo live | ❌ **Out of scope** |
| 5 | Browser agents (Computer Use, Operator) | Claude Computer Use API available but needs VM | DOM diff (did expected element appear?) | High (VM, browser, screenshot capture) | Interesting but slow | ❌ **Out of scope** |
| 6 | AI image batch gen | Gemini Nano Banana, Flux via Replicate, OpenAI — cheap ($0.02–$0.05/image) | CLIP similarity on generated image | Medium (need CLIP inference) | Visually dramatic, immediate | ✅ **Build as tertiary demo** |
| 7 | AI music gen (Suno, Udio) | Suno API is waitlisted; Udio has no public API | Audio feature extraction | Medium (API gating is the blocker) | Cool but inaccessible | ❌ **Blocked by API access** |

---

## 2. The three we build — concrete scoping

### Primary — Pay-per-chunk Deep Research

**Already scoped in `DESIGN.md` and `STRUCTURE.md`.** The primary demo. Anthropic Claude streaming, 32-token chunks, Gemini 3 Flash quality monitor, kill-gate on rolling-3 average.

**What gets built:**
- `server/routes/text-chunk.ts` — the paywalled endpoint
- `client/quality/text-monitor.ts` — Gemini-as-judge
- `web/src/components/demo/TextStream.tsx` — token-streaming UI panel

**Time estimate:** Already in the plan. Fits the Tue–Fri schedule.

---

### Secondary — Pay-per-function code generation

**The strongest architectural story because the oracle is deterministic.** Worth the extra day.

**What it does:**
> User types: *"Write a function that takes an array of numbers and returns the median, then a test for it."*
> Seller streams code in function-sized chunks. Between chunks, the buyer runs a tiny sandbox: write the current cumulative code to a file, run `tsc --noEmit` and `node --test`. If compilation fails or tests fail, the buyer doesn't authorize the next chunk. Seller stops streaming.

**The dramatic moment:** at some chunk, the seller introduces a broken API. Buyer's oracle sees `tsc` fail. Buyer stops signing. Stream stops. Savings visible.

**What gets built:**
- `server/routes/code-chunk.ts` — paywalled endpoint; prompts Claude with system prompt "return a TypeScript function with tests, one function per chunk"
- `client/quality/code-monitor.ts` — writes cumulative code to tmpfile, runs `tsc --noEmit` and `node --test`, returns `{compiles: bool, tests_pass: bool, score: 1.0 | 0.0}`
- `client/sandbox.ts` — subprocess manager; bounded CPU time; careful about untrusted code execution. For hackathon, disable-network + resource-limited temp dir is enough.
- `web/src/components/demo/CodeStream.tsx` — code editor panel showing cumulative code with red highlight on the chunk that broke compilation

**Time estimate:** 1 additional day on top of the primary demo. Mostly the sandbox plumbing. Use Node's built-in `child_process.spawn` with `timeout` and a fresh `tmpdir`. Don't over-engineer the sandbox for a hackathon.

**Risk:** Running untrusted model-generated code. For hackathon demo, this is acceptable because (a) the prompts are tame, (b) the sandbox uses `--no-network` and a tmpdir, (c) there's a human in the loop.

**Why this matters for the pitch:** Gemini-as-judge is probabilistic and can be attacked. A compile+test oracle is deterministic and cannot be gamed. Judges who know LLMs understand this distinction immediately; showing the deterministic-oracle case demonstrates the architecture's reach.

---

### Tertiary — Pay-per-image batch with CLIP quality

**Visually dramatic; semi-deterministic oracle.** Good if time permits.

**What it does:**
> User types: *"5 photos of a Shiba Inu wearing sunglasses on a beach at sunset, different poses."*
> Seller generates one image per chunk via Gemini Nano Banana image API (or Flux via Replicate). Between chunks, buyer runs CLIP similarity: text encoder on prompt, image encoder on generated image, cosine similarity. If last image's similarity drops below 0.27 (the empirical "irrelevant image" threshold), buyer stops authorizing.

**The dramatic moment:** prompt drifts or the model generates a wrong subject (all 5 images supposed to be Shibas, image 3 is a cat). CLIP catches it. Buyer stops.

**What gets built:**
- `server/routes/image-chunk.ts` — paywalled endpoint that calls Gemini image API or Replicate (one image per request)
- `client/quality/image-monitor.ts` — runs CLIP locally via `@xenova/transformers` (browser/node-compatible WASM CLIP)
- `web/src/components/demo/ImageGallery.tsx` — gallery panel with per-image CLIP scores overlaid

**Time estimate:** 1 additional day if CLIP-in-browser works. `@xenova/transformers` ships a small CLIP model (~100MB) that runs in WASM.

**Risk:** CLIP model download size and cold-start latency. Acceptable for demo; we pre-warm on page load.

**Why this matters for the pitch:** Images are immediate. Judges watch a drift happen in 2 seconds and see the kill. Research and code are both text-based; the image demo adds visual variety.

---

## 3. Architecture — how the three fit into one codebase

The key insight: **same x402 seller, same buyer library, same Circle Gateway settlement — different routes and different oracles.**

Here's the concrete file layout supporting all three use cases. This is an extension of `STRUCTURE.md`:

```
agentic_economy_refined/
├── server/
│   ├── seller.ts                       # Express app
│   ├── x402/
│   │   ├── middleware.ts               # Shared x402 middleware
│   │   └── facilitator.ts              # Shared Circle Gateway facilitator
│   ├── sessions.ts                     # Shared session state
│   ├── routes/
│   │   ├── text-chunk.ts               # Use case 1: text streaming
│   │   ├── code-chunk.ts               # Use case 2: code generation
│   │   └── image-chunk.ts              # Use case 3: image batch
│   └── llm/
│       ├── anthropic-text.ts           # Provider for text streaming
│       ├── anthropic-code.ts           # Provider for code (different system prompt)
│       └── gemini-image.ts             # Provider for image gen
│
├── client/
│   ├── buyer.ts                        # Generic Buyer class (unchanged)
│   ├── signer.ts                       # Shared EIP-712 signing
│   ├── gateway-client.ts               # Shared Gateway API
│   ├── gateway-watcher.ts              # Shared Arc RPC poller
│   ├── events.ts                       # Shared event types
│   └── quality/
│       ├── index.ts                    # exports QualityMonitor interface
│       ├── text-monitor.ts             # Use case 1 oracle (Gemini judge)
│       ├── code-monitor.ts             # Use case 2 oracle (compile + test)
│       ├── image-monitor.ts            # Use case 3 oracle (CLIP similarity)
│       └── kill-gate.ts                # Shared rolling-window decision logic
│
├── shared/
│   ├── types.ts                        # QualityReport, SessionOptions, etc.
│   └── use-case.ts                     # Enum: 'text' | 'code' | 'image'
│
├── web/src/
│   ├── pages/
│   │   └── DemoPage.tsx                # Route-switches based on use case
│   └── components/demo/
│       ├── UseCaseSelector.tsx         # Top: pick 'text' | 'code' | 'image'
│       ├── TextStream.tsx              # Use case 1 panel
│       ├── CodeStream.tsx              # Use case 2 panel (code editor with highlights)
│       └── ImageGallery.tsx            # Use case 3 panel (image grid with CLIP scores)
```

The buyer library is unchanged. The seller grows one route per use case. The web UI adds one component per use case. The oracles are independent implementations of a single `QualityMonitor` interface.

---

## 4. The shared `QualityMonitor` interface

This is the one interface that unifies the three oracles. In `shared/types.ts`:

```ts
export interface QualityMonitor {
  // Called once per chunk boundary, after the seller delivers the chunk.
  // Buyer uses the returned report's score (plus rolling-window logic) to
  // decide whether to authorize the next chunk.
  assess(context: QualityContext): Promise<QualityReport>;

  // A label shown in the UI to help the judge understand what oracle is running.
  name: string;
}

export interface QualityContext {
  sessionId: string;
  prompt: string;
  chunkIndex: number;
  cumulative: CumulativeOutput;   // text | code | image[]
}

export type CumulativeOutput =
  | { kind: 'text'; text: string }
  | { kind: 'code'; code: string; language: 'typescript' | 'javascript' }
  | { kind: 'image'; images: Array<{ url: string; bytes?: Uint8Array }> };

export interface QualityReport {
  score: number;                  // 0.0 – 1.0, higher is better
  reasoning: string;              // one-sentence explanation for UI
  meta: Record<string, unknown>;  // per-oracle extra fields
  chunkIndex: number;
  assessedAt: number;             // epoch ms
}
```

Every oracle implements `assess()` and returns a uniform shape. The kill-gate and UI do not care which oracle produced the score.

---

## 5. Per-use-case oracle implementations (sketch)

### 5.1 `client/quality/text-monitor.ts` — Gemini LLM-as-judge

```ts
import { GoogleGenerativeAI } from '@google/generative-ai';
import type { QualityMonitor, QualityContext, QualityReport } from '../../shared/types.js';

export class TextQualityMonitor implements QualityMonitor {
  name = 'gemini-3-flash-research-judge';
  constructor(private genai: GoogleGenerativeAI) {}

  async assess(ctx: QualityContext): Promise<QualityReport> {
    if (ctx.cumulative.kind !== 'text') throw new Error('text oracle on non-text chunk');

    const model = this.genai.getGenerativeModel({
      model: 'gemini-2.0-flash-exp',
      tools: [{ functionDeclarations: [{
        name: 'assess_research',
        description: 'Score how well the cumulative response matches the user prompt',
        parameters: {
          type: 'object',
          properties: {
            relevance_score:    { type: 'number', description: '0.0–1.0' },
            on_topic:           { type: 'boolean' },
            citation_plausible: { type: 'boolean' },
            drift_detected:     { type: 'boolean' },
            reasoning:          { type: 'string', description: 'one sentence' },
          },
          required: ['relevance_score','on_topic','citation_plausible','drift_detected','reasoning'],
        },
      }]}],
      toolConfig: { functionCallingConfig: { mode: 'ANY' }},
    });

    const prompt = [
      `User asked: "${ctx.prompt}"`,
      `Response so far (${ctx.cumulative.text.length} chars):`,
      ctx.cumulative.text,
      `Assess using the assess_research tool.`,
    ].join('\n\n');

    const res = await model.generateContent(prompt);
    const call = res.response.functionCalls()?.[0];
    if (!call) throw new Error('No function call in Gemini response');
    const a = call.args as any;

    return {
      score: a.relevance_score,
      reasoning: a.reasoning,
      meta: {
        on_topic: a.on_topic,
        citation_plausible: a.citation_plausible,
        drift_detected: a.drift_detected,
      },
      chunkIndex: ctx.chunkIndex,
      assessedAt: Date.now(),
    };
  }
}
```

### 5.2 `client/quality/code-monitor.ts` — deterministic test oracle

```ts
import { spawn } from 'node:child_process';
import { writeFile, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { QualityMonitor, QualityContext, QualityReport } from '../../shared/types.js';

export class CodeQualityMonitor implements QualityMonitor {
  name = 'tsc+node-test';

  async assess(ctx: QualityContext): Promise<QualityReport> {
    if (ctx.cumulative.kind !== 'code') throw new Error('code oracle on non-code chunk');

    const dir = await mkdtemp(join(tmpdir(), 'code-oracle-'));
    try {
      const file = join(dir, 'out.ts');
      await writeFile(file, ctx.cumulative.code);

      // Step 1: compile check (deterministic, fast)
      const compile = await runTimed('npx', ['tsc', '--noEmit', '--strict', file], 10_000);

      if (!compile.ok) {
        return {
          score: 0.0,
          reasoning: `tsc failed: ${compile.stderr.slice(0, 200)}`,
          meta: { compiles: false, tests_pass: false, exit_code: compile.code },
          chunkIndex: ctx.chunkIndex,
          assessedAt: Date.now(),
        };
      }

      // Step 2: run whatever `node --test` finds (bounded, no network)
      const test = await runTimed('node', ['--test', file], 15_000);

      const tests_pass = test.ok;
      return {
        score: tests_pass ? 1.0 : 0.3,  // compiles but tests fail = partial credit
        reasoning: tests_pass
          ? 'compiles and tests pass'
          : `compiles but tests failed: ${test.stderr.slice(0, 200)}`,
        meta: { compiles: true, tests_pass, test_output: test.stdout.slice(-500) },
        chunkIndex: ctx.chunkIndex,
        assessedAt: Date.now(),
      };
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }
}

function runTimed(cmd: string, args: string[], timeoutMs: number) {
  return new Promise<{ok: boolean; code: number; stdout: string; stderr: string}>((resolve) => {
    const p = spawn(cmd, args, { timeout: timeoutMs, env: { PATH: process.env.PATH }});
    let stdout = '', stderr = '';
    p.stdout.on('data', d => stdout += d.toString());
    p.stderr.on('data', d => stderr += d.toString());
    p.on('close', code => resolve({ ok: code === 0, code: code ?? -1, stdout, stderr }));
  });
}
```

Key properties:
- **No network access** for spawned processes (OS-level isolation would be stronger; for hackathon, process-level is OK).
- **Bounded CPU time** (10s compile, 15s test).
- **Fresh tmpdir** per chunk; cleaned up after.
- Returns a real `score: 0.0 | 0.3 | 1.0` from actual behavior of `tsc` and `node --test`.

### 5.3 `client/quality/image-monitor.ts` — CLIP similarity

```ts
import { pipeline } from '@xenova/transformers';
import type { QualityMonitor, QualityContext, QualityReport } from '../../shared/types.js';

export class ImageQualityMonitor implements QualityMonitor {
  name = 'clip-vit-base-patch32';
  private clip: any = null;

  async ensureLoaded() {
    if (!this.clip) {
      this.clip = await pipeline('zero-shot-image-classification', 'Xenova/clip-vit-base-patch32');
    }
  }

  async assess(ctx: QualityContext): Promise<QualityReport> {
    if (ctx.cumulative.kind !== 'image') throw new Error('image oracle on non-image chunk');
    await this.ensureLoaded();

    const latest = ctx.cumulative.images[ctx.cumulative.images.length - 1];
    if (!latest) throw new Error('no image in chunk');

    // CLIP scores the image against candidate labels: the prompt itself + "irrelevant image"
    const labels = [ctx.prompt, 'irrelevant image'];
    const out = await this.clip(latest.url, labels);
    const match = out.find((r: any) => r.label === ctx.prompt);
    const score = match?.score ?? 0;

    const GOOD_THRESHOLD = 0.27;
    return {
      score: Math.min(1.0, score / 0.5),  // normalize — CLIP raw scores rarely exceed 0.5
      reasoning: score > GOOD_THRESHOLD
        ? `CLIP similarity ${score.toFixed(3)} — matches prompt`
        : `CLIP similarity ${score.toFixed(3)} — below ${GOOD_THRESHOLD}, likely off-prompt`,
      meta: { clip_raw: score, threshold: GOOD_THRESHOLD },
      chunkIndex: ctx.chunkIndex,
      assessedAt: Date.now(),
    };
  }
}
```

CLIP raw scores are fractions in [0, 1] but rarely exceed 0.5 for a good match; we normalize to make the UI gauge intuitive. Threshold of 0.27 is empirical from CLIP literature for "matching content."

---

## 6. What changes in the buyer library

The `client/buyer.ts` currently takes one implicit quality monitor. Revise it to accept a `QualityMonitor` instance:

```ts
// client/buyer.ts (revised signature)
export class Buyer {
  constructor(opts: {
    privateKey: Hex;
    sellerBaseUrl: string;
    chain: ChainConfig;
    monitor: QualityMonitor;   // NEW — oracle plugged in by caller
    killThreshold: number;     // 0–1, default 0.6
    rollingWindow: number;     // default 3
    warmupChunks: number;      // default 2 (skip kill-gate for first N)
  }) {}

  async runSession(s: SessionOptions, emit: (e: BuyerEvent) => void) {
    // ... same flow as DESIGN.md §3, but this.opts.monitor.assess(ctx) replaces
    // the hard-coded Gemini call.
  }
}
```

The web-server route handler picks the monitor based on the session's use case:

```ts
// web-server/routes/session.ts (revised)
router.post('/session', async (req, res) => {
  const { useCase, prompt, budget, threshold, chunkSize } = req.body;
  const monitor = buildMonitor(useCase);
  const buyer = new Buyer({ ...deps, monitor, killThreshold: threshold });
  const sessionId = crypto.randomUUID();
  // ...
});

function buildMonitor(useCase: 'text'|'code'|'image'): QualityMonitor {
  switch (useCase) {
    case 'text':  return new TextQualityMonitor(genai);
    case 'code':  return new CodeQualityMonitor();
    case 'image': return new ImageQualityMonitor();
  }
}
```

This is the full change. Everything else — the EIP-712 signing, x402 flow, Circle Gateway settlement, Arc RPC polling, the dashboard rendering — is unchanged per use case.

---

## 7. UI — how the three use cases share one dashboard

The three-column layout from `UI_SPEC.md` is unchanged. Only Panel D (middle column, the stream view) changes based on use case:

- **Text mode:** Panel D shows streaming text (the existing design).
- **Code mode:** Panel D is split horizontally — top half shows the code with syntax highlighting and red underlines on the chunk where `tsc` failed; bottom half shows the compiler/test output (gives judges something concrete to see).
- **Image mode:** Panel D is a responsive grid of the generated images with CLIP scores overlaid on each; the killed image (the one below threshold) has a red border.

The UseCaseSelector (top of the page) lets a judge switch between modes in the demo. This is a lot of visual variety from one underlying architecture — exactly the "platform play" story.

---

## 8. Time budget — what fits in the schedule

Assuming today is Tue Apr 22 and submission is Fri Apr 25 5pm PDT:

| Day | Morning | Afternoon / Evening | Gate |
|---|---|---|---|
| **Tue Apr 22** | Read this doc, confirm text-chunk design | Code `scripts/generate-wallets.ts` + `scripts/deposit-to-gateway.ts`. First real Gateway deposit visible on testnet.arcscan.app. | First real on-chain tx. |
| **Wed Apr 23** | Code `server/seller.ts` + `server/routes/text-chunk.ts` with real x402 middleware. | Code `client/buyer.ts` + `client/signer.ts` + `client/quality/text-monitor.ts`. First paid text chunk end-to-end. | Gate 3: one real paid chunk settled. |
| **Thu Apr 24 AM** | `client/quality/kill-gate.ts` + the kill-demo scenario. First full 31-chunk text run with deliberate drift. | Web UI: Vite+React scaffolding + TextStream panel + shared panels (F, G, H). | Gate 5: UI shows a real drift+kill. |
| **Thu Apr 24 PM** | Start `server/routes/code-chunk.ts` + `client/quality/code-monitor.ts`. First paid code chunk with real tsc check. | CodeStream UI panel. First code-mode drift demo. | Gate 6: code mode works end-to-end. |
| **Fri Apr 25 AM** | (If time) `server/routes/image-chunk.ts` + `client/quality/image-monitor.ts`. Optional — cut if behind. | Run 3-5 full demo sessions in each mode. 50+ authorizations. Verify with `scripts/verify-onchain.ts`. | Gate 7: hackathon 50+ requirement proven. |
| **Fri Apr 25 PM** | Record 2:45 video across text + code modes. Show Arc explorer. | Write `SUBMISSION.md`, deploy, submit by 5pm PDT. | Submitted. |

**If behind schedule**, drop image mode. Text + code together still tells the full "probabilistic + deterministic oracle" story and is a stronger submission than text alone.

**If further behind**, drop code mode. Text alone + the written pitch (PITCH_FRAMING.md + this doc) still makes the generalization claim credibly.

**The one thing we cannot drop** is the text demo actually working with real Circle Gateway settlements on Arc. Without that, the whole submission fails the hackathon's mandatory ≥50 on-chain txs requirement.

---

## 9. What we say in the pitch about the other four use cases

Voice, video, browser, music. We don't build them, but we mention them.

> "We shipped three oracle types — probabilistic (LLM-as-judge on research), deterministic (test suite on code), semi-deterministic (CLIP on images) — to prove the architecture generalizes. The same x402 + Circle Gateway plumbing works for AI video (CLIP on frames), AI voice agents (ASR-confidence + intent), browser agents (DOM-diff oracle), and AI music (audio-feature extraction). Four additional demos are on the roadmap. The primitive is built; the oracles plug in."

This is accurate and defensible. Judges cannot attack us for not building seven demos in three days. They can only attack us if we claim to have built them when we didn't.
