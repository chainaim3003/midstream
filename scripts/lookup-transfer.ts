// scripts/lookup-transfer.ts
//
// Resolve a Circle Transfer UUID to its full record via the Gateway API.
// This proves the UUIDs from our payment ledger are real Circle Gateway
// transfers, not mocks — and shows the settlement lifecycle
// (received → batched → confirmed → completed).
//
// Usage:
//   npm run lookup-transfer -- <uuid>
//   e.g.
//   npm run lookup-transfer -- f76d8ba8-0250-4ec2-af35-2dff9206aaea
//
// You can also pass `--search` with no UUID to list recent transfers to
// the seller address (proves on-chain settlements are landing there):
//   npm run lookup-transfer -- --search
//
// The endpoint is the official Circle Gateway API, same one the SDK calls
// internally — see node_modules/@circle-fin/x402-batching/dist/client/index.mjs
// for the verbatim GET URL and response shape.

import { Buyer } from "../client/buyer.js";
import { TextQualityMonitor } from "../client/quality/text-monitor.js";
import { env, requireBuyerEnv } from "../shared/config.js";

requireBuyerEnv();

const arg = process.argv[2];
if (!arg) {
  console.error("Usage:");
  console.error("  npm run lookup-transfer -- <uuid>");
  console.error("  npm run lookup-transfer -- --search [sellerAddress]");
  process.exit(1);
}

// We don't actually run the monitor — just need a Buyer instance for the
// Gateway client. Gemini key is still required by the monitor constructor.
const monitor = new TextQualityMonitor(env.geminiApiKey!, env.geminiModel);
const buyer = new Buyer({ privateKey: env.buyerPrivateKey!, monitor });

if (arg === "--search") {
  const sellerAddress = (process.argv[3] ?? env.sellerAddress) as `0x${string}` | undefined;
  if (!sellerAddress) {
    console.error("No seller address. Pass one after --search or set SELLER_ADDRESS in .env.local.");
    process.exit(1);
  }
  console.log(`Searching Circle Gateway for transfers TO ${sellerAddress}`);
  console.log(`(network: eip155:5042002 — Arc testnet)\n`);
  const result = await buyer.searchTransfers({ to: sellerAddress, pageSize: 50 });
  const list = result.transfers ?? [];
  console.log(`Got ${list.length} transfers.\n`);
  for (const t of list.slice(0, 20)) {
    console.log(JSON.stringify(t, null, 2));
    console.log("---");
  }
  if (list.length > 20) console.log(`... and ${list.length - 20} more.`);
  process.exit(0);
}

// Single-ID lookup
const id = arg;
console.log(`Looking up Circle transfer ${id}…\n`);
try {
  const record = await buyer.lookupTransfer(id);
  console.log(JSON.stringify(record, null, 2));
  console.log();

  // Highlight the two things the user cares about.
  const status = (record as { status?: string }).status;
  console.log(`Status:  ${status ?? "(none)"}`);

  // Circle's Transfer object may include fields indicating on-chain tx hash
  // once the transfer has been confirmed. We don't hardcode a field name —
  // we log every 0x-looking value we find at top level so any on-chain hash
  // in the response is visible regardless of the exact key Circle uses.
  const hashLike: Array<[string, string]> = [];
  for (const [k, v] of Object.entries(record)) {
    if (typeof v === "string" && /^0x[0-9a-fA-F]{64}$/.test(v)) {
      hashLike.push([k, v]);
    }
  }
  if (hashLike.length > 0) {
    console.log(`On-chain 0x-prefixed hashes in this response:`);
    for (const [k, v] of hashLike) {
      console.log(`  ${k}: ${v}`);
      console.log(`    → ${env.arcBlockExplorerUrl}/tx/${v}`);
    }
  } else {
    console.log(
      `No on-chain tx hash in the response yet. Status "${status ?? "?"}" ` +
      `means the settlement has not been posted on Arc yet. ` +
      `This is normal for "received" / "batched" statuses; Circle posts the ` +
      `batch settlement to Arc once it confirms.`,
    );
  }
} catch (err) {
  console.error(`Lookup failed: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(2);
}
