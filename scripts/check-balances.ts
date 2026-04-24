// scripts/check-balances.ts
//
// Prints wallet-level and Gateway-level USDC balances for whichever of
// BUYER/SELLER are configured in .env.local.
//
// Wallet USDC is read via GatewayClient (which knows the chain internally).
// Gateway balance (available for nanopayments) is read via the same client.
//
// No mocks. Exits non-zero if env is missing or the Circle API is unreachable.
//
// Usage:
//   npx tsx scripts/check-balances.ts

import { config as loadDotenv } from "dotenv";
import { GatewayClient } from "@circle-fin/x402-batching/client";

loadDotenv({ path: ".env.local" });

function maybe(key: string): string | undefined {
  const v = process.env[key];
  return v && v.trim() !== "" ? v.trim() : undefined;
}

const BUYER_PRIVATE_KEY = maybe("BUYER_PRIVATE_KEY");
const SELLER_PRIVATE_KEY = maybe("SELLER_PRIVATE_KEY");
const EXPLORER =
  maybe("ARC_BLOCK_EXPLORER_URL") || "https://testnet.arcscan.app";

if (!BUYER_PRIVATE_KEY && !SELLER_PRIVATE_KEY) {
  console.error(
    "❌ Neither BUYER_PRIVATE_KEY nor SELLER_PRIVATE_KEY is set in .env.local.",
  );
  console.error("   Run: npx tsx scripts/generate-wallets.ts");
  process.exit(1);
}

console.log("━".repeat(72));
console.log("Arc testnet balances (via @circle-fin/x402-batching/client)");
console.log("━".repeat(72));

async function showFor(label: string, privateKey: string) {
  const client = new GatewayClient({
    chain: "arcTestnet",
    privateKey: privateKey as `0x${string}`,
  });

  let balances;
  try {
    balances = await client.getBalances();
  } catch (err) {
    console.log(`  ${label.padEnd(8)} ${client.address}`);
    console.log(
      `           ❌ failed to read: ${err instanceof Error ? err.message : String(err)}`,
    );
    console.log("");
    return;
  }

  console.log(`  ${label.padEnd(8)} ${client.address}`);
  console.log(`           Wallet USDC:       ${balances.wallet.formatted}`);
  console.log(`           Gateway available: ${balances.gateway.formattedAvailable}`);
  console.log(`           ${EXPLORER}/address/${client.address}`);
  console.log("");
}

if (BUYER_PRIVATE_KEY) await showFor("Buyer:", BUYER_PRIVATE_KEY);
if (SELLER_PRIVATE_KEY) await showFor("Seller:", SELLER_PRIVATE_KEY);

console.log("━".repeat(72));
console.log("Wallet USDC = on-chain ERC-20 balance on Arc.");
console.log("Gateway available = balance inside Circle's nanopayment ledger,");
console.log("                    usable without gas for sub-cent payments.");
console.log("━".repeat(72));
