// client/buyer.ts
//
// The Midstream buyer. One class, one public method: runSession(args).
//
// For each chunk in the session:
//   1. If next chunk would exceed budget → emit budget-exhausted, stop.
//   2. Call POST /chunk/{useCase} via GatewayClient.pay — SDK signs the
//      EIP-712 authorization and retries with PAYMENT-SIGNATURE automatically.
//   3. Append returned text to cumulative output.
//   4. Run the quality monitor on the cumulative output.
//   5. Feed the new QualityReport into kill-gate.
//   6. If kill → emit kill-decision, stop.
//   7. If Claude says stop_reason=end_turn → natural stop.
//   8. Otherwise → next chunk.
//
// The buyer is a library, not a process. Callers (scripts/run-demo.ts today,
// web-server later) create a Buyer + a SessionBus, call runSession, and
// subscribe to the bus for live events. The bus supports replay so a UI can
// attach mid-session without missing earlier events.

import { GatewayClient } from "@circle-fin/x402-batching/client";
import type {
  QualityMonitor,
  QualityContext,
  SessionOptions,
  SessionResult,
} from "../shared/types.js";
import type { QualityReport } from "../shared/events.js";
import { SessionBus } from "../shared/session-bus.js";
import { evaluateKillGate } from "./kill-gate.js";

export interface BuyerDeps {
  privateKey: `0x${string}`;
  monitor: QualityMonitor;
}

export interface RunSessionArgs extends SessionOptions {
  sessionId: string;
  bus: SessionBus;
}

interface ChunkResponse {
  text: string;
  tokensGenerated: number;
  finishReason: string;
}

export class Buyer {
  private readonly client: GatewayClient;
  private readonly monitor: QualityMonitor;

  constructor(deps: BuyerDeps) {
    this.client = new GatewayClient({
      chain: "arcTestnet",
      privateKey: deps.privateKey,
    });
    this.monitor = deps.monitor;
  }

  get address(): `0x${string}` {
    return this.client.address as `0x${string}`;
  }

  /**
   * Ensure Gateway balance is sufficient before starting sessions. If the
   * current available Gateway balance is < 1 USDC, top up by `topUpUsdc`.
   * Returns null when the existing balance is already enough.
   */
  async ensureDeposit(topUpUsdc = "5"): Promise<{ depositTxHash: string } | null> {
    const balances = await this.client.getBalances();
    // 1 USDC = 1_000_000 atomic.
    if (balances.gateway.available < 1_000_000n) {
      return this.client.deposit(topUpUsdc);
    }
    return null;
  }

  async runSession(args: RunSessionArgs): Promise<SessionResult> {
    const {
      sessionId,
      bus,
      useCase,
      prompt,
      sellerBaseUrl,
      budgetUsdc,
      qualityThreshold,
      rollingWindow,
      warmupChunks,
      chunkPriceUsdc,
      chunkSizeTokens,
      maxTokens,
    } = args;

    // All quantities used in the finalizer are declared up top so no early
    // return can hit a TDZ. A previous version used `const` + a hoisted
    // `buildResult()` function; if the inner catch returned, that reference
    // threw "Cannot access 'elapsedMs' before initialization" which got
    // swallowed by the outer catch and caused a ghost second session-complete
    // event. Keep them all up here.
    const startTime = Date.now();
    const maxChunks = Math.ceil(maxTokens / chunkSizeTokens);
    const wouldHaveSpentUsdc = maxChunks * chunkPriceUsdc;

    const qualityHistory: QualityReport[] = [];
    const transactions: string[] = [];
    let cumulativeText = "";
    let chunksCompleted = 0;
    let tokensReceived = 0;
    let spent = 0;
    let outcome: SessionResult["outcome"] = "completed";
    let killReason: string | undefined;
    let errorMessage: string | undefined;

    const route = routeFor(useCase);
    const url = sellerBaseUrl.replace(/\/$/, "") + route;

    bus.publish({
      type: "session-started",
      useCase,
      prompt,
      budgetUsdc,
      qualityThreshold,
      chunkSizeTokens,
      maxTokens,
      buyerAddress: this.address,
      sellerBaseUrl,
    });

    // Single try/catch wraps the whole chunk loop. Any error inside — in
    // .pay(), the quality monitor, etc. — ends the session as `outcome=error`.
    try {
      for (let chunkIndex = 0; chunkIndex < maxChunks; chunkIndex++) {
        // Rule: budget check before each paid chunk.
        if (spent + chunkPriceUsdc > budgetUsdc + 1e-9) {
          outcome = "budget";
          bus.publish({
            type: "budget-exhausted",
            chunkIndex,
            spentUsdc: spent,
            budgetUsdc,
          });
          break;
        }

        bus.publish({ type: "chunk-started", chunkIndex });

        // --- Pay for + receive the chunk ---------------------------------
        // GatewayClient.pay() does: initial request → receive 402 → sign
        // EIP-712 authorization → retry with PAYMENT-SIGNATURE → return data.
        const body = JSON.stringify({
          sessionId,
          prompt,
          textSoFar: cumulativeText,
          chunkIndex,
          maxTokens: chunkSizeTokens,
        });

        const payResult = await this.client.pay<ChunkResponse>(url, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body,
        });

        const chunk = payResult.data;
        const transaction = payResult.transaction;

        cumulativeText += chunk.text;
        tokensReceived += chunk.tokensGenerated;
        spent += chunkPriceUsdc;
        chunksCompleted++;
        if (transaction) transactions.push(transaction);

        if (chunk.text.length > 0) {
          bus.publish({ type: "tokens", chunkIndex, text: chunk.text });
        }
        bus.publish({
          type: "chunk-complete",
          chunkIndex,
          tokenCount: chunk.tokensGenerated,
          priceUsdc: chunkPriceUsdc,
          transaction,
        });

        const naturalStop =
          chunk.finishReason === "end_turn" ||
          chunk.finishReason === "stop_sequence";

        // --- Quality assessment -----------------------------------------
        const ctx: QualityContext = {
          sessionId,
          prompt,
          chunkIndex,
          cumulative: buildCumulative(useCase, cumulativeText),
        };

        const report = await this.monitor.assess(ctx);
        qualityHistory.push(report);

        const recent = qualityHistory.slice(-rollingWindow);
        const rollingAvg =
          recent.reduce((s, r) => s + r.score, 0) / recent.length;

        bus.publish({
          type: "quality-assessed",
          chunkIndex,
          report,
          rollingAvg,
          threshold: qualityThreshold,
          monitorName: this.monitor.name,
        });

        // --- Kill gate ---------------------------------------------------
        const decision = evaluateKillGate(qualityHistory, {
          threshold: qualityThreshold,
          warmup: warmupChunks,
          rollingWindow,
        });

        if (decision.kill) {
          outcome = "killed";
          killReason = decision.reason;
          bus.publish({
            type: "kill-decision",
            chunkIndex,
            reason: decision.reason,
            rollingAvg: decision.rollingAvg,
            threshold: qualityThreshold,
            spentUsdc: spent,
          });
          break;
        }

        if (naturalStop) {
          outcome = "completed";
          break;
        }

        if (tokensReceived >= maxTokens) {
          outcome = "completed";
          break;
        }
      }
    } catch (err) {
      outcome = "error";
      errorMessage = err instanceof Error ? err.message : String(err);
    }

    const elapsedMs = Date.now() - startTime;

    bus.publish({
      type: "session-complete",
      outcome,
      chunksCompleted,
      tokensReceived,
      spentUsdc: spent,
      wouldHaveSpentUsdc,
      elapsedMs,
      killReason,
      errorMessage,
    });

    return {
      sessionId,
      outcome,
      chunksCompleted,
      tokensReceived,
      spentUsdc: spent,
      wouldHaveSpentUsdc,
      elapsedMs,
      killReason,
      errorMessage,
      output: cumulativeText,
      transactions,
    };
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function routeFor(useCase: SessionOptions["useCase"]): string {
  switch (useCase) {
    case "text":
      return "/chunk/text";
    case "code":
      return "/chunk/code";
    case "image":
      return "/chunk/image";
  }
}

function buildCumulative(
  useCase: SessionOptions["useCase"],
  text: string,
): QualityContext["cumulative"] {
  switch (useCase) {
    case "text":
      return { kind: "text", text };
    case "code":
      return { kind: "code", code: text, language: "typescript" };
    case "image":
      throw new Error(
        "image use case not implemented yet (Option C extension)",
      );
  }
}
