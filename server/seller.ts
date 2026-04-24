// server/seller.ts
//
// Midstream seller. One Express app, mounts all paid chunk routes with a
// single createGatewayMiddleware factory. This is the exact pattern from
// agentswarm/src/agents.ts and agentswarm/src/index.ts.
//
// Usage:
//   npm run seller
//
// The server is stateless across chunks. Each POST /chunk/{text|code} is a
// standalone request with its own payment and its own Anthropic call. The
// buyer tracks cumulative text and sends it back each time. This keeps the
// server simple and lets multiple buyers use it concurrently without any
// per-session state on the server side.

import express from "express";
import { createGatewayMiddleware } from "@circle-fin/x402-batching/server";
import { privateKeyToAccount } from "viem/accounts";
import { env, requireSellerEnv } from "../shared/config.js";
import { mountTextChunk } from "./routes/text-chunk.js";
import { mountCodeChunk } from "./routes/code-chunk.js";

// Require seller env: SELLER_PRIVATE_KEY, SELLER_ADDRESS, ANTHROPIC_API_KEY,
// and enforces price-per-chunk <= $0.01 (hackathon rule).
requireSellerEnv();

const app = express();
app.use(express.json({ limit: "1mb" }));

const sellerAccount = privateKeyToAccount(env.sellerPrivateKey!);
const sellerAddress = sellerAccount.address;

// Sanity check: the private key's derived address should match the declared
// SELLER_ADDRESS in .env.local. Otherwise the seller would receive payments
// at a different address than the one users think they're paying.
if (env.sellerAddress && env.sellerAddress.toLowerCase() !== sellerAddress.toLowerCase()) {
  console.error(
    `❌ SELLER_ADDRESS in .env.local (${env.sellerAddress}) ` +
    `does not match address derived from SELLER_PRIVATE_KEY (${sellerAddress}).`,
  );
  console.error("   Fix .env.local or regenerate wallets.");
  process.exit(1);
}

// One middleware factory, reused by every paid route. The SDK knows Arc
// testnet internally from the `networks: ["eip155:5042002"]` option.
const gateway = createGatewayMiddleware({
  sellerAddress,
  networks: ["eip155:5042002"],
});

// --- Free routes ---------------------------------------------------------

app.get("/health", (_req, res) => {
  res.json({
    status: "ok",
    sellerAddress,
    chain: "arcTestnet",
    paidRoutes: ["/chunk/text", "/chunk/code"],
  });
});

app.get("/info", (_req, res) => {
  res.json({
    name: "Midstream seller",
    tagline: "Pay for outcomes, not tokens.",
    sellerAddress,
    pricePerChunkUsdc: env.pricePerChunkUsdc,
    chunkSizeTokens: env.chunkSizeTokens,
    maxTokensPerSession: env.maxTokensPerSession,
    anthropicModel: env.anthropicModel,
  });
});

// --- Paid routes ---------------------------------------------------------

console.log("━".repeat(70));
console.log("Midstream seller — routes:");
console.log("  GET  /health");
console.log("  GET  /info");
mountTextChunk(app, gateway);
mountCodeChunk(app, gateway);
console.log("━".repeat(70));

// --- Listen --------------------------------------------------------------

app.listen(env.sellerPort, () => {
  console.log(`🟢 Midstream seller listening on :${env.sellerPort}`);
  console.log(`   address:          ${sellerAddress}`);
  console.log(`   price per chunk:  $${env.pricePerChunkUsdc.toFixed(4)} USDC`);
  console.log(`   chunk size:       ${env.chunkSizeTokens} tokens`);
  console.log(`   Anthropic model:  ${env.anthropicModel}`);
  console.log(``);
  console.log(`   Try:  curl http://localhost:${env.sellerPort}/info`);
  console.log("━".repeat(70));
});
