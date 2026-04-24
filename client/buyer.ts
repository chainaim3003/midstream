// client/buyer.ts
//
// The headless buyer. Streams tokens from the seller, runs a local Gemini 3
// Flash quality judge on each chunk, decides whether to sign the next
// authorization or let the stream time out (kill).
//
// This file is a skeleton. Method names from the Circle SDK (BatchEvmScheme,
// CompositeEvmScheme, GatewayClient) are taken from Circle's docs; verify the
// exact signatures against a fresh clone of circlefin/arc-nanopayments.
//
// Official references:
//   https://developers.circle.com/gateway/nanopayments/howtos/x402-buyer
//   https://developers.circle.com/gateway/nanopayments/howtos/eip-3009-signing
//   https://github.com/circlefin/arc-nanopayments/ (see agent.mts, lib/*)

import express, { type Response } from 'express';
import { privateKeyToAccount } from 'viem/accounts';
import { createPublicClient, http } from 'viem';
import { env, chain, arcTxUrl } from '../shared/config.js';
import type { BuyerEvent, QualityReport } from '../shared/events.js';
import { assessChunk, makeMonitorState, updateRolling, shouldKill } from './quality-monitor.js';

// TODO[verify]: exact imports from @circle-fin/x402-batching/client
import { BatchEvmScheme, GatewayClient } from '@circle-fin/x402-batching/client';

// ---------------------------------------------------------------------------
// Event bus for the web UI
// ---------------------------------------------------------------------------

const app = express();
app.use(express.json());
const sseClients = new Set<Response>();

function emit(event: BuyerEvent) {
  const line = `data: ${JSON.stringify(event)}\n\n`;
  for (const client of sseClients) client.write(line);
}

app.get('/events', (req, res) => {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders();
  sseClients.add(res);
  req.on('close', () => sseClients.delete(res));
});

// ---------------------------------------------------------------------------
// Buyer account + clients
// ---------------------------------------------------------------------------

const account = privateKeyToAccount(env.BUYER_PRIVATE_KEY as `0x${string}`);

const publicClient = createPublicClient({
  chain: {
    id: chain.id,
    name: chain.name,
    nativeCurrency: chain.nativeCurrency,
    rpcUrls: { default: { http: [chain.rpcUrl] } },
  },
  transport: http(chain.rpcUrl),
});

// TODO[verify]: constructor options.
const gateway = new GatewayClient({
  chain: chain.id,
  // account / apiKey / etc. per SDK
});

const scheme = new BatchEvmScheme({
  account,
  chain: chain.id,
  // NOTE: verifyingContract is NOT hardcoded here — it comes from the 402
  // response's `extra.verifyingContract` field at runtime. See lib/signer.ts.
});

// ---------------------------------------------------------------------------
// The main run loop
// ---------------------------------------------------------------------------

app.post('/run', async (req, res) => {
  const { prompt, budgetUsdc, qualityThreshold, maxTokens } = req.body ?? {};
  if (!prompt) return res.status(400).json({ error: 'prompt required' });

  const budget = Math.min(Number(budgetUsdc ?? 0.5), env.BUYER_MAX_SPEND_USDC);
  const threshold = Number(qualityThreshold ?? env.QUALITY_THRESHOLD);

  res.json({ started: true });

  try {
    await runSession({ prompt, budget, threshold, maxTokens: Number(maxTokens ?? 1000) });
  } catch (e) {
    console.error('session error:', e);
  }
});

async function runSession({
  prompt,
  budget,
  threshold,
  maxTokens,
}: {
  prompt: string;
  budget: number;
  threshold: number;
  maxTokens: number;
}) {
  const sessionId = crypto.randomUUID();
  const monitor = makeMonitorState({ query: prompt, threshold, windowSize: env.ROLLING_WINDOW_SIZE });

  // Initial Gateway balance
  // TODO[verify]: exact method — might be `gateway.getBalance({ address })` or similar.
  const balance = await gateway.getBalance({ address: account.address });
  emit({ type: 'buyer-ready', address: account.address, gatewayBalanceUsdc: Number(balance) / 1e6, ts: Date.now() });

  // Start the stream
  const sellerUrl = `http://localhost:${env.PORT}/stream`;
  const initial = await fetch(sellerUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ prompt, maxTokens }),
  });

  if (initial.status !== 402) {
    throw new Error(`expected 402 payment required, got ${initial.status}`);
  }

  // Parse the payment challenge, sign chunk 1, retry
  const challenge = decodePaymentRequired(initial.headers.get('PAYMENT-REQUIRED') ?? '');
  const firstAuth = await scheme.sign({
    challenge,
    amountUsdc: env.PRICE_PER_CHUNK_USDC,
    nonceBytes: randomNonce(),
    validBefore: BigInt(Math.floor(Date.now() / 1000) + 4 * 24 * 3600), // 4 days — must be ≥ 3 days per Gateway rules
  });

  emit({
    type: 'authorization-signed',
    sessionId,
    chunkIndex: 0,
    nonce: firstAuth.authorization.nonce,
    sig: firstAuth.signature,
    priceUsdc: env.PRICE_PER_CHUNK_USDC,
    ts: Date.now(),
  });

  // Retry with PAYMENT-SIGNATURE
  const streamResp = await fetch(sellerUrl, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'PAYMENT-SIGNATURE': encodePaymentSignature(firstAuth, challenge),
    },
    body: JSON.stringify({ prompt, maxTokens }),
  });

  if (!streamResp.ok || !streamResp.body) {
    throw new Error(`stream open failed: ${streamResp.status}`);
  }

  // Consume SSE, chunk by chunk
  const reader = streamResp.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let currentChunkText = '';
  let currentChunkIndex = 0;
  let spent = env.PRICE_PER_CHUNK_USDC;

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });

    // Parse SSE events (event: X\ndata: {...}\n\n)
    const events = extractSseEvents(buffer);
    buffer = events.remainder;

    for (const evt of events.events) {
      if (evt.event === 'token') {
        const data = JSON.parse(evt.data) as { text: string; chunkIndex: number };
        currentChunkText += data.text;
        currentChunkIndex = data.chunkIndex;
      } else if (evt.event === 'payment-required') {
        const data = JSON.parse(evt.data) as { chunkIndex: number; price: number };

        // --- QUALITY ASSESSMENT ---
        const report: QualityReport = await assessChunk({
          query: prompt,
          windowText: currentChunkText,
          chunkIndex: currentChunkIndex,
        });
        const rollingAvg = updateRolling(monitor, report);
        emit({
          type: 'quality-assessed',
          sessionId,
          chunkIndex: currentChunkIndex,
          report,
          rollingAvg,
          ts: Date.now(),
        });

        // --- KILL GATE ---
        const gate = shouldKill(monitor);
        if (gate.kill) {
          emit({
            type: 'kill-decision',
            sessionId,
            chunkIndex: data.chunkIndex,
            reason: gate.reason,
            rollingAvg,
            threshold,
            ts: Date.now(),
          });
          // Don't POST to /authorize — seller will time out and abort
          break;
        }

        // --- BUDGET GATE ---
        if (spent + data.price > budget) {
          emit({
            type: 'budget-exhausted',
            sessionId,
            chunkIndex: data.chunkIndex,
            spentUsdc: spent,
            budgetUsdc: budget,
            ts: Date.now(),
          });
          break;
        }

        // --- SIGN NEXT AUTHORIZATION ---
        const nextAuth = await scheme.sign({
          challenge,
          amountUsdc: data.price,
          nonceBytes: randomNonce(),
          validBefore: BigInt(Math.floor(Date.now() / 1000) + 4 * 24 * 3600),
        });

        emit({
          type: 'authorization-signed',
          sessionId,
          chunkIndex: data.chunkIndex,
          nonce: nextAuth.authorization.nonce,
          sig: nextAuth.signature,
          priceUsdc: data.price,
          ts: Date.now(),
        });

        // POST it to the seller's /authorize side-channel
        await fetch(`http://localhost:${env.PORT}/authorize`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ sessionId, chunkIndex: data.chunkIndex, payload: nextAuth }),
        });

        spent += data.price;
        currentChunkText = '';
      } else if (evt.event === 'aborted' || evt.event === 'completed') {
        break;
      }
    }
  }

  const outcome = monitor.history.length > 0 && shouldKill(monitor).kill ? 'killed' : 'completed';
  const wouldHaveSpent = Math.ceil(maxTokens / env.CHUNK_SIZE_TOKENS) * env.PRICE_PER_CHUNK_USDC;

  emit({
    type: 'session-complete',
    sessionId,
    outcome,
    spentUsdc: spent,
    wouldHaveSpentUsdc: wouldHaveSpent,
    ts: Date.now(),
  });
}

// ---------------------------------------------------------------------------
// Helpers (shape TBD — see circlefin/arc-nanopayments for exact implementations)
// ---------------------------------------------------------------------------

function decodePaymentRequired(header: string) {
  // TODO: base64 → JSON per x402 spec
  const json = Buffer.from(header, 'base64').toString('utf-8');
  return JSON.parse(json);
}

function encodePaymentSignature(auth: unknown, challenge: unknown): string {
  // TODO: base64( JSON({ x402Version, scheme, network, payload, resource, accepted }) ) per x402 spec
  const json = JSON.stringify({ x402Version: 2, payload: auth });
  return Buffer.from(json).toString('base64');
}

function randomNonce(): `0x${string}` {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  return ('0x' + Array.from(bytes).map((b) => b.toString(16).padStart(2, '0')).join('')) as `0x${string}`;
}

function extractSseEvents(buf: string): { events: { event: string; data: string }[]; remainder: string } {
  const events: { event: string; data: string }[] = [];
  const blocks = buf.split('\n\n');
  const remainder = blocks.pop() ?? '';
  for (const block of blocks) {
    const lines = block.split('\n');
    let event = 'message';
    let data = '';
    for (const line of lines) {
      if (line.startsWith('event: ')) event = line.slice(7).trim();
      else if (line.startsWith('data: ')) data += line.slice(6);
    }
    if (data) events.push({ event, data });
  }
  return { events, remainder };
}

// ---------------------------------------------------------------------------
// Start
// ---------------------------------------------------------------------------

const PORT = 3001;
app.listen(PORT, () => {
  console.log(`🔵 Buyer listening on :${PORT}`);
  console.log(`   buyer address:      ${account.address}`);
  console.log(`   quality threshold:  ${env.QUALITY_THRESHOLD}`);
  console.log(`   rolling window:     ${env.ROLLING_WINDOW_SIZE} chunks`);
  console.log(`   explorer (seller):  ${arcTxUrl('0x...')}`.replace('0x...', '<latest-batch>'));
});
