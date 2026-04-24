// shared/config.ts
//
// Typed env loader. Reads .env.local once at startup. Fails loudly on missing
// required values. No hardcoded chain addresses here — the Circle SDK knows
// Arc testnet's RPC URL, USDC contract, and Gateway Wallet address internally
// when given `chain: "arcTestnet"`.
//
// This file is imported by server/seller.ts, web-server/index.ts, and the
// demo script. Scripts that only need one or two env vars (generate-wallets,
// deposit-to-gateway, check-balances) do their own minimal reads to stay
// runnable even when other env vars are missing.

import { config as loadDotenv } from "dotenv";

loadDotenv({ path: ".env.local" });

// ---------------------------------------------------------------------------
// Tiny validation helpers (avoids a zod dep for this one file).
// ---------------------------------------------------------------------------

function req(key: string): string {
  const v = process.env[key];
  if (!v || v.trim() === "") {
    console.error(`❌ missing required env var ${key} in .env.local`);
    process.exit(1);
  }
  return v.trim();
}

function opt(key: string): string | undefined {
  const v = process.env[key];
  return v && v.trim() !== "" ? v.trim() : undefined;
}

function numReq(key: string): number {
  const s = req(key);
  const n = Number(s);
  if (!Number.isFinite(n)) {
    console.error(`❌ env var ${key} is not a valid number: ${s}`);
    process.exit(1);
  }
  return n;
}

function numOpt(key: string, fallback: number): number {
  const s = opt(key);
  if (s === undefined) return fallback;
  const n = Number(s);
  if (!Number.isFinite(n)) {
    console.error(`❌ env var ${key} is not a valid number: ${s}`);
    process.exit(1);
  }
  return n;
}

function intOpt(key: string, fallback: number): number {
  const n = numOpt(key, fallback);
  return Math.trunc(n);
}

function hexOpt(key: string): `0x${string}` | undefined {
  const v = opt(key);
  if (!v) return undefined;
  if (!/^0x[a-fA-F0-9]+$/.test(v)) {
    console.error(`❌ env var ${key} is not a valid 0x hex string: ${v}`);
    process.exit(1);
  }
  return v as `0x${string}`;
}

function privateKeyOpt(key: string): `0x${string}` | undefined {
  const v = hexOpt(key);
  if (!v) return undefined;
  if (!/^0x[a-fA-F0-9]{64}$/.test(v)) {
    console.error(`❌ env var ${key} is not a 0x-prefixed 64-hex private key`);
    process.exit(1);
  }
  return v;
}

// ---------------------------------------------------------------------------
// Exported config snapshot
// ---------------------------------------------------------------------------
//
// Every caller that imports this module gets the same object. Values are
// read once at module load. If env changes at runtime (rare), restart.

export const env = {
  // Wallets — optional at load time because scripts/generate-wallets.ts writes
  // them after load. Server and buyer code must check before use.
  buyerPrivateKey: privateKeyOpt("BUYER_PRIVATE_KEY"),
  buyerAddress: hexOpt("BUYER_ADDRESS"),
  sellerPrivateKey: privateKeyOpt("SELLER_PRIVATE_KEY"),
  sellerAddress: hexOpt("SELLER_ADDRESS"),

  // LLM providers
  anthropicApiKey: opt("ANTHROPIC_API_KEY"),
  anthropicModel: opt("ANTHROPIC_MODEL") ?? "claude-3-5-haiku-20241022",
  geminiApiKey: opt("GEMINI_API_KEY"),
  geminiModel: opt("GEMINI_MODEL") ?? "gemini-2.5-flash",

  // Explorer — display-only.
  arcBlockExplorerUrl: opt("ARC_BLOCK_EXPLORER_URL") ?? "https://testnet.arcscan.app",

  // Ports
  sellerPort: intOpt("SELLER_PORT", 3000),
  webServerPort: intOpt("WEB_SERVER_PORT", 3001),

  // Defaults (overridable per-session from the UI)
  pricePerChunkUsdc: numOpt("PRICE_PER_CHUNK_USDC", 0.0005),
  chunkSizeTokens: intOpt("CHUNK_SIZE_TOKENS", 32),
  maxTokensPerSession: intOpt("MAX_TOKENS_PER_SESSION", 1000),
  buyerMaxSpendUsdc: numOpt("BUYER_MAX_SPEND_USDC", 1.0),
  qualityThreshold: numOpt("QUALITY_THRESHOLD", 0.6),
  rollingWindowSize: intOpt("ROLLING_WINDOW_SIZE", 3),
  warmupChunks: intOpt("WARMUP_CHUNKS", 2),
  sessionIdleTimeoutSeconds: intOpt("SESSION_IDLE_TIMEOUT_SECONDS", 60),
} as const;

// ---------------------------------------------------------------------------
// Enforcement helpers — call these at the entry point of each process that
// needs specific env vars. This keeps the burden close to the usage and
// keeps `shared/config.ts` importable from scripts that don't need everything.
// ---------------------------------------------------------------------------

export function requireSellerEnv(): asserts env is typeof env & {
  sellerPrivateKey: `0x${string}`;
  sellerAddress: `0x${string}`;
  anthropicApiKey: string;
} {
  if (!env.sellerPrivateKey) bail("SELLER_PRIVATE_KEY");
  if (!env.sellerAddress) bail("SELLER_ADDRESS");
  if (!env.anthropicApiKey) bail("ANTHROPIC_API_KEY");
  // Hackathon rule: per-action price ≤ $0.01.
  if (env.pricePerChunkUsdc > 0.01) {
    console.error(
      `❌ PRICE_PER_CHUNK_USDC=${env.pricePerChunkUsdc} violates hackathon cap of $0.01 per action`,
    );
    process.exit(1);
  }
}

export function requireBuyerEnv(): asserts env is typeof env & {
  buyerPrivateKey: `0x${string}`;
  buyerAddress: `0x${string}`;
  geminiApiKey: string;
} {
  if (!env.buyerPrivateKey) bail("BUYER_PRIVATE_KEY");
  if (!env.buyerAddress) bail("BUYER_ADDRESS");
  if (!env.geminiApiKey) bail("GEMINI_API_KEY");
}

function bail(key: string): never {
  console.error(`❌ missing required env var ${key} in .env.local`);
  console.error("   see .env.example for the full list");
  process.exit(1);
}
