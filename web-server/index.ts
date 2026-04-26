// web-server/index.ts
//
// Dashboard HTTP + SSE bridge for Midstream.
//
// Architecture:
//   - One Buyer instance, one SessionRegistry. Shared across sessions.
//   - Browser POSTs /api/sessions with {useCase, prompt}. We kick off
//     buyer.runSession in the background and return {sessionId}.
//   - Browser opens EventSource to /api/sessions/:id/events. We subscribe
//     to the matching SessionBus and forward every event as SSE.
//   - Browser polls /api/status for aggregate totals.
//   - Browser calls /api/transfers/:id to resolve a Circle Transfer UUID
//     to its full record (status + on-chain settlement hash, if available).
//     Powered by GatewayClient.getTransferById in the SDK.
//   - Browser calls /api/transfers-to-seller to list real on-chain
//     settlements that have reached the seller address. Powered by
//     GatewayClient.searchTransfers({ to: sellerAddress }).
//
// IMPORTANT about the UUIDs in the payment ledger:
//   They are Circle Transfer IDs, NOT on-chain tx hashes. Circle batches
//   many off-chain authorizations into a single on-chain settlement tx on
//   Arc. The UI must label them as "Transfer ID" (not "Arc tx") and expose
//   the resolve flow so users can follow a UUID to its settlement status
//   and the actual 0x-prefixed tx hash once Circle confirms.
//
// Nothing is mocked. Every number comes from the real pipeline.

import express from "express";
import type { Request, Response, NextFunction } from "express";
import { randomUUID } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

import { Buyer } from "../client/buyer.js";
import { TextQualityMonitor } from "../client/quality/text-monitor.js";
import { CodeQualityMonitor } from "../client/quality/code-monitor.js";
import { SessionBus, SessionRegistry } from "../shared/session-bus.js";
import type { QualityMonitor, SessionOptions, SessionResult } from "../shared/types.js";
import { env, requireBuyerEnv } from "../shared/config.js";

requireBuyerEnv();

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const PUBLIC_DIR = join(__dirname, "public");

// Seller URL resolution:
//   - In production (Railway / Fly / Render), the seller is a separate
//     service with its own public https URL. Set SELLER_BASE_URL on the
//     web-server to that URL.
//   - For local dev, leave SELLER_BASE_URL unset and we default to the
//     localhost form using SELLER_PORT.
//
// We strip any trailing slash so downstream URL building stays predictable.
const SELLER_URL = (env.sellerBaseUrl ?? `http://localhost:${env.sellerPort}`).replace(/\/$/, "");
const GEMINI_MAX_COST_USD = Number(process.env.GEMINI_MAX_COST_USD ?? "1.0");

// ---------------------------------------------------------------------------
// Shared state
// ---------------------------------------------------------------------------

const textMonitor = new TextQualityMonitor(env.geminiApiKey!, env.geminiModel);
const codeMonitor = new CodeQualityMonitor();
const buyer = new Buyer({
  privateKey: env.buyerPrivateKey!,
  monitor: textMonitor,
});

const registry = new SessionRegistry({ completedTtlMs: 60 * 60 * 1000 });
registry.startReaper();

interface SessionMeta {
  id: string;
  useCase: "text" | "code";
  prompt: string;
  startedAt: number;
  endedAt: number | null;
  result: SessionResult | null;
}
const sessionMeta = new Map<string, SessionMeta>();

let busyLock: Promise<unknown> | null = null;

// Small in-memory cache of transfer lookups. Circle's API is slow-ish
// (100-300ms per call) and transfers are immutable until they progress
// through the status lifecycle — cache until the entry is ≥ 30s old AND
// status is not "completed".
interface CacheEntry {
  at: number;
  record: Record<string, unknown>;
}
const transferCache = new Map<string, CacheEntry>();

// Cache buyer balance to avoid hitting Circle's API + Arc RPC on every
// /api/status poll. Balances change as Circle's batcher settles
// authorizations, but at most every few seconds — a 4s TTL is plenty fresh.
interface BalanceCacheEntry {
  at: number;
  data: Awaited<ReturnType<typeof buyer.getBalances>>;
  cached: boolean;
}
let balanceCache: BalanceCacheEntry | null = null;
const BALANCE_TTL_MS = 4_000;

async function getBuyerBalancesCached(): Promise<
  | { data: BalanceCacheEntry["data"]; cached: boolean; ageMs: number; error?: undefined }
  | { data: null; cached: false; ageMs: 0; error: string }
> {
  const now = Date.now();
  if (balanceCache && now - balanceCache.at < BALANCE_TTL_MS) {
    return { data: balanceCache.data, cached: true, ageMs: now - balanceCache.at };
  }
  try {
    const data = await buyer.getBalances();
    balanceCache = { at: now, data, cached: false };
    return { data, cached: false, ageMs: 0 };
  } catch (err) {
    if (balanceCache) {
      // Serve stale on transient API hiccups rather than crashing the dashboard.
      return {
        data: balanceCache.data,
        cached: true,
        ageMs: now - balanceCache.at,
      };
    }
    return { data: null, cached: false, ageMs: 0, error: err instanceof Error ? err.message : String(err) };
  }
}

// ---------------------------------------------------------------------------
// Demo-key middleware
// ---------------------------------------------------------------------------
//
// Gates endpoints that spend real money or do irreversible on-chain work.
// Currently only /api/evidence/produce qualifies — that endpoint calls
// GatewayClient.deposit() N times (capped at 20 per call) and each deposit
// is a real on-chain Arc tx that drains testnet USDC from the buyer's EOA
// into their Gateway balance.
//
// Behaviour:
//   - If env.demoKey is unset (local dev): middleware is a no-op, endpoint
//     stays open. The same as before this change.
//   - If env.demoKey is set: requests must include header
//     `X-Demo-Key: <value>` matching env.demoKey, otherwise 401.
//
// We deliberately do NOT gate /api/sessions. Worst case there is bounded
// (single-tenant busyLock + GEMINI_MAX_COST_USD cap) and gating it would
// also break the dashboard's primary CTA without any reciprocal change to
// public/index.html. If you decide to gate it later, the same middleware
// applies — just add `requireDemoKey` to that route.

function requireDemoKey(req: Request, res: Response, next: NextFunction): void {
  if (!env.demoKey) {
    // Local dev: no key configured, endpoint is open.
    next();
    return;
  }
  const provided = req.header("x-demo-key");
  if (provided !== env.demoKey) {
    res.status(401).json({
      error:
        "this endpoint is protected; pass the shared secret via the X-Demo-Key header",
    });
    return;
  }
  next();
}

// ---------------------------------------------------------------------------
// Express app
// ---------------------------------------------------------------------------

const app = express();
app.use(express.json({ limit: "1mb" }));
app.use(express.static(PUBLIC_DIR));

app.get("/api/health", async (_req, res) => {
  let sellerOk = false;
  try {
    const r = await fetch(`${SELLER_URL}/health`, { signal: AbortSignal.timeout(3000) });
    sellerOk = r.ok;
  } catch {
    sellerOk = false;
  }

  res.json({
    status: "ok",
    sellerReachable: sellerOk,
    sellerUrl: SELLER_URL,
    buyerAddress: buyer.address,
    sellerAddress: env.sellerAddress ?? null,
    chain: "arcTestnet",
    explorer: env.arcBlockExplorerUrl,
    pricePerChunkUsdc: env.pricePerChunkUsdc,
    chunkSizeTokens: env.chunkSizeTokens,
    maxTokensPerSession: env.maxTokensPerSession,
    qualityThreshold: env.qualityThreshold,
    warmupChunks: env.warmupChunks,
    rollingWindow: env.rollingWindowSize,
    geminiMaxCostUsd: GEMINI_MAX_COST_USD,
  });
});

app.post("/api/sessions", async (req, res) => {
  const body = req.body as { useCase?: string; prompt?: string };
  const useCase = body.useCase;
  const prompt = body.prompt;

  if (useCase !== "text" && useCase !== "code") {
    return res.status(400).json({ error: "useCase must be 'text' or 'code'" });
  }
  if (typeof prompt !== "string" || prompt.trim().length < 5) {
    return res.status(400).json({ error: "prompt must be at least 5 chars" });
  }

  if (busyLock !== null) {
    return res.status(409).json({ error: "another session is already running — wait for it to finish" });
  }

  const cost = textMonitor.getCostEstimate();
  if (cost.estimatedUsd >= GEMINI_MAX_COST_USD) {
    return res.status(429).json({
      error: `Gemini cost cap hit: $${cost.estimatedUsd.toFixed(4)} >= $${GEMINI_MAX_COST_USD.toFixed(2)}`,
    });
  }

  const sessionId = randomUUID();
  const bus = registry.create(sessionId);
  const monitor: QualityMonitor = useCase === "code" ? codeMonitor : textMonitor;
  buyer.setMonitor(monitor);

  const meta: SessionMeta = {
    id: sessionId,
    useCase,
    prompt: prompt.trim(),
    startedAt: Date.now(),
    endedAt: null,
    result: null,
  };
  sessionMeta.set(sessionId, meta);

  const opts: SessionOptions = {
    useCase,
    prompt: meta.prompt,
    chunkPriceUsdc: env.pricePerChunkUsdc,
    chunkSizeTokens: env.chunkSizeTokens,
    maxTokens: env.maxTokensPerSession,
    budgetUsdc: env.buyerMaxSpendUsdc,
    qualityThreshold: env.qualityThreshold,
    rollingWindow: env.rollingWindowSize,
    warmupChunks: env.warmupChunks,
    sellerBaseUrl: SELLER_URL,
  };

  busyLock = buyer
    .runSession({ ...opts, sessionId, bus })
    .then((result) => {
      meta.result = result;
      meta.endedAt = Date.now();
    })
    .catch((err) => {
      console.error("[web-server] runSession crashed:", err);
      meta.endedAt = Date.now();
    })
    .finally(() => {
      busyLock = null;
    });

  res.json({ sessionId, meta });
});

app.get("/api/sessions/:id/events", (req, res) => {
  const id = req.params.id;
  const bus = registry.get(id);
  if (!bus) {
    return res.status(404).json({ error: "session not found" });
  }

  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache, no-transform");
  res.setHeader("Connection", "keep-alive");
  res.setHeader("X-Accel-Buffering", "no");
  res.flushHeaders();

  const heartbeat = setInterval(() => {
    res.write(`: ping ${Date.now()}\n\n`);
  }, 15_000);

  const unsub = bus.subscribe((e) => {
    res.write(`event: ${e.type}\n`);
    res.write(`data: ${JSON.stringify(e)}\n\n`);
    if (e.type === "session-complete") {
      res.write(`event: done\ndata: ${JSON.stringify({ sessionId: id })}\n\n`);
    }
  });

  req.on("close", () => {
    clearInterval(heartbeat);
    unsub();
  });
});

// ---------------------------------------------------------------------------
// Transfer lookup — turn a UUID into its real on-chain settlement record
// ---------------------------------------------------------------------------

app.get("/api/transfers/:id", async (req, res) => {
  const id = req.params.id;
  if (typeof id !== "string" || id.length < 10) {
    return res.status(400).json({ error: "invalid transfer id" });
  }

  // Cached if fresh AND status already "completed" (immutable thereafter).
  const cached = transferCache.get(id);
  if (cached) {
    const age = Date.now() - cached.at;
    const status = cached.record.status;
    if (status === "completed" || age < 10_000) {
      return res.json({ record: cached.record, cached: true, ageMs: age });
    }
  }

  try {
    const record = await buyer.lookupTransfer(id);
    transferCache.set(id, { at: Date.now(), record });

    // Look for any top-level 0x-prefixed 32-byte hash — that's the on-chain
    // settlement tx. We don't hardcode a key name; we surface every one we
    // find so the client can render them regardless of exact SDK naming.
    const hashes: Array<{ key: string; hash: string; explorerUrl: string }> = [];
    for (const [k, v] of Object.entries(record)) {
      if (typeof v === "string" && /^0x[0-9a-fA-F]{64}$/.test(v)) {
        hashes.push({
          key: k,
          hash: v,
          explorerUrl: `${env.arcBlockExplorerUrl}/tx/${v}`,
        });
      }
    }

    res.json({
      record,
      cached: false,
      onChainHashes: hashes,
      status: record.status ?? null,
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    res.status(502).json({ error: `lookup failed: ${msg}` });
  }
});

app.get("/api/transfers-to-seller", async (_req, res) => {
  const sellerAddress = env.sellerAddress;
  if (!sellerAddress) {
    return res.status(400).json({ error: "SELLER_ADDRESS not set in .env.local" });
  }

  try {
    const result = await buyer.searchTransfers({
      to: sellerAddress,
      pageSize: 50,
    });
    res.json({
      sellerAddress,
      count: result.transfers?.length ?? 0,
      transfers: result.transfers ?? [],
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    res.status(502).json({ error: `search failed: ${msg}` });
  }
});

// ---------------------------------------------------------------------------
// Evidence endpoint — reads logs/onchain-evidence.json (from
// `npm run produce-evidence`) and logs/verify-report.json (from
// `npm run verify-onchain`) and returns them combined.
//
// The dashboard's "On-chain Evidence" card renders this so judges see the
// real on-chain proof without needing to open log files. Both files are
// optional — if they don't exist yet, the endpoint returns nulls and the
// dashboard shows guidance to run the producing scripts.
// ---------------------------------------------------------------------------

const LOGS_DIR = join(process.cwd(), "logs");
const ONCHAIN_EVIDENCE_PATH = join(LOGS_DIR, "onchain-evidence.json");
const VERIFY_REPORT_PATH = join(LOGS_DIR, "verify-report.json");

app.get("/api/evidence", async (_req, res) => {
  const result: {
    onchainEvidence: unknown | null;
    verifyReport: unknown | null;
    files: { onchainEvidence: string; verifyReport: string };
  } = {
    onchainEvidence: null,
    verifyReport: null,
    files: { onchainEvidence: ONCHAIN_EVIDENCE_PATH, verifyReport: VERIFY_REPORT_PATH },
  };

  try {
    const data = await readFile(ONCHAIN_EVIDENCE_PATH, "utf-8");
    result.onchainEvidence = JSON.parse(data);
  } catch {
    /* file doesn't exist yet — dashboard will show guidance */
  }
  try {
    const data = await readFile(VERIFY_REPORT_PATH, "utf-8");
    result.verifyReport = JSON.parse(data);
  } catch {
    /* file doesn't exist yet */
  }

  res.json(result);
});

// ---------------------------------------------------------------------------
// Evidence-producer endpoint — runs N deposit transactions LIVE and appends
// the resulting tx hashes to logs/onchain-evidence.json. Wired to the
// dashboard's "Add N on-chain Arc tx (live)" button so judges can watch
// real Arc transactions get produced during the demo.
//
// Same operation as `npm run produce-evidence`, but exposed over HTTP and
// merged with the existing evidence file rather than overwriting it.
//
// Hard-capped at 20 deposits per call to keep the demo button responsive.
//
// Gated by requireDemoKey: if env.demoKey is set (production), requests
// must include matching X-Demo-Key header. This stops random visitors to
// the public demo URL from draining testnet USDC out of the buyer EOA
// into the buyer's Gateway balance. In local dev (no DEMO_KEY) the
// endpoint stays open as before.
// ---------------------------------------------------------------------------

interface OnchainEvidenceTx {
  index: number;
  depositTxHash: string;
  explorerTxUrl: string;
  ts: string;
}

interface OnchainEvidenceFile {
  generatedAt?: string;
  lastAddedAt?: string;
  buyerAddress?: string;
  explorerAddressUrl?: string;
  attemptedCount?: number;
  successfulCount?: number;
  amountPerDepositUsdc?: string;
  walletUsdcAfter?: string;
  gatewayUsdcAfter?: string;
  transactions?: OnchainEvidenceTx[];
  firstFailureMessage?: string;
}

app.post("/api/evidence/produce", requireDemoKey, async (req, res) => {
  const requestedCount = Number(req.query.count ?? 10);
  const count =
    Number.isInteger(requestedCount) && requestedCount > 0
      ? Math.min(20, requestedCount)
      : 10;
  const amount = String(req.query.amount ?? "0.001");

  // Read existing evidence file so we append rather than overwrite.
  let existing: OnchainEvidenceFile = {};
  try {
    const data = await readFile(ONCHAIN_EVIDENCE_PATH, "utf-8");
    existing = JSON.parse(data) as OnchainEvidenceFile;
  } catch {
    /* no existing file — we'll create a fresh one */
  }
  const baseTx = existing.transactions ?? [];
  const baseAttempted = existing.attemptedCount ?? 0;
  const baseSuccessful = existing.successfulCount ?? 0;

  const explorerBase = env.arcBlockExplorerUrl;
  const newTxs: OnchainEvidenceTx[] = [];
  let firstFailureMessage: string | undefined;

  for (let i = 1; i <= count; i++) {
    try {
      const r = await buyer.forceDeposit(amount);
      newTxs.push({
        index: baseTx.length + newTxs.length + 1,
        depositTxHash: r.depositTxHash,
        explorerTxUrl: `${explorerBase}/tx/${r.depositTxHash}`,
        ts: new Date().toISOString(),
      });
      // Be polite to Arc RPC.
      await new Promise((res) => setTimeout(res, 250));
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (!firstFailureMessage) firstFailureMessage = msg;
      console.error(`[evidence/produce] deposit ${i} failed: ${msg}`);
      // Backoff on failure.
      await new Promise((res) => setTimeout(res, 1500));
    }
  }

  // Refresh balances for the merged file.
  let walletUsdcAfter: string | undefined;
  let gatewayUsdcAfter: string | undefined;
  try {
    const b = await buyer.getBalances();
    walletUsdcAfter = b.wallet.formatted;
    gatewayUsdcAfter = b.gateway.formattedAvailable;
  } catch {
    /* balance read failed; not critical */
  }

  const merged: OnchainEvidenceFile = {
    generatedAt: existing.generatedAt ?? new Date().toISOString(),
    lastAddedAt: new Date().toISOString(),
    buyerAddress: existing.buyerAddress ?? buyer.address,
    explorerAddressUrl:
      existing.explorerAddressUrl ??
      `${explorerBase}/address/${buyer.address}?tab=txs`,
    attemptedCount: baseAttempted + count,
    successfulCount: baseSuccessful + newTxs.length,
    amountPerDepositUsdc: amount,
    walletUsdcAfter,
    gatewayUsdcAfter,
    transactions: [...baseTx, ...newTxs],
    firstFailureMessage,
  };
  await writeFile(ONCHAIN_EVIDENCE_PATH, JSON.stringify(merged, null, 2));

  res.json({
    requestedCount: count,
    addedCount: newTxs.length,
    totalSuccessful: merged.successfulCount,
    newTransactions: newTxs,
    walletUsdcAfter,
    gatewayUsdcAfter,
    firstFailureMessage,
  });
});

// ---------------------------------------------------------------------------
// Aggregate status
// ---------------------------------------------------------------------------

app.get("/api/status", async (_req, res) => {
  const cost = textMonitor.getCostEstimate();
  const sessions = Array.from(sessionMeta.values())
    .sort((a, b) => b.startedAt - a.startedAt)
    .map((m) => ({
      id: m.id,
      useCase: m.useCase,
      prompt: m.prompt,
      startedAt: m.startedAt,
      endedAt: m.endedAt,
      outcome: m.result?.outcome ?? null,
      chunksCompleted: m.result?.chunksCompleted ?? null,
      spentUsdc: m.result?.spentUsdc ?? null,
      wouldHaveSpentUsdc: m.result?.wouldHaveSpentUsdc ?? null,
      transactions: m.result?.transactions ?? [],
      killReason: m.result?.killReason ?? null,
      errorMessage: m.result?.errorMessage ?? null,
    }));

  const totalTxs = sessions.reduce((n, s) => n + (s.transactions?.length ?? 0), 0);
  const totalSpent = sessions.reduce((n, s) => n + (s.spentUsdc ?? 0), 0);
  const totalWouldHave = sessions.reduce((n, s) => n + (s.wouldHaveSpentUsdc ?? 0), 0);

  // Buyer's live Gateway + wallet balance (cached). Refined-design change 4:
  // surfaces the API-reported state alongside the locally-tracked in-flight
  // spend so the dashboard shows the off-chain → on-chain timeline.
  const balanceResult = await getBuyerBalancesCached();
  const buyerGateway = balanceResult.data
    ? {
        gatewayAvailableUsdc: Number(balanceResult.data.gateway.formattedAvailable),
        gatewayTotalUsdc: Number(balanceResult.data.gateway.formattedTotal),
        gatewayWithdrawingUsdc: Number(balanceResult.data.gateway.formattedWithdrawing),
        walletUsdc: Number(balanceResult.data.wallet.formatted),
        cached: balanceResult.cached,
        ageMs: balanceResult.ageMs,
      }
    : { error: balanceResult.error };

  res.json({
    busy: busyLock !== null,
    gemini: { ...cost, capUsd: GEMINI_MAX_COST_USD },
    totals: {
      sessions: sessions.length,
      transactions: totalTxs,
      spentUsdc: totalSpent,
      wouldHaveSpentUsdc: totalWouldHave,
      savedByKillsOrEarlyStopUsdc: totalWouldHave - totalSpent,
    },
    buyerGateway,
    sessions,
  });
});

// ---------------------------------------------------------------------------
// Start
// ---------------------------------------------------------------------------

// Cloud platforms (Railway, Fly, Render, Heroku) inject PORT and require
// the process to bind to it for the public route to reach the container.
// Locally, PORT is unset and we fall back to env.webServerPort (default 3001).
const port = Number(process.env.PORT) || env.webServerPort;

app.listen(port, () => {
  console.log("━".repeat(70));
  console.log(` Midstream dashboard: http://localhost:${port}`);
  console.log("━".repeat(70));
  console.log(`   buyer address:    ${buyer.address}`);
  console.log(`   seller address:   ${env.sellerAddress ?? "(not set)"}`);
  console.log(`   seller URL:       ${SELLER_URL}`);
  console.log(`   text monitor:     ${textMonitor.name} (${env.geminiModel})`);
  console.log(`   code monitor:     ${codeMonitor.name}`);
  console.log(`   gemini cost cap:  $${GEMINI_MAX_COST_USD.toFixed(2)} per server lifetime`);
  console.log(`   demo key auth:    ${env.demoKey ? "ENABLED on /api/evidence/produce" : "disabled (local dev)"}`);
  console.log("━".repeat(70));
  console.log(`   open: http://localhost:${port}`);
  console.log("━".repeat(70));
});
