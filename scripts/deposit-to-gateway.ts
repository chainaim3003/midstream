// scripts/deposit-to-gateway.ts
//
// Deposits USDC from the buyer's EOA into Circle's Gateway Wallet on Arc
// testnet using the official @circle-fin/x402-batching SDK.
//
// This is the gate-1 validation: if this runs end-to-end and we see a
// successful deposit tx on https://testnet.arcscan.app, the whole Circle
// Gateway stack is working for this wallet.
//
// What this script does:
//   1. Loads BUYER_PRIVATE_KEY from .env.local.
//   2. Creates a GatewayClient pointed at Arc testnet.
//   3. Reads current wallet USDC and current Gateway balance.
//   4. If Gateway balance is already sufficient, exits without spending.
//   5. Otherwise calls client.deposit(amountString). The SDK handles
//      approve + deposit internally and returns the final tx hash.
//   6. Re-reads Gateway balance to confirm credit.
//
// No hand-rolled ABI. No approve/deposit two-step. No guess at contract
// function selectors. The SDK is the ground truth for how Gateway deposits
// work. This matches how agentswarm/src/orchestrator.ts does it, which is
// verified shipping code on Arc testnet as of March 2026.
//
// No mocks. No fallbacks. If Circle's API is unreachable or the wallet is
// underfunded, the script exits non-zero with the real error.
//
// Usage:
//   npx tsx scripts/deposit-to-gateway.ts <amount-in-usdc>
//   npx tsx scripts/deposit-to-gateway.ts 5

import { config as loadDotenv } from "dotenv";
import { GatewayClient } from "@circle-fin/x402-batching/client";

loadDotenv({ path: ".env.local" });

// --- Step 0: parse args + env ---------------------------------------------

const amountArg = process.argv[2];
if (!amountArg || !/^\d+(\.\d{1,6})?$/.test(amountArg)) {
  console.error("Usage: npx tsx scripts/deposit-to-gateway.ts <amount-in-usdc>");
  console.error("");
  console.error("Example: npx tsx scripts/deposit-to-gateway.ts 5");
  console.error("");
  console.error("Amount must be positive and have at most 6 decimal places.");
  process.exit(2);
}

function requireEnv(key: string): string {
  const v = process.env[key];
  if (!v || v.trim() === "") {
    console.error(`❌ missing required env var ${key} in .env.local`);
    console.error("   Run: npx tsx scripts/generate-wallets.ts");
    process.exit(1);
  }
  return v.trim();
}

const BUYER_PRIVATE_KEY = requireEnv("BUYER_PRIVATE_KEY");

if (!/^0x[a-fA-F0-9]{64}$/.test(BUYER_PRIVATE_KEY)) {
  console.error("❌ BUYER_PRIVATE_KEY is not a 0x-prefixed 64-hex string");
  process.exit(1);
}

// Explorer URL is optional — used only for display. Hardcoded default is
// fine here since it's display-only and doesn't affect the transaction.
const ARC_BLOCK_EXPLORER_URL =
  process.env.ARC_BLOCK_EXPLORER_URL?.trim() || "https://testnet.arcscan.app";

// --- Step 1: create GatewayClient -----------------------------------------
//
// The SDK takes a chain name ("arcTestnet") and a private key. It handles
// everything else internally: RPC URL, chain ID, USDC contract address,
// Gateway Wallet contract address, EIP-712 domain, signing. We do not pass
// any of that and we do not hardcode any of it. Single source of truth.

const client = new GatewayClient({
  chain: "arcTestnet",
  privateKey: BUYER_PRIVATE_KEY as `0x${string}`,
});

console.log("━".repeat(72));
console.log("Circle Gateway deposit on Arc testnet");
console.log("━".repeat(72));
console.log(`  Buyer address:     ${client.address}`);
console.log(`  Amount to deposit: ${amountArg} USDC`);
console.log("");

// --- Step 2: read current balances ----------------------------------------

let balances;
try {
  balances = await client.getBalances();
} catch (err) {
  console.error("❌ Failed to read balances from Circle Gateway API.");
  console.error(`   ${err instanceof Error ? err.message : String(err)}`);
  console.error("");
  console.error("   Possible causes:");
  console.error("   - Arc RPC is unreachable");
  console.error("   - Circle Gateway API is unreachable");
  console.error("   - BUYER_PRIVATE_KEY is malformed");
  process.exit(1);
}

console.log(`✔ Wallet USDC:      ${balances.wallet.formatted} USDC`);
console.log(`✔ Gateway available: ${balances.gateway.formattedAvailable} USDC`);
console.log("");

// The SDK returns `available` as a bigint in 6-decimal atomic units (same as USDC).
// Convert the amount arg to atomic units for comparison.
const requestedAtomic = BigInt(Math.round(Number(amountArg) * 1_000_000));

// --- Step 3: skip if already sufficient -----------------------------------

if (balances.gateway.available >= requestedAtomic) {
  console.log("✔ Gateway balance already >= requested amount. Nothing to do.");
  console.log("");
  console.log("If you want to force another deposit anyway, run:");
  console.log(`  npx tsx scripts/deposit-to-gateway.ts ${amountArg} --force`);
  // --force is not yet implemented; printed as a hint for future work.
  process.exit(0);
}

// --- Step 4: check wallet has enough USDC ---------------------------------

if (balances.wallet.raw < requestedAtomic) {
  console.error("");
  console.error("❌ Insufficient USDC in wallet.");
  console.error(`   Have: ${balances.wallet.formatted} USDC`);
  console.error(`   Need: ${amountArg} USDC (plus a small amount for gas)`);
  console.error("");
  console.error(`   Fund ${client.address} at https://faucet.circle.com/`);
  console.error("   (Arc testnet: 20 USDC per 2 hours per address.)");
  process.exit(1);
}

// --- Step 5: deposit via SDK ----------------------------------------------
//
// This single call does approve + deposit under the hood. The SDK knows the
// Gateway Wallet contract ABI, correct function selectors, and returns the
// deposit tx hash after confirmation. This is exactly how agentswarm does it
// in src/orchestrator.ts `ensureDeposit()` and src/index.ts for the circular
// economy deposits.

console.log(`→ Calling client.deposit("${amountArg}")…`);
console.log("  (SDK handles approve + deposit internally)");
console.log("");

let deposit;
try {
  deposit = await client.deposit(amountArg);
} catch (err) {
  console.error("❌ Deposit failed.");
  console.error(`   ${err instanceof Error ? err.message : String(err)}`);
  console.error("");
  console.error("   Possible causes:");
  console.error("   - Circle Gateway API down / rate limited");
  console.error("   - Arc RPC down");
  console.error("   - Transaction reverted (check the error message above)");
  process.exit(1);
}

console.log(`✔ deposit confirmed`);
console.log(`  tx hash:  ${deposit.depositTxHash}`);
console.log(`  explorer: ${ARC_BLOCK_EXPLORER_URL}/tx/${deposit.depositTxHash}`);
console.log("");

// --- Step 6: verify via fresh balance read --------------------------------

const post = await client.getBalances();

console.log("━".repeat(72));
console.log("✅ Deposit complete");
console.log("━".repeat(72));
console.log(`  Wallet USDC before:  ${balances.wallet.formatted}`);
console.log(`  Wallet USDC after:   ${post.wallet.formatted}`);
console.log(`  Gateway before:      ${balances.gateway.formattedAvailable}`);
console.log(`  Gateway after:       ${post.gateway.formattedAvailable}`);
console.log("");
console.log("Screenshot this transaction for your SUBMISSION.md:");
console.log(`  ${ARC_BLOCK_EXPLORER_URL}/tx/${deposit.depositTxHash}`);
console.log("━".repeat(72));
