// scripts/verify-onchain.ts
//
// Reads logs/tx-log.jsonl (written during npm run demo), counts unique
// Gateway transaction ids, and prints a compact summary suitable for the
// hackathon submission evidence.
//
// Hackathon requirement: ≥ 50 on-chain transactions demonstrated.
//
// The tx-log.jsonl is append-only; every paid chunk across every demo run
// writes one line. This script reads the whole file, dedupes, and prints.
// It also tries to read the seller's Gateway balance via GatewayClient —
// that's the complementary proof (money actually arrived on the seller side).
//
// Usage:
//   npm run verify-onchain

import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { GatewayClient } from "@circle-fin/x402-batching/client";
import { env } from "../shared/config.js";

const TX_LOG = join(process.cwd(), "logs", "tx-log.jsonl");
const EXPLORER = env.arcBlockExplorerUrl;

interface TxRow {
  sessionId: string;
  chunkIndex: number;
  transaction: string;
  ts: number;
}

async function main() {
  // --- 1. Read the tx log ----------------------------------------------
  let raw: string;
  try {
    raw = await readFile(TX_LOG, "utf-8");
  } catch {
    console.error(`❌ ${TX_LOG} not found.`);
    console.error(`   Run 'npm run demo' first to generate it.`);
    process.exit(1);
  }

  const rows: TxRow[] = raw
    .split("\n")
    .filter((l) => l.trim() !== "")
    .map((l, i) => {
      try {
        return JSON.parse(l) as TxRow;
      } catch {
        console.error(`⚠  line ${i + 1} of tx-log.jsonl is malformed; skipping`);
        return null;
      }
    })
    .filter((r): r is TxRow => r !== null);

  // Dedupe by transaction id. Multiple chunks can appear in the same batched
  // settlement so the same tx hash may repeat — we count unique tx ids.
  const unique = new Map<string, TxRow>();
  for (const r of rows) unique.set(r.transaction, r);
  const uniqueCount = unique.size;

  // Session breakdown
  const bySession = new Map<string, number>();
  for (const r of rows) bySession.set(r.sessionId, (bySession.get(r.sessionId) ?? 0) + 1);

  console.log("━".repeat(72));
  console.log(" Midstream — on-chain verification");
  console.log("━".repeat(72));
  console.log(`  log file:             ${TX_LOG}`);
  console.log(`  log rows (paid chunks): ${rows.length}`);
  console.log(`  unique transactions:  ${uniqueCount}`);
  console.log(`  sessions:             ${bySession.size}`);
  console.log("");

  for (const [sid, count] of bySession) {
    console.log(`    ${sid.slice(0, 8)} — ${count} paid chunks`);
  }
  console.log("");

  // --- 2. Sample: first 5 + last 5 tx with explorer URLs ----------------
  const sample = [...unique.values()].slice(0, 5);
  const tail = [...unique.values()].slice(-5);
  console.log("  First 5 tx:");
  for (const r of sample) {
    console.log(`    ${r.transaction}`);
    console.log(`      ${EXPLORER}/tx/${r.transaction}`);
  }
  if (uniqueCount > 10) {
    console.log("  …");
    console.log("  Last 5 tx:");
    for (const r of tail) {
      console.log(`    ${r.transaction}`);
      console.log(`      ${EXPLORER}/tx/${r.transaction}`);
    }
  }
  console.log("");

  // --- 3. Seller Gateway balance (complementary proof) ------------------
  if (env.sellerPrivateKey) {
    try {
      const sellerClient = new GatewayClient({
        chain: "arcTestnet",
        privateKey: env.sellerPrivateKey,
      });
      const b = await sellerClient.getBalances();
      console.log(`  Seller Gateway balance: ${b.gateway.formattedAvailable} USDC`);
      console.log(`  Seller wallet USDC:     ${b.wallet.formatted} USDC`);
      console.log(`    seller address: ${sellerClient.address}`);
      console.log(`    ${EXPLORER}/address/${sellerClient.address}`);
    } catch (err) {
      console.log(`  (could not read seller balance: ${err instanceof Error ? err.message : err})`);
    }
  }

  // --- 4. Verdict --------------------------------------------------------
  console.log("");
  console.log("━".repeat(72));
  if (uniqueCount >= 50) {
    console.log(` ✅ PASS — ${uniqueCount} unique transactions ≥ 50 (hackathon requirement)`);
  } else {
    console.log(` ❌ SHORT — ${uniqueCount} unique transactions < 50`);
    console.log(`    Run 'npm run demo' again (additional sessions append to the log).`);
  }
  console.log("━".repeat(72));
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
