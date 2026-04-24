// scripts/run-demo.ts
//
// Headless demo runner. Runs several sessions end-to-end against a running
// seller (npm run seller in another terminal). Prints tokens + quality
// scores live. Writes every settled transaction id to logs/tx-log.jsonl
// for verify-onchain.ts to consume.
//
// Goal: ≥ 50 settled Gateway transactions across all sessions (hackathon
// hard requirement).
//
// Usage:
//   # Terminal 1:
//   npm run seller
//   # Terminal 2:
//   npm run demo
//
// What gets run:
//   - 2 text sessions (research/summarization prompts)
//   - 1 text session designed to drift (triggers the kill gate)
//   - 1 code session (pay-per-function code generation with tsc oracle)
// Three sessions × ~31 chunks each = 90+ paid chunks, well above the 50-tx
// floor.
//
// Cost safety: GEMINI_MAX_COST_USD (default $1.00) caps spend on the
// Gemini judge across the whole demo. Checked between sessions. If the
// cap is exceeded after any session, the demo aborts before starting the
// next one. This is a second line of defense — the primary cap should be
// a Google Cloud billing budget alert at $5/month.

import { randomUUID } from "node:crypto";
import { appendFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { Buyer } from "../client/buyer.js";
import { TextQualityMonitor } from "../client/quality/text-monitor.js";
import { CodeQualityMonitor } from "../client/quality/code-monitor.js";
import { SessionBus } from "../shared/session-bus.js";
import type { SessionEvent } from "../shared/events.js";
import type { SessionOptions, SessionResult, QualityMonitor } from "../shared/types.js";
import { env, requireBuyerEnv } from "../shared/config.js";

requireBuyerEnv();

const SELLER_URL = `http://localhost:${env.sellerPort}`;
const LOG_DIR = join(process.cwd(), "logs");
const TX_LOG = join(LOG_DIR, "tx-log.jsonl");

// Cost cap for the Gemini judge — read from env, default $1.00 per demo run.
// Applied BETWEEN sessions (a session in progress is allowed to finish so we
// don't abandon in-flight paid chunks).
const GEMINI_MAX_COST_USD = Number(process.env.GEMINI_MAX_COST_USD ?? "1.0");

interface DemoSession {
  label: string;
  useCase: "text" | "code";
  prompt: string;
}

const DEMO_SESSIONS: DemoSession[] = [
  {
    label: "Research: EU AI Act & open source",
    useCase: "text",
    prompt:
      "Write a structured 200-word brief on the impact of the EU AI Act on open-source model distribution. Focus on Article 53 exemptions and the systemic-risk threshold for general-purpose AI. Cite relevant articles of Regulation 2024/1689.",
  },
  {
    label: "Research: DNS internals (happy path)",
    useCase: "text",
    prompt:
      "Explain how DNS resolution actually works end to end. Cover recursive resolvers, iterative queries to root/TLD/authoritative nameservers, caching with TTLs, and why DNS is a hierarchical trust system. Be concrete and technical.",
  },
  {
    label: "Drift demo — starts on topic, wanders",
    useCase: "text",
    prompt:
      "Describe the basic biology of photosynthesis in 3 sentences. Then, and this is important, also reflect deeply on how medieval heraldic guild traditions might metaphorically parallel plant cellular hierarchy, drawing surprising analogies before returning to chloroplasts.",
  },
  {
    label: "Code: median function with tests",
    useCase: "code",
    prompt:
      "Write a TypeScript function `median(xs: number[]): number` that returns the median of an array of numbers. Handle the empty-array case by throwing. Include node:test cases for [1,2,3], [1,2,3,4], and the empty array.",
  },
];

async function main() {
  await mkdir(LOG_DIR, { recursive: true });

  const textMonitor = new TextQualityMonitor(env.geminiApiKey!, env.geminiModel);
  const codeMonitor = new CodeQualityMonitor();

  // One buyer reused across sessions — same Gateway balance funds them all.
  const buyer = new Buyer({
    privateKey: env.buyerPrivateKey!,
    monitor: textMonitor, // placeholder; swapped per-session below
  });

  console.log("━".repeat(78));
  console.log(" Midstream demo");
  console.log("━".repeat(78));
  console.log(`  buyer:           ${buyer.address}`);
  console.log(`  seller URL:      ${SELLER_URL}`);
  console.log(`  sessions:        ${DEMO_SESSIONS.length}`);
  console.log(`  Gemini cost cap: $${GEMINI_MAX_COST_USD.toFixed(2)} per run`);
  console.log("");

  // Pre-flight: make sure seller is up.
  try {
    const health = await fetch(`${SELLER_URL}/health`);
    if (!health.ok) throw new Error(`seller /health returned ${health.status}`);
  } catch (err) {
    console.error(`❌ Cannot reach seller at ${SELLER_URL}`);
    console.error(`   ${err instanceof Error ? err.message : String(err)}`);
    console.error(`   Start it first:  npm run seller`);
    process.exit(1);
  }

  // Pre-flight: ensure buyer has Gateway balance.
  const deposit = await buyer.ensureDeposit("5").catch((e) => {
    console.error("❌ Gateway deposit check/top-up failed.");
    console.error(`   ${e instanceof Error ? e.message : String(e)}`);
    process.exit(1);
  });
  if (deposit) {
    console.log(`  auto-deposit tx: ${deposit.depositTxHash}`);
    console.log("");
  }

  const allResults: SessionResult[] = [];
  let abortedByBudget = false;

  for (let i = 0; i < DEMO_SESSIONS.length; i++) {
    // Budget check BEFORE starting the next session.
    const costBefore = textMonitor.getCostEstimate();
    if (costBefore.estimatedUsd >= GEMINI_MAX_COST_USD) {
      console.warn("━".repeat(78));
      console.warn(
        `⚠  Gemini spend estimate $${costBefore.estimatedUsd.toFixed(4)} has reached cap ` +
        `$${GEMINI_MAX_COST_USD.toFixed(2)}. Skipping remaining ${DEMO_SESSIONS.length - i} session(s).`,
      );
      console.warn(`   To raise the cap: set env GEMINI_MAX_COST_USD=<higher value> and re-run.`);
      console.warn("━".repeat(78));
      abortedByBudget = true;
      break;
    }

    const session = DEMO_SESSIONS[i]!;
    const monitor: QualityMonitor =
      session.useCase === "code" ? codeMonitor : textMonitor;
    (buyer as any).monitor = monitor;

    const sessionId = randomUUID();
    const bus = new SessionBus(sessionId);

    console.log("─".repeat(78));
    console.log(` [${i + 1}/${DEMO_SESSIONS.length}] ${session.label}`);
    console.log(
      ` sessionId: ${sessionId.slice(0, 8)}  useCase: ${session.useCase}  ` +
      `monitor: ${monitor.name}  ` +
      `gemini spend so far: $${costBefore.estimatedUsd.toFixed(4)} / $${GEMINI_MAX_COST_USD.toFixed(2)}`,
    );
    console.log("─".repeat(78));

    const unsub = bus.subscribe((e) => {
      renderEvent(e);
      if (e.type === "chunk-complete" && e.transaction) {
        void appendFile(
          TX_LOG,
          JSON.stringify({
            sessionId: e.sessionId,
            chunkIndex: e.chunkIndex,
            transaction: e.transaction,
            ts: e.ts,
          }) + "\n",
          "utf-8",
        );
      }
    });

    const opts: SessionOptions = {
      useCase: session.useCase,
      prompt: session.prompt,
      chunkPriceUsdc: env.pricePerChunkUsdc,
      chunkSizeTokens: env.chunkSizeTokens,
      maxTokens: env.maxTokensPerSession,
      budgetUsdc: env.buyerMaxSpendUsdc,
      qualityThreshold: env.qualityThreshold,
      rollingWindow: env.rollingWindowSize,
      warmupChunks: env.warmupChunks,
      sellerBaseUrl: SELLER_URL,
    };

    const result = await buyer.runSession({ ...opts, sessionId, bus });
    unsub();
    allResults.push(result);

    const costAfter = textMonitor.getCostEstimate();
    console.log(
      `   gemini: ${costAfter.callCount} calls, ${costAfter.inputTokens} in + ` +
      `${costAfter.outputTokens} out tokens, est $${costAfter.estimatedUsd.toFixed(4)}`,
    );
    console.log("");
  }

  // --- Final summary --------------------------------------------------
  console.log("━".repeat(78));
  console.log(" SUMMARY");
  console.log("━".repeat(78));
  let totalChunks = 0;
  let totalSpent = 0;
  let totalWouldHave = 0;
  const allTxs: string[] = [];
  for (let i = 0; i < allResults.length; i++) {
    const r = allResults[i]!;
    const label = DEMO_SESSIONS[i]!.label;
    console.log(
      `  ${String(i + 1).padStart(2)}. ${label.padEnd(45)} ` +
      `${r.outcome.padEnd(10)} ` +
      `${String(r.chunksCompleted).padStart(3)} chunks  ` +
      `$${r.spentUsdc.toFixed(4)} / $${r.wouldHaveSpentUsdc.toFixed(4)}`,
    );
    if (r.killReason) {
      console.log(`       kill reason: ${r.killReason}`);
    }
    if (r.errorMessage) {
      console.log(`       ✗ error:     ${r.errorMessage}`);
    }
    totalChunks += r.chunksCompleted;
    totalSpent += r.spentUsdc;
    totalWouldHave += r.wouldHaveSpentUsdc;
    allTxs.push(...r.transactions);
  }
  console.log("");

  const geminiCost = textMonitor.getCostEstimate();
  console.log(`  Total paid chunks:       ${totalChunks}`);
  console.log(`  Total Gateway txs:       ${allTxs.length}`);
  console.log(`  Total USDC spent:        $${totalSpent.toFixed(4)} USDC`);
  console.log(`  Full-run would cost:     $${totalWouldHave.toFixed(4)} USDC`);
  console.log(`  Savings from kills:      $${(totalWouldHave - totalSpent).toFixed(4)} USDC`);
  console.log("");
  console.log(`  Gemini calls:            ${geminiCost.callCount}`);
  console.log(`  Gemini input tokens:     ${geminiCost.inputTokens}`);
  console.log(`  Gemini output tokens:    ${geminiCost.outputTokens}`);
  console.log(`  Gemini est. cost (USD):  $${geminiCost.estimatedUsd.toFixed(4)} / cap $${GEMINI_MAX_COST_USD.toFixed(2)}`);
  if (abortedByBudget) {
    console.log(`  ⚠  demo aborted early due to Gemini cost cap`);
  }
  console.log("");
  console.log(`  Tx log: ${TX_LOG}`);
  console.log(
    `  Hackathon requirement: ≥50 on-chain transactions → ` +
    `${allTxs.length >= 50 ? "✅ PASS" : "❌ SHORT, run more sessions"}`,
  );
  console.log("━".repeat(78));
}

// ---------------------------------------------------------------------------
// Pretty-printer for live progress
// ---------------------------------------------------------------------------

function renderEvent(e: SessionEvent): void {
  switch (e.type) {
    case "session-started":
      console.log(`   prompt: "${e.prompt.slice(0, 80)}${e.prompt.length > 80 ? "…" : ""}"`);
      console.log("");
      process.stdout.write("   ");
      break;

    case "tokens":
      process.stdout.write(e.text);
      break;

    case "quality-assessed":
      process.stdout.write(
        ` [q=${e.report.score.toFixed(2)} avg=${e.rollingAvg.toFixed(2)}]`,
      );
      break;

    case "chunk-complete":
      if (e.chunkIndex % 5 === 4) process.stdout.write("\n   ");
      break;

    case "kill-decision":
      console.log(`\n\n   ☠  KILLED at chunk ${e.chunkIndex}: ${e.reason}`);
      break;

    case "budget-exhausted":
      console.log(
        `\n\n   💸  Budget exhausted at chunk ${e.chunkIndex}: ` +
        `$${e.spentUsdc.toFixed(4)} of $${e.budgetUsdc.toFixed(4)}`,
      );
      break;

    case "session-complete":
      if (e.errorMessage) {
        console.log(`\n\n   ✗ ERROR: ${e.errorMessage}`);
      }
      console.log(
        `   → ${e.outcome}: ${e.chunksCompleted} chunks, ${e.tokensReceived} tokens, ` +
        `$${e.spentUsdc.toFixed(4)} spent, ${e.elapsedMs}ms`,
      );
      break;
  }
}

main().catch((err) => {
  console.error("\n❌ demo failed:");
  console.error(err);
  process.exit(1);
});
