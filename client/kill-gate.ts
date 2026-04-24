// client/kill-gate.ts
//
// The decision logic that turns a history of QualityReports into a kill/go
// call. Pure function — no I/O, no state, fully deterministic given inputs.
//
// Three rules, applied in order:
//
//   1. Warmup: the first `warmup` chunks never trigger a kill. Rationale:
//      early chunks often score lower because there's less context for the
//      judge to work with. Waiting a couple of chunks avoids false positives
//      on perfectly fine streams that happen to start slowly.
//
//   2. Rolling average: after warmup, if the average of the last N scores
//      drops below `threshold`, kill. N = rollingWindow, default 3. This is
//      the PRIMARY rule — sustained underperformance is the real signal.
//
//   3. Catastrophic single chunk: after warmup, if the most recent chunk
//      alone scores ≤ 0.1 (i.e. basically a 0), kill immediately. Rationale:
//      for the code oracle, a single tsc failure means the code is broken
//      NOW — waiting three chunks to catch a broken state would waste money.
//      For the text oracle, a single 0 typically means the model bailed on
//      the topic entirely, also worth killing fast.
//
// See docs/QUALITY_CHECKER_DESIGN.md §5 for the full rationale.

import type { QualityReport } from "../shared/events.js";

export interface KillGateConfig {
  threshold: number;     // e.g. 0.60
  warmup: number;        // chunks before kill gate engages; default 2
  rollingWindow: number; // number of recent chunks in the moving average; default 3
}

export interface KillDecision {
  kill: boolean;
  reason: string;
  rollingAvg: number;
  chunksConsidered: number;
}

const CATASTROPHIC_SCORE_THRESHOLD = 0.1;

export function evaluateKillGate(
  history: QualityReport[],
  cfg: KillGateConfig,
): KillDecision {
  // Rule 1: warmup
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

  // Rule 2: rolling average below threshold
  if (avg < cfg.threshold) {
    return {
      kill: true,
      reason: `rolling avg ${avg.toFixed(3)} below threshold ${cfg.threshold.toFixed(3)} (last ${recent.length} chunks)`,
      rollingAvg: avg,
      chunksConsidered: recent.length,
    };
  }

  // Rule 3: single catastrophic chunk
  if (last && last.score <= CATASTROPHIC_SCORE_THRESHOLD) {
    return {
      kill: true,
      reason: `single chunk catastrophic failure (score ${last.score.toFixed(3)} at chunk ${last.chunkIndex})`,
      rollingAvg: avg,
      chunksConsidered: recent.length,
    };
  }

  return {
    kill: false,
    reason: `rolling avg ${avg.toFixed(3)} >= threshold ${cfg.threshold.toFixed(3)}`,
    rollingAvg: avg,
    chunksConsidered: recent.length,
  };
}
