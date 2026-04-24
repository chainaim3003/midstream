// server/seller.ts
//
// The paywalled SSE seller. Receives POST /stream, handles x402 payment
// negotiation per chunk, streams Claude tokens while the buyer keeps signing.
//
// This file is a skeleton with architectural structure and inline references
// to the exact Circle docs URLs where the SDK method signatures live. Do NOT
// fill it in from memory — open the linked doc, copy the real call shape.
//
// Official references:
//   https://developers.circle.com/gateway/nanopayments/howtos/x402-seller
//   https://developers.circle.com/gateway/nanopayments/concepts/x402
//   https://developers.circle.com/gateway/references/contract-interfaces-and-events
//   https://github.com/circlefin/arc-nanopayments/ (fork this for method shapes)

import express, { type Request, type Response } from 'express';
import Anthropic from '@anthropic-ai/sdk';
import { env, chain } from '../shared/config.js';
import type { SellerEvent } from '../shared/events.js';

// TODO[verify from arc-nanopayments package.json]: exact import path
// For TypeScript, the x402-batching SDK exports BatchFacilitatorClient and
// GatewayEvmScheme from its /server entry point. The /client entry point
// has BatchEvmScheme, CompositeEvmScheme, GatewayClient.
import { BatchFacilitatorClient, GatewayEvmScheme } from '@circle-fin/x402-batching/server';
// TODO[verify]: @x402/express middleware factory — see arc-nanopayments for shape
import { paymentMiddleware } from '@x402/express';

const app = express();
const anthropic = new Anthropic({ apiKey: env.ANTHROPIC_API_KEY });

// ---------------------------------------------------------------------------
// Event bus for the web UI
// ---------------------------------------------------------------------------

const sseClients = new Set<Response>();

function emit(event: SellerEvent) {
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
// Facilitator — submits buyer authorizations to Circle Gateway for verification
// and batched settlement on Arc.
// ---------------------------------------------------------------------------

// TODO[verify]: exact constructor options.
// https://developers.circle.com/gateway/nanopayments/howtos/x402-seller
const facilitator = new BatchFacilitatorClient({
  // typical fields based on SDK patterns; confirm against the sample:
  chain: chain.id,
  // apiKey / privateKey / etc. — see circlefin/arc-nanopayments/lib/facilitator.ts
});

const scheme = new GatewayEvmScheme({
  sellerAddress: env.SELLER_ADDRESS,
  // domain details are derived from chain config — do NOT pass verifyingContract here
  // since it's chain-configured and also echoed in the 402 response's extra.verifyingContract.
});

// ---------------------------------------------------------------------------
// The paywalled route
// ---------------------------------------------------------------------------

app.post(
  '/stream',
  paymentMiddleware({
    scheme,
    facilitator,
    price: env.PRICE_PER_CHUNK_USDC.toString(),
    network: env.CHAIN,
    // TODO[verify]: exact middleware options in @x402/express
  }),
  async (req: Request, res: Response) => {
    const { prompt, maxTokens } = req.body ?? {};
    if (!prompt || typeof prompt !== 'string') {
      return res.status(400).json({ error: 'prompt required' });
    }

    const sessionId = crypto.randomUUID();
    emit({ type: 'session-started', sessionId, prompt, ts: Date.now() });

    // Open SSE stream
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.flushHeaders();

    const write = (evt: string, data: unknown) => {
      res.write(`event: ${evt}\n`);
      res.write(`data: ${JSON.stringify(data)}\n\n`);
    };

    // Call Anthropic streaming
    const claudeStream = anthropic.messages.stream({
      model: 'claude-3-5-sonnet-latest',
      max_tokens: maxTokens ?? 1000,
      messages: [{ role: 'user', content: prompt }],
    });

    let chunkIndex = 0;
    let tokensInCurrentChunk = 0;
    let tokensSinceStart = 0;
    const paymentTimeoutMs = 5_000;

    for await (const delta of claudeStream) {
      // TODO[verify]: exact event shape from Anthropic SDK — the loop syntax above
      // may need to be `for await (const event of claudeStream.events())` or similar.
      // Reference: https://docs.anthropic.com/en/api/messages-streaming
      const text = extractTextDelta(delta);
      if (!text) continue;

      // Forward the token to the client
      write('token', { sessionId, text, chunkIndex });
      emit({ type: 'token', sessionId, text, chunkIndex, ts: Date.now() });
      tokensInCurrentChunk++;
      tokensSinceStart++;

      if (tokensInCurrentChunk >= env.CHUNK_SIZE_TOKENS) {
        emit({ type: 'chunk-complete', sessionId, chunkIndex, tokenCount: tokensInCurrentChunk, ts: Date.now() });

        // Require payment for next chunk
        write('payment-required', { sessionId, chunkIndex: chunkIndex + 1, price: env.PRICE_PER_CHUNK_USDC });
        emit({ type: 'payment-required', sessionId, chunkIndex: chunkIndex + 1, priceUsdc: env.PRICE_PER_CHUNK_USDC, ts: Date.now() });

        // Wait for the next PAYMENT-SIGNATURE header on a follow-up request, OR
        // for a second WebSocket-style signal. In the simplest implementation,
        // each chunk is its own HTTP round-trip (buyer makes a fresh request with
        // PAYMENT-SIGNATURE for chunk N+1 after receiving chunk N).
        //
        // For SSE within a single HTTP connection, Circle's sample uses a side-
        // channel: the buyer POSTs the authorization to /authorize and the
        // server correlates by sessionId.
        //
        // TODO: implement the side-channel — see circlefin/arc-nanopayments/app/api/stream for the exact pattern.

        const nextAuth = await waitForAuthorization(sessionId, chunkIndex + 1, paymentTimeoutMs);

        if (!nextAuth) {
          write('aborted', { sessionId, reason: 'payment-timeout', lastChunkIndex: chunkIndex });
          emit({ type: 'aborted', sessionId, reason: 'payment-timeout', lastChunkIndex: chunkIndex, ts: Date.now() });
          res.end();
          return;
        }

        // Submit this authorization via the facilitator; it will be batched.
        // TODO[verify]: the exact facilitator method name and return shape.
        // https://developers.circle.com/gateway/nanopayments/howtos/x402-seller
        const verified = await facilitator.verify(nextAuth);
        if (!verified) {
          write('aborted', { sessionId, reason: 'server-error', lastChunkIndex: chunkIndex });
          res.end();
          return;
        }

        emit({ type: 'payment-verified', sessionId, chunkIndex: chunkIndex + 1, nonce: nextAuth.authorization.nonce, ts: Date.now() });

        // Continue streaming into next chunk
        chunkIndex++;
        tokensInCurrentChunk = 0;
      }

      if (tokensSinceStart >= (maxTokens ?? 1000)) break;
    }

    write('completed', { sessionId, totalChunks: chunkIndex + 1, totalTokens: tokensSinceStart });
    emit({ type: 'completed', sessionId, totalChunks: chunkIndex + 1, totalTokens: tokensSinceStart, ts: Date.now() });
    res.end();
  },
);

// ---------------------------------------------------------------------------
// Side-channel: buyer POSTs PAYMENT-SIGNATURE for chunk N here
// ---------------------------------------------------------------------------

const pendingAuths = new Map<string, (auth: unknown) => void>();

app.post('/authorize', express.json(), (req, res) => {
  const { sessionId, chunkIndex, payload } = req.body;
  const key = `${sessionId}:${chunkIndex}`;
  const resolver = pendingAuths.get(key);
  if (resolver) {
    resolver(payload);
    pendingAuths.delete(key);
  }
  res.json({ ok: true });
});

function waitForAuthorization(sessionId: string, chunkIndex: number, timeoutMs: number): Promise<unknown | null> {
  return new Promise((resolve) => {
    const key = `${sessionId}:${chunkIndex}`;
    const timer = setTimeout(() => {
      pendingAuths.delete(key);
      resolve(null);
    }, timeoutMs);
    pendingAuths.set(key, (auth) => {
      clearTimeout(timer);
      resolve(auth);
    });
  });
}

// ---------------------------------------------------------------------------
// Anthropic event helper
// ---------------------------------------------------------------------------

function extractTextDelta(delta: unknown): string | null {
  // TODO[verify]: shape of the streaming delta; see Anthropic SDK streaming docs.
  // https://docs.anthropic.com/en/api/messages-streaming
  // typically: delta.type === 'content_block_delta' && delta.delta?.type === 'text_delta'
  const d = delta as { type?: string; delta?: { type?: string; text?: string } };
  if (d?.type === 'content_block_delta' && d.delta?.type === 'text_delta') {
    return d.delta.text ?? null;
  }
  return null;
}

// ---------------------------------------------------------------------------
// Start
// ---------------------------------------------------------------------------

app.listen(env.PORT, () => {
  console.log(`🟢 Seller listening on :${env.PORT}`);
  console.log(`   seller address:     ${env.SELLER_ADDRESS}`);
  console.log(`   price per chunk:    $${env.PRICE_PER_CHUNK_USDC}`);
  console.log(`   chunk size tokens:  ${env.CHUNK_SIZE_TOKENS}`);
  console.log(`   chain:              ${chain.name} (${chain.id})`);
});
