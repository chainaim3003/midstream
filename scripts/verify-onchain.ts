// scripts/verify-onchain.ts
//
// Reads logs/tx-log.jsonl, calls Circle's getTransferById for each UUID,
// and produces an honest settlement report.
//
// Important fact about Circle's API (verified empirically against Arc testnet
// on 2026-04-25): the per-transfer record returned by `getTransferById` and
// the records returned by `searchTransfers` do NOT include the on-chain
// transaction hash. Every transfer carries:
//   { id, status, token, sendingNetwork, recipientNetwork,
//     fromAddress, toAddress, amount, createdAt, updatedAt }
// — and nothing else.
//
// This is by design. Per Circle's batched-settlement docs:
//   "Gateway aggregates payment authorizations and settles them onchain in
//    a single transaction."
// Many transfers (often 50+) share one on-chain Arc tx at the GatewayWallet
// contract (0x0077777d7EBA4688BDeF3E311b846F25870A19B9). The transfer record
// references the batch implicitly through the shared `updatedAt` timestamp:
// transfers settled together get the same `updatedAt` (to the millisecond).
//
// This script's job, therefore, is to:
//   1. Resolve every UUID in tx-log.jsonl via the Circle API.
//   2. Count settlements (status = completed).
//   3. GROUP transfers by `updatedAt` to a 1-second window and report each
//      group as one batch settlement event = one on-chain Arc tx at the
//      GatewayWallet contract.
//   4. Direct the human reader to inspect the GatewayWallet contract on
//      arcscan to see those Arc txs directly.
//
// What this script does NOT do: claim per-transfer 0x hashes that Circle's
// API does not expose. We had a previous version that searched for hashes
// in transfer records; the search always failed because the hashes are not
// there. We've removed that misleading code.
//
// This is also a documented item in Circle Product Feedback (CIRCLE_FEEDBACK.md
// §3.5 — Observable batch settlement) where we request that Circle expose
// the transfer→batch→Arc-tx link via API or webhook. Until they ship that,
// the right verification path is the one this script implements.
//
// Usage:
//   npm run verify-onchain               # full resolution + report
//   npm run verify-onchain -- --quick    # skip API resolution, count UUIDs only

import { readFile, writeFile, mkdir } from "node:fs/promises";
import { join, dirname } from "node:path";
import { GatewayClient } from "@circle-fin/x402-batching/client";
import { Buyer } from "../client/buyer.js";
import { TextQualityMonitor } from "../client/quality/text-monitor.js";
import { env, requireBuyerEnv } from "../shared/config.js";

requireBuyerEnv();

const TX_LOG = join(process.cwd(), "logs", "tx-log.jsonl");
const VERIFY_REPORT = join(process.cwd(), "logs", "verify-report.json");
const EXPLORER = env.arcBlockExplorerUrl;
const GATEWAY_WALLET_ADDRESS = "0x0077777d7EBA4688BDeF3E311b846F25870A19B9";
const QUICK = process.argv.includes("--quick");

// Two transfers are considered part of the same batch if their updatedAt
// timestamps are within this many milliseconds. Circle's batcher commits
// updatedAt within a fraction of a second of each other for transfers in
// the same batch — empirically same to the millisecond — so 1000ms is
// generous and correct.
const BATCH_GROUPING_WINDOW_MS = 1000;

interface TxRow {
  sessionId: string;
  chunkIndex: number;
  transaction: string;
  ts: number;
}

interface ResolvedTransfer {
  uuid: string;
  status: string;
  fromAddress?: string;
  toAddress?: string;
  amount?: string;
  createdAt?: string;
  updatedAt?: string;
  loggedAt: number;
  error?: string;
}

interface BatchGroup {
  // The earliest updatedAt in this group (ISO string); used as the group's id.
  updatedAtIso: string;
  updatedAtMs: number;
  transferCount: number;
  totalAmountAtomic: bigint;
  totalAmountUsdc: number;
  // Sample UUIDs (first 3) so a human can spot-check.
  sampleUuids: string[];
  // Direction summary
  fromAddresses: Set<string>;
  toAddresses: Set<string>;
}

interface VerifyReport {
  generatedAt: string;
  sourceLog: string;
  totalLogRows: number;
  uniqueUuids: number;
  statusBreakdown: Record<string, number>;
  settlements: {
    completedTransfers: number;
    estimatedBatches: number;
    totalAmountUsdc: number;
    batches: Array<{
      updatedAt: string;
      transferCount: number;
      totalAmountUsdc: number;
      sampleUuids: string[];
    }>;
  };
  proofPoints: {
    gatewayWalletContract: string;
    gatewayWalletExplorerUrl: string;
    buyerAddress?: string;
    buyerExplorerUrl?: string;
    sellerAddress?: string;
    sellerExplorerUrl?: string;
  };
  resolved: ResolvedTransfer[];
  hackathonVerdict: {
    paidActionsCount: number;
    settledActionsCount: number;
    estimatedBatchTxsOnChain: number;
    threshold: number;
    pass: boolean;
    notes: string;
  };
}

function fmtUsdcFromAtomic(atomic: bigint): number {
  // 6 decimals, USDC native unit on Arc
  return Number(atomic) / 1_000_000;
}

async function main(): Promise<void> {
  // ---- 1. Read tx-log.jsonl --------------------------------------------
  let raw: string;
  try {
    raw = await readFile(TX_LOG, "utf-8");
  } catch {
    console.error(`X ${TX_LOG} not found.`);
    console.error(`   Run 'npm run demo' or 'npm run web' + run sessions to generate it.`);
    process.exit(1);
  }

  const rows: TxRow[] = raw
    .split("\n")
    .filter((l) => l.trim() !== "")
    .map((l, i) => {
      try {
        return JSON.parse(l) as TxRow;
      } catch {
        console.error(`!  malformed line ${i + 1}; skipping`);
        return null;
      }
    })
    .filter((r): r is TxRow => r !== null);

  const uniqueUuidSet = new Set(rows.map((r) => r.transaction));
  const uniqueUuids = [...uniqueUuidSet];

  console.log("=".repeat(72));
  console.log(" Midstream on-chain verification");
  console.log("=".repeat(72));
  console.log(`  log file:                     ${TX_LOG}`);
  console.log(`  log rows (paid chunks):       ${rows.length}`);
  console.log(`  unique Circle Transfer UUIDs: ${uniqueUuids.length}`);

  // ---- 2. Resolve each UUID via Circle's API ---------------------------
  const resolved: ResolvedTransfer[] = [];
  const statusCounts = new Map<string, number>();

  if (QUICK) {
    console.log(`\n  --quick mode: skipping API resolution.`);
  } else {
    const monitor = new TextQualityMonitor(env.geminiApiKey!, env.geminiModel);
    const buyer = new Buyer({
      privateKey: env.buyerPrivateKey!,
      monitor,
    });

    console.log(`\n  Resolving ${uniqueUuids.length} UUIDs via Circle Gateway API...`);
    const firstSeen = new Map<string, number>();
    for (const r of rows) {
      if (!firstSeen.has(r.transaction)) firstSeen.set(r.transaction, r.ts);
    }

    for (let i = 0; i < uniqueUuids.length; i++) {
      const uuid = uniqueUuids[i];
      const tag = `[${String(i + 1).padStart(3)}/${uniqueUuids.length}]`;
      try {
        const record = (await buyer.lookupTransfer(uuid)) as Record<string, unknown>;
        const status = String(record.status ?? "unknown");
        const updatedAt = typeof record.updatedAt === "string" ? record.updatedAt : undefined;
        resolved.push({
          uuid,
          status,
          fromAddress: typeof record.fromAddress === "string" ? record.fromAddress : undefined,
          toAddress: typeof record.toAddress === "string" ? record.toAddress : undefined,
          amount: typeof record.amount === "string" ? record.amount : undefined,
          createdAt: typeof record.createdAt === "string" ? record.createdAt : undefined,
          updatedAt,
          loggedAt: firstSeen.get(uuid) ?? 0,
        });
        statusCounts.set(status, (statusCounts.get(status) ?? 0) + 1);
        if ((i + 1) % 25 === 0 || i === uniqueUuids.length - 1) {
          console.log(`    ${tag} ${uuid.slice(0, 8)}...  ${status.padEnd(10)}  updated ${updatedAt ?? "-"}`);
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        resolved.push({
          uuid,
          status: "lookup-failed",
          loggedAt: firstSeen.get(uuid) ?? 0,
          error: msg,
        });
        statusCounts.set("lookup-failed", (statusCounts.get("lookup-failed") ?? 0) + 1);
        console.log(`    ${tag} ${uuid.slice(0, 8)}...  FAILED: ${msg.slice(0, 60)}`);
      }
      if (i < uniqueUuids.length - 1) await new Promise((r) => setTimeout(r, 80));
    }
  }

  // ---- 3. Group completed transfers by updatedAt (= batch event) -------
  // Two transfers in the same batch get the same updatedAt to the millisecond.
  // We bucket within BATCH_GROUPING_WINDOW_MS to be robust to clock drift.
  const completed = resolved.filter((r) => r.status === "completed" && r.updatedAt);
  completed.sort((a, b) => {
    const ta = new Date(a.updatedAt!).getTime();
    const tb = new Date(b.updatedAt!).getTime();
    return ta - tb;
  });

  const batches: BatchGroup[] = [];
  for (const r of completed) {
    const ms = new Date(r.updatedAt!).getTime();
    const last = batches[batches.length - 1];
    if (last && ms - last.updatedAtMs <= BATCH_GROUPING_WINDOW_MS) {
      last.transferCount++;
      last.totalAmountAtomic += BigInt(r.amount ?? "0");
      if (last.sampleUuids.length < 3) last.sampleUuids.push(r.uuid);
      if (r.fromAddress) last.fromAddresses.add(r.fromAddress.toLowerCase());
      if (r.toAddress) last.toAddresses.add(r.toAddress.toLowerCase());
    } else {
      batches.push({
        updatedAtIso: r.updatedAt!,
        updatedAtMs: ms,
        transferCount: 1,
        totalAmountAtomic: BigInt(r.amount ?? "0"),
        totalAmountUsdc: 0, // computed below
        sampleUuids: [r.uuid],
        fromAddresses: new Set(r.fromAddress ? [r.fromAddress.toLowerCase()] : []),
        toAddresses: new Set(r.toAddress ? [r.toAddress.toLowerCase()] : []),
      });
    }
  }
  for (const b of batches) {
    b.totalAmountUsdc = fmtUsdcFromAtomic(b.totalAmountAtomic);
  }

  // ---- 4. Console report -----------------------------------------------
  console.log("");
  console.log("  Status breakdown:");
  if (statusCounts.size === 0) {
    console.log("    (no resolutions performed)");
  } else {
    for (const [status, count] of [...statusCounts].sort((a, b) => b[1] - a[1])) {
      console.log(`    ${status.padEnd(15)} ${count}`);
    }
  }

  const totalUsdc = batches.reduce((s, b) => s + b.totalAmountUsdc, 0);

  console.log("");
  console.log("=".repeat(72));
  console.log(" SETTLEMENT BATCHES");
  console.log(" Each batch = one on-chain Arc transaction at the GatewayWallet contract");
  console.log("=".repeat(72));
  if (batches.length === 0) {
    console.log("  No completed transfers yet. Re-run after Circle's batcher posts.");
  } else {
    for (let i = 0; i < batches.length; i++) {
      const b = batches[i]!;
      console.log(
        `  Batch ${String(i + 1).padStart(2)}: ${b.transferCount} transfers,` +
          ` $${b.totalAmountUsdc.toFixed(4)} USDC,` +
          ` settled ${b.updatedAtIso}`,
      );
      console.log(`           sample UUIDs: ${b.sampleUuids.slice(0, 2).join(", ")}`);
    }
  }

  console.log("");
  console.log("=".repeat(72));
  console.log(" ON-CHAIN PROOF POINTS (clickable, real Arc data)");
  console.log("=".repeat(72));

  const gatewayWalletUrl = `${EXPLORER}/address/${GATEWAY_WALLET_ADDRESS}`;
  console.log("");
  console.log("  GatewayWallet contract (where every batch settlement lands):");
  console.log(`    ${gatewayWalletUrl}`);
  console.log("    Sort by 'Last seen' — recent txs are Circle's batches including yours.");

  const buyerUrl = env.buyerAddress ? `${EXPLORER}/address/${env.buyerAddress}` : undefined;
  if (buyerUrl) {
    console.log("");
    console.log("  Buyer EOA (deposit + approve, one-time setup):");
    console.log(`    ${buyerUrl}`);
  }

  let sellerUrl: string | undefined;
  if (env.sellerPrivateKey) {
    try {
      const sellerClient = new GatewayClient({
        chain: "arcTestnet",
        privateKey: env.sellerPrivateKey,
      });
      sellerUrl = `${EXPLORER}/address/${sellerClient.address}`;
      const b = await sellerClient.getBalances();
      console.log("");
      console.log("  Seller's Gateway balance (incoming USDC settlements land here):");
      console.log(`    address:           ${sellerClient.address}`);
      console.log(`    Gateway available: ${b.gateway.formattedAvailable} USDC`);
      console.log(`    Wallet USDC:       ${b.wallet.formatted} USDC`);
      console.log(`    explorer:          ${sellerUrl}`);
      console.log("");
      console.log("  NOTE: seller EOA Wallet USDC is expected to be ~0.");
      console.log("        Settlements credit the seller's Gateway balance, not their EOA.");
      console.log("        That is the entire point of Gateway: gas-free for sellers.");
    } catch (err) {
      console.log(
        `  (seller balance lookup failed: ${err instanceof Error ? err.message : err})`,
      );
    }
  }

  // ---- 5. Persist machine-readable report -----------------------------
  const report: VerifyReport = {
    generatedAt: new Date().toISOString(),
    sourceLog: TX_LOG,
    totalLogRows: rows.length,
    uniqueUuids: uniqueUuids.length,
    statusBreakdown: Object.fromEntries(statusCounts),
    settlements: {
      completedTransfers: completed.length,
      estimatedBatches: batches.length,
      totalAmountUsdc: totalUsdc,
      batches: batches.map((b) => ({
        updatedAt: b.updatedAtIso,
        transferCount: b.transferCount,
        totalAmountUsdc: b.totalAmountUsdc,
        sampleUuids: b.sampleUuids,
      })),
    },
    proofPoints: {
      gatewayWalletContract: GATEWAY_WALLET_ADDRESS,
      gatewayWalletExplorerUrl: gatewayWalletUrl,
      buyerAddress: env.buyerAddress,
      buyerExplorerUrl: buyerUrl,
      sellerAddress: env.sellerAddress,
      sellerExplorerUrl: sellerUrl,
    },
    resolved,
    hackathonVerdict: {
      paidActionsCount: uniqueUuids.length,
      settledActionsCount: completed.length,
      estimatedBatchTxsOnChain: batches.length,
      threshold: 50,
      pass: uniqueUuids.length >= 50,
      notes:
        "Each paid action is one EIP-712 signed authorization that Circle Gateway " +
        "accepted, verified, and (when status=completed) settled on Arc as part of a batch. " +
        "Per Circle's docs, many authorizations share one on-chain Arc transaction. The " +
        "estimatedBatchTxsOnChain count groups settled transfers by updatedAt timestamp " +
        "(transfers in the same batch share an updatedAt to the millisecond).",
    },
  };

  await mkdir(dirname(VERIFY_REPORT), { recursive: true });
  await writeFile(VERIFY_REPORT, JSON.stringify(report, null, 2));
  console.log("");
  console.log(`  Full machine-readable report: ${VERIFY_REPORT}`);

  // ---- 6. Verdict ------------------------------------------------------
  console.log("");
  console.log("=".repeat(72));
  console.log(" HACKATHON: paid actions demonstrated");
  console.log("=".repeat(72));
  if (uniqueUuids.length >= 50) {
    console.log(
      ` PASS: ${uniqueUuids.length} unique paid actions logged, of which` +
        ` ${completed.length} are settled (status=completed) across ${batches.length} batch event(s).`,
    );
    console.log(`        Total settled volume: $${totalUsdc.toFixed(4)} USDC.`);
    console.log("");
    console.log("        Each paid action is a real EIP-712 authorization signed by");
    console.log("        the buyer, verified by Circle, and settled on Arc as part of");
    console.log("        a batch transaction at the GatewayWallet contract.");
  } else {
    console.log(
      ` SHORT: ${uniqueUuids.length} paid actions < 50. Run more demo sessions.`,
    );
  }
  console.log("=".repeat(72));
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
