// shared/events.ts
//
// Typed event schema for a single streaming session.
//
// Events are what the buyer library emits as it runs one session. They are
// consumed by:
//   (a) the web-server, which relays them to browser SSE subscribers, and
//   (b) scripts/run-demo.ts, which logs them to disk for later verification.
//
// All events carry a sessionId + ts. They are ordered per-session; global
// ordering across sessions is not guaranteed.

export type UseCase = "text" | "code" | "image";

// ---------------------------------------------------------------------------
// Quality report — output of a QualityMonitor.assess() call.
// Every monitor returns this shape. Use-case-specific details live in `meta`.
// ---------------------------------------------------------------------------

export interface QualityReport {
  score: number;                  // 0.0 – 1.0, higher is better
  reasoning: string;              // one-sentence explanation for the UI
  meta: Record<string, unknown>;  // per-oracle extras (e.g. compile output, CLIP raw scores)
  chunkIndex: number;
  assessedAt: number;             // epoch ms
}

// ---------------------------------------------------------------------------
// Session events
// ---------------------------------------------------------------------------

interface BaseEvent {
  sessionId: string;
  ts: number;
}

export interface SessionStartedEvent extends BaseEvent {
  type: "session-started";
  useCase: UseCase;
  prompt: string;
  budgetUsdc: number;
  qualityThreshold: number;
  chunkSizeTokens: number;
  maxTokens: number;
  buyerAddress: string;
  sellerBaseUrl: string;
}

export interface ChunkStartedEvent extends BaseEvent {
  type: "chunk-started";
  chunkIndex: number;
}

// A piece of the chunk's output. For text: partial text. For code: partial code.
// For images: a completed image (the whole chunk is one image).
// Emitted multiple times per chunk for streamed output, once for atomic output.
export interface TokensEvent extends BaseEvent {
  type: "tokens";
  chunkIndex: number;
  text: string;
}

export interface ChunkCompleteEvent extends BaseEvent {
  type: "chunk-complete";
  chunkIndex: number;
  tokenCount: number;
  priceUsdc: number;
  transaction?: string;  // Gateway tx id; present once settled
}

export interface QualityAssessedEvent extends BaseEvent {
  type: "quality-assessed";
  chunkIndex: number;
  report: QualityReport;
  rollingAvg: number;
  threshold: number;
  monitorName: string;
}

export interface KillDecisionEvent extends BaseEvent {
  type: "kill-decision";
  chunkIndex: number;
  reason: string;
  rollingAvg: number;
  threshold: number;
  spentUsdc: number;
}

export interface BudgetExhaustedEvent extends BaseEvent {
  type: "budget-exhausted";
  chunkIndex: number;
  spentUsdc: number;
  budgetUsdc: number;
}

export interface BatchSettledEvent extends BaseEvent {
  type: "batch-settled";
  transaction: string;
  chunksIncluded: number[];
}

export interface SessionCompleteEvent extends BaseEvent {
  type: "session-complete";
  outcome: "completed" | "killed" | "budget" | "error";
  chunksCompleted: number;
  tokensReceived: number;
  spentUsdc: number;
  wouldHaveSpentUsdc: number;    // chunks * price, i.e. what a full run would have cost
  elapsedMs: number;
  killReason?: string;
  errorMessage?: string;
}

export type SessionEvent =
  | SessionStartedEvent
  | ChunkStartedEvent
  | TokensEvent
  | ChunkCompleteEvent
  | QualityAssessedEvent
  | KillDecisionEvent
  | BudgetExhaustedEvent
  | BatchSettledEvent
  | SessionCompleteEvent;

// Helper: is this event a terminal one?
export function isTerminal(e: SessionEvent): boolean {
  return e.type === "session-complete";
}
