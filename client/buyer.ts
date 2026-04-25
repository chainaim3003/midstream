// client/buyer.ts
//
// The Midstream buyer. One class, one public method: runSession(args).
// Also exposes transfer-lookup helpers that wrap Circle's Gateway API so
// the UI can resolve each "payment ID" (UUID) to its real on-chain
// settlement status after Circle batches.
//
// See node_modules/@circle-fin/x402-batching/dist/client/index.mjs for the
// verbatim definitions of GatewayClient.pay(), getTransferById(), and
// searchTransfers(). The UUIDs that .pay() returns in its `transaction`
// field are Circle Transfer IDs (not Ethereum tx hashes) extracted from
// the seller's PAYMENT-RESPONSE header. The on-chain 0x-prefixed tx hash
// is produced later by Circle's facilitator when it batches multiple
// authorizations into a single on-chain settlement — resolvable via
// getTransferById(id) once the transfer moves through
// received → batched → confirmed → completed.

import { GatewayClient } from "@circle-fin/x402-batching/client";
import type { Hex } from "viem";
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

/**
 * Raw Transfer object as returned by Circle Gateway's
 * GET /v1/x402/transfers/{id} endpoint. The SDK types this as having
 * `[key: string]: unknown` so additional fields may be present. We
 * surface the whole object to callers unchanged.
 */
export type TransferLookup = Record<string, unknown>;

export class Buyer {
  private readonly client: GatewayClient;
  private monitor: QualityMonitor;

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

  /** Runtime swap for the quality monitor (run-demo.ts + web-server use this). */
  setMonitor(m: QualityMonitor): void {
    this.monitor = m;
  }

  /**
   * Ensure Gateway balance is sufficient before starting sessions. If the
   * current available Gateway balance is < 1 USDC, top up by `topUpUsdc`.
   * Returns null when the existing balance is already enough.
   */
  async ensureDeposit(topUpUsdc = "5"): Promise<{ depositTxHash: string } | null> {
    const balances = await this.client.getBalances();
    if (balances.gateway.available < 1_000_000n) {
      return this.client.deposit(topUpUsdc);
    }
    return null;
  }

  /**
   * Unconditionally call GatewayClient.deposit() once. Used by the dashboard's
   * "Add N on-chain Arc tx (live)" button to produce direct on-chain Arc
   * transactions visible at the buyer's EOA. Each call produces one or two
   * on-chain Arc txs (USDC.approve when allowance must be raised, plus
   * GatewayWallet.deposit), and returns the deposit tx hash.
   */
  async forceDeposit(amountUsdc: string): Promise<{ depositTxHash: string }> {
    return this.client.deposit(amountUsdc);
  }

  /**
   * Read the buyer's wallet USDC balance and Gateway balance.
   *
   * The wallet balance comes from a direct Arc RPC `balanceOf` read against
   * the USDC contract. The Gateway balance comes from Circle's official
   * Gateway API (`POST /v1/balances`). Both are surfaced together so the
   * dashboard can show the live, API-reported state alongside the
   * locally-tracked in-flight spend.
   *
   * Per Circle's docs (Batched Settlement, balance lifecycle): the
   * `gateway.available` value drops asynchronously as Circle's batcher
   * settles signed authorizations on chain.
   */
  async getBalances(): ReturnType<GatewayClient["getBalances"]> {
    return this.client.getBalances();
  }

  /**
   * Resolve a Circle Transfer ID (the UUID returned by .pay()) to its full
   * transfer record. Returns whatever Circle's API returns — including the
   * settlement transaction hash once the transfer has been batched and
   * confirmed on-chain.
   *
   * Endpoint (from SDK source): GET https://gateway-api-testnet.circle.com/v1/x402/transfers/{id}
   */
  async lookupTransfer(transferId: string): Promise<TransferLookup> {
    return (await this.client.getTransferById(transferId)) as TransferLookup;
  }

  /**
   * List transfers matching filter criteria. Defaults to the buyer's chain
   * (Arc testnet: eip155:5042002). Useful for "show me every settlement
   * that has reached the seller address on Arc."
   *
   * Endpoint (from SDK source): GET https://gateway-api-testnet.circle.com/v1/x402/transfers
   */
  async searchTransfers(params: {
    from?: Hex;
    to?: Hex;
    status?: "received" | "batched" | "confirmed" | "completed" | "failed";
    pageSize?: number;
    pageAfter?: string;
    pageBefore?: string;
  }): Promise<{ transfers: TransferLookup[]; pagination?: unknown }> {
    const result = await this.client.searchTransfers({
      ...params,
      token: "USDC",
    });
    return result as { transfers: TransferLookup[]; pagination?: unknown };
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

    try {
      for (let chunkIndex = 0; chunkIndex < maxChunks; chunkIndex++) {
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
        const transferId = payResult.transaction;

        cumulativeText += chunk.text;
        tokensReceived += chunk.tokensGenerated;
        spent += chunkPriceUsdc;
        chunksCompleted++;
        if (transferId) transactions.push(transferId);

        if (chunk.text.length > 0) {
          bus.publish({ type: "tokens", chunkIndex, text: chunk.text });
        }
        bus.publish({
          type: "chunk-complete",
          chunkIndex,
          tokenCount: chunk.tokensGenerated,
          priceUsdc: chunkPriceUsdc,
          transaction: transferId,
        });

        const naturalStop =
          chunk.finishReason === "end_turn" ||
          chunk.finishReason === "stop_sequence";

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
