// shared/types.ts
//
// Cross-package types the client, server, and web-server all need.
//
// Two things live here:
//   1. QualityMonitor + QualityContext — the pluggable oracle interface.
//      Every use case (text, code, image) implements this. The buyer library
//      takes any QualityMonitor; it does not know or care which oracle runs.
//
//   2. SessionOptions + SessionResult — what a session is parameterised by
//      and what comes out.
//
// For the event schema, see events.ts. For per-oracle implementations, see
// client/quality/*.ts.

import type { QualityReport, UseCase } from "./events.js";

// ---------------------------------------------------------------------------
// Cumulative output — what the oracle sees so far
// ---------------------------------------------------------------------------
//
// Different use cases accumulate different things. The oracle branches on
// `kind` to decide how to interpret the input.

export type CumulativeOutput =
  | { kind: "text"; text: string }
  | { kind: "code"; code: string; language: "typescript" | "javascript" }
  | { kind: "image"; images: Array<{ url: string; bytes?: Uint8Array }> };

export interface QualityContext {
  sessionId: string;
  prompt: string;
  chunkIndex: number;
  cumulative: CumulativeOutput;
}

// ---------------------------------------------------------------------------
// The pluggable oracle interface
// ---------------------------------------------------------------------------
//
// Every oracle — Gemini text judge, tsc+test code judge, CLIP image judge —
// implements this. The buyer library calls `assess()` after each chunk and
// feeds the result into the kill-gate.

export interface QualityMonitor {
  /** Short stable id used in logs/UI (e.g. "gemini-2.5-flash-text"). */
  readonly name: string;

  /** Which use case this oracle handles. */
  readonly useCase: UseCase;

  /** Score the cumulative output against the original prompt. */
  assess(ctx: QualityContext): Promise<QualityReport>;
}

// ---------------------------------------------------------------------------
// Session parameterisation + result
// ---------------------------------------------------------------------------

export interface SessionOptions {
  useCase: UseCase;
  prompt: string;
  /** Per-chunk price, in USDC (e.g. 0.0005 = half a tenth of a cent). */
  chunkPriceUsdc: number;
  /** Max tokens per chunk — passed to the seller as max_tokens. */
  chunkSizeTokens: number;
  /** Total tokens the session will try to produce before natural stop. */
  maxTokens: number;
  /** Hard ceiling on this session's spend. Buyer stops if budget exceeded. */
  budgetUsdc: number;
  /** Rolling-avg threshold. Below this, buyer stops signing. */
  qualityThreshold: number;
  /** How many recent chunks the rolling average covers. */
  rollingWindow: number;
  /** How many chunks the kill-gate ignores before engaging. */
  warmupChunks: number;
  /** URL of the seller (Express). */
  sellerBaseUrl: string;
}

export interface SessionResult {
  sessionId: string;
  outcome: "completed" | "killed" | "budget" | "error";
  chunksCompleted: number;
  tokensReceived: number;
  spentUsdc: number;
  wouldHaveSpentUsdc: number;
  elapsedMs: number;
  killReason?: string;
  errorMessage?: string;
  /** Full text/code output concatenated across chunks (for text, code). */
  output: string;
  /** Settled Gateway transaction ids seen during the session. */
  transactions: string[];
}
