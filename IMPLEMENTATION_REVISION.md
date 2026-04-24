# Implementation Revision

**Date:** 2026-04-22
**Status:** Supersedes `docs/archive/DESIGN.original.md` §3 and parts of `docs/archive/STRUCTURE.original.md`
**Scope:** This document is the single source of truth for the changes. Any conflict between this doc and an archived one resolves in favor of this one.

---

## Why this document exists

Before writing any real code, we stress-tested the original design against how
the actual SDKs work (`@x402/express`, `@circle-fin/x402-batching`, Anthropic's
streaming API, block-explorer CSP policies). Six issues surfaced that would
have cost 1–2 days of dead-ends during implementation. This doc fixes them.

Nothing in `PROJECT_CONTEXT.md`'s verified facts changes. Only the architecture
around how chunks, SSE, and x402 fit together.

---

## The six changes

### Change 1: One HTTP request per chunk, not one request per session

**Original design** (archived §3):
> "Seller opens an SSE stream and begins emitting tokens… After chunkSize tokens, seller pauses emission and sends `event: payment-required` with the next chunk's 402 challenge."

**Problem.** `@x402/express`'s `paymentMiddleware()` — and every x402 server
middleware in the coinbase/x402 reference implementation — is request-scoped.
It returns `402` before the handler runs, `200` once after the handler runs.
There is no affordance for "mid-response, return 402 again." The x402 protocol
is defined per HTTP request, not per SSE event within one request.

The original design was confusing two layers: *x402 protocol-level 402 responses*
(HTTP status codes at request boundaries) with *SSE-level application events*
(arbitrary JSON over an already-open stream). Once the seller has opened an SSE
stream and is sending tokens, the HTTP status is 200. It can't "become 402 again"
mid-response.

**Revised design.** The natural grain is **one HTTP request per chunk**.

```
Buyer                                            Seller
─────                                            ──────

POST /chunk
  { sessionId?: null, prompt, ... }     ──────►
                                        ◄────── 402 PAYMENT-REQUIRED
                                                  (price = 0.0005, nonce info)

POST /chunk
  headers: { PAYMENT-SIGNATURE: ... }
  body: { sessionId: null, prompt, ... } ──────►
                                                 # Seller creates session
                                        ◄────── 200 OK
                                                 PAYMENT-RESPONSE header
                                                 body: { sessionId, chunkIndex: 0,
                                                         text, tokensEmitted }

POST /chunk
  body: { sessionId, chunkIndex: 1 }    ──────►
                                        ◄────── 402 PAYMENT-REQUIRED

POST /chunk
  headers: { PAYMENT-SIGNATURE: ... }
  body: { sessionId, chunkIndex: 1 }    ──────►
                                        ◄────── 200 OK + text

... (repeat per chunk) ...

POST /chunk   (buyer decides output has drifted)
  X                 ← buyer just stops making requests

# Seller's idle-session reaper cleans up state after 60s.
# No active work = no wasted API spend.
```

**Consequences.**
- Every chunk is a clean, spec-compliant x402 exchange.
- Seller maintains session state in a server-side `Map<sessionId, SessionState>`.
- The "kill" is the buyer ceasing to make new requests. No server-side timeout
  logic needed beyond housekeeping (drop session state after 60s of idleness).
- Each HTTP request is short. HTTP/1.1 keep-alive means the TCP connection stays
  open across chunks, so latency is minimal (~10–20ms per round-trip on localhost).

**UI impact: none.** From the judge's point of view, tokens still appear in Panel
D every ~0.5s. The dashboard doesn't care whether they arrive over one SSE stream
or 30 short HTTP responses. Panel F still shows one "authorization signed" row
per chunk. Panel G still shows batch settlements.

**Code simplification: substantial.** We drop the server-side timeout, drop the
payment-middleware-within-SSE hack, drop server-side handling of "what happens
when a signature doesn't arrive in time." The seller becomes a straightforward
Express handler.

---

### Change 2: One Anthropic API call per chunk, not one per session

**Original design.** Implicit assumption that the seller keeps a single Anthropic
streaming call open for the whole session and hands out 32-token slices as
payments arrive.

**Problem.** Anthropic's `messages.stream()` emits `content_block_delta` events
whose text size is controlled server-side. You don't get to say "give me exactly
32 tokens and then pause." You'd have to buffer text, run a tokenizer to count,
flush when the count hits 32, and stop reading the upstream stream. But once you
stop reading, **Anthropic keeps generating and billing you** for tokens in flight
that you never deliver to the buyer.

**Revised design.** Each chunk is a **complete Anthropic call** with
`max_tokens: 32` and `messages` containing the prior chunk outputs as assistant
turns. Concretely, for chunk N:

```ts
await anthropic.messages.create({
  model: 'claude-3-5-haiku-20241022',
  max_tokens: 32,
  system: systemPrompt,
  messages: [
    { role: 'user', content: originalPrompt },
    { role: 'assistant', content: textSoFar },   // chunks 0..N-1 concatenated
    { role: 'user', content: 'Continue from where you left off.' },
  ],
});
```

**Consequences.**
- Billed for exactly the tokens delivered. No "tokens in flight we never sent."
- If the buyer stops signing, we stop calling Anthropic. No wasted API spend.
- Clean chunk boundaries: the Anthropic response **is** the chunk.
- Small quality cost: Claude doesn't see its own in-progress generation across
  chunk boundaries. For Claude 3.5 Haiku and our 32-token chunks, this is fine.
  If prose coherence is visibly worse in testing, bump `max_tokens` to 64 and
  split one Anthropic response across two payments.

**Non-streaming is fine.** Anthropic's non-streaming `messages.create` takes
~1–2 seconds for 32 tokens. Over 31 chunks that's ~30–60 seconds for a full
run — well-paced for a demo video. If we want typewriter-style token-by-token
UI updates (we do), we can still stream **within a single chunk** — the Anthropic
stream for that chunk relays `content_block_delta` events to the buyer via the
HTTP response body using `res.write()` chunks. Between chunks there's a clear
request boundary.

---

### Change 3: Quality scoring uses cumulative output, not the last chunk only

**Original design.** Quality monitor scores "the last 32 tokens" per chunk.

**Problem.** 32 tokens ≈ 20 words ≈ half a sentence. Scoring "on-topic, citation
plausible, drift detected" on a half-sentence produces high variance. The rolling
window of size 3 partially compensates but still gives Gemini a noisy signal.

**Revised design.** At chunk boundary N, the quality monitor sees the **cumulative
output tokens 0..32*N** and scores "how on-topic is the response so far?" This is
a stable signal; it only changes meaningfully when drift actually accumulates.

```ts
// client/quality-monitor.ts
async function assessCumulative(
  prompt: string,
  cumulativeText: string,
  chunkIndex: number,
): Promise<QualityReport> {
  // Gemini 3 Flash via Function Calling; see client/quality-monitor.ts
  // Input: original prompt + all text so far
  // Output: { relevance_score: 0–1, on_topic, citation_plausible, drift_detected, reasoning }
}
```

**Cost implication.** Gemini Flash input grows from ~20 words (original) to ~620
words (at chunk 31). Gemini 2.5 Flash is priced at $0.075/M input tokens. 620
words ≈ 850 tokens × $0.075/M = $0.000064 per check. Fractions of a cent even at
chunk 31. Negligible.

**Threshold semantics.** The threshold is now on the rolling average of
cumulative-text scores, not on per-chunk scores. In practice this means:
- Score at chunk 3 might be 0.92 (strong on-topic start)
- Score at chunk 10 might be 0.85 (introduced tangential material)
- Score at chunk 13 drops to 0.55 (clearly drifted)

The threshold (0.75 by default) is crossed at chunk 13, and the kill fires.

---

### Change 4: Buyer tracks its own in-flight spend; UI shows dual balance

**Observation.** Gateway's `getBalance()` API returns the settled balance. But
signatures the buyer has issued that haven't yet been batch-settled are already
committed — just not visible in the API's balance yet.

If the UI shows only `GatewayClient.getBalance()`, it will look stale for up to
one batch window (Circle's batch cadence is `[OPEN]` — verify from Discord before
the demo).

**Revised design.** `client/buyer.ts` maintains an in-memory counter:

```ts
let locallyCommittedSpend = 0n;   // sum of value fields of signatures issued this session
```

The UI's Panel B ("Session Status") shows:

- `API-reported Gateway balance: $5.000000` (polled every 5s from `GatewayClient.getBalance()`)
- `Pending (signed this session): $0.006500`
- `Effective available: $4.993500` (= API balance − pending)

This makes the off-chain / on-chain timeline visible, which is itself pedagogically
useful for judges: they see "I paid $0.006500; it will settle on Arc in the next
batch window."

---

### Change 5: No iframe embed of the block explorer

**Original design.** Panel 8 = iframe of `testnet.arcscan.app`.

**Problem.** Most block explorers set `X-Frame-Options: DENY` or a restrictive
`Content-Security-Policy: frame-ancestors` to prevent clickjacking. Whether Arc
testnet explorer allows framing is verifiable only by testing; we should assume
no and design accordingly.

**Revised design.** Panel 8 becomes a **"Latest Batch Details"** panel rendered
by us from data we already have:

- Tx hash (`0xabcd…ef01`)
- Block number
- Timestamp
- Gas used / gas price
- From address (Circle's batch submitter)
- To address (Gateway Wallet)
- Value (sum of authorizations in the batch)
- A prominent **"Open on testnet.arcscan.app ↗"** button that opens the real
  explorer page in a new tab

Data comes from `publicClient.getTransaction({ hash })` via viem, hitting the
Arc RPC directly. We render it in our own styled card. Judges see real block
data; the explorer-as-truth is one click away.

---

### Change 6: Buyer is a library, not a separate Node process

**Original design.** Buyer is a long-running Node process on port 3001 that
exposes its own `/events` SSE endpoint, which the browser subscribes to.

**Problems.**
- Browser ↔ :3001 CORS gets awkward.
- Long-running buyer makes multi-session demos hard (have to kill and restart).
- Coupling the buyer's HTTP port to the UI means headless demos need a fake client.

**Revised design.**

- **`client/` is a library** (no HTTP server, no port).
- **`web-server/`** is a new small Express app on port 3001 (or served from Vite
  with a proxy — same origin as the UI). It imports the `client/` library.
- Browser flow:
  1. `POST /api/session` with `{prompt, budget, threshold, chunkSize}` → web-server
     creates a sessionId, starts a buyer task, responds `{sessionId}`.
  2. Browser opens `EventSource('/api/session/:id/events')` → web-server streams
     events from the running buyer task.
- The `client/` library exposes a clean API:

```ts
// client/buyer.ts exports
export class Buyer {
  constructor(deps: { privateKey, sellerBaseUrl, qualityKey, chain });
  async runSession(opts: SessionOptions, emit: (ev: BuyerEvent) => void): Promise<SessionResult>;
  async abort(sessionId: string): void;
  async getGatewayBalance(): Promise<bigint>;
}
```

- CLI runner (`scripts/run-demo.ts`) imports `Buyer` directly and logs events to
  stdout + NDJSON file. No HTTP needed for headless demos.
- Web-server subscribes the Buyer's event callback to the EventSource response
  writer. One buyer instance per incoming session — no shared state between
  concurrent demos.

---

## Cumulative data flow (revised)

```
Browser
  │
  │ POST /api/session {prompt, budget, threshold, chunkSize}
  ▼
web-server/ (Express :3001, or Vite proxy)
  │
  │ creates buyer = new Buyer({...env...})
  │ buyer.runSession(opts, ev => sseWriter(ev))
  ▼
client/ library (in-process, not a server)
  │
  │ for chunkIndex 0..N:
  │   1. quality_monitor.assess(prompt, cumulativeText, chunkIndex)
  │   2. if rollingAvg < threshold OR spent > budget: break (kill)
  │   3. POST seller /chunk (no signature) → 402 PAYMENT-REQUIRED
  │   4. signer.sign({from, to, value, validAfter, validBefore, nonce})
  │   5. POST seller /chunk (with PAYMENT-SIGNATURE) → 200 + text
  │   6. emit events: quality-assessed, authorization-signed, tokens-arrived,
  │                    chunk-complete, (on kill) kill-decision
  │
  ▼
server/ (Express :3000)
  │
  │ @x402/express paymentMiddleware:
  │   - chunk 0: first call with no sig → 402 (sellerAddress, price, domain extra)
  │   - second call with PAYMENT-SIGNATURE → verify via Circle facilitator → 200
  │     handler generates chunk via Anthropic.messages.create(max_tokens:32)
  │     writes response + PAYMENT-RESPONSE header with batch_id
  │
  ├──► Circle Gateway (BatchFacilitatorClient.verify + .settle)
  │       │
  │       ▼
  │     Batch TEE → single on-chain tx on Arc
  │
  └──► Anthropic API (messages.create per chunk)


Separately, periodically:
  │
  buyer/gateway-watcher polls publicClient.getTransaction(batchTxHash)
  emits batch-settled events with Arc block number
```

---

## What this changes about existing files

| File | Keep as-is? | Change needed |
|---|---|---|
| `PROJECT_CONTEXT.md` | ✓ | Append one-line pointer to this doc |
| `DESIGN.md` | **rewrite** | Use per-chunk-HTTP pattern |
| `STRUCTURE.md` | **rewrite** | Add `web-server/`, remove buyer-as-process |
| `UI_SPEC.md` | ✓ mostly | Update Panel 8 description (no iframe) and Panel B data-source note |
| `REFINEMENT_ANALYSIS.md` | ✓ | Unchanged |
| `DIRECTORY_DECISION.md` | ✓ | Unchanged |
| `.env.example` | **expand** | Add `SELLER_PRIVATE_KEY`, `CIRCLE_API_KEY`, `ARC_RPC_URL`, `ARC_BLOCK_EXPLORER_URL` |
| `shared/config.ts` | ✓ | Will need to read the new env vars when we wire up scripts — noted, not urgent today |
| `shared/events.ts` | ✓ | Event types are correct |
| `scripts/verify-onchain.ts` | ✓ | Correct |
| `docs/USE_CASE_EXPLAINED.md` | ✓ | Still correct |
| `docs/MARGIN_ANALYSIS.md` | ✓ | Still correct |
| `docs/CIRCLE_FEEDBACK.md` | ✓ | Will want a section on "the SDK's x402 middleware is request-scoped; for streaming workloads like ours, we implemented the chunk loop client-side. A server-side primitive for 'pay-per-chunk within one logical session' would simplify this" — add during build |

---

## What this does NOT change

Nothing in the business pitch. Nothing in the economic argument. Nothing in the
demo narrative. Nothing in the UI layout. Nothing about "50+ on-chain txns" or
"≤ $0.01 per action." The hackathon requirements are satisfied identically.

The only thing that changes is *how the seller and buyer wire together under
the hood*. From the judge's seat, the demo looks and feels exactly the same.

---

## Risk we're NOT fixing (and why)

**Risk: Anthropic's `messages.create` doesn't stream within one request.** For
per-chunk-level token-by-token streaming UX, we need either (a) Anthropic's
streaming API within one chunk request — which works, we just wire `anthropic.messages.stream()`
and pipe the deltas via `res.write()` — or (b) accept that tokens arrive in
a burst of 32 when each chunk completes.

We're going with (a). The seller handler does:

```ts
const stream = anthropic.messages.stream({ max_tokens: 32, ... });
for await (const event of stream) {
  if (event.type === 'content_block_delta' && event.delta.type === 'text_delta') {
    res.write(event.delta.text);
  }
}
res.end();
```

Each chunk HTTP response is chunked-transfer-encoded, tokens appear live, and the
response ends cleanly when Anthropic finishes at the 32-token cap. The buyer reads
the response as a stream via `fetch` + `getReader()`, accumulating text until the
response ends, at which point the chunk is complete and the next signature cycle
begins.

This gives the typewriter UX the UI_SPEC asks for, while keeping clean chunk/request
boundaries for the payment protocol.

---

## Go/no-go checkpoints during implementation

These are the validation gates. If any one fails, stop and revise before the next.

1. **Tue evening:** `npm run generate-wallets` produces real keypairs; `npm run deposit`
   makes one real Gateway deposit visible on `testnet.arcscan.app`. If this fails, the
   rest is moot — the Circle API / wallet / RPC stack isn't working.

2. **Wed morning:** Seller returns a valid 402 with `extra.name: "GatewayWalletBatched"`
   and a `verifyingContract` to a `curl` request. No payment semantics yet — just
   proving the middleware emits the right headers.

3. **Wed afternoon:** Buyer signs chunk 0 with viem's `signTypedData`, posts with
   `PAYMENT-SIGNATURE` header, seller's facilitator verifies. The chunk returns 32
   real tokens. **One real paid chunk settled. This is the hardest gate.**

4. **Wed evening:** Buyer loops through 31 chunks, each a separate paid HTTP request.
   Run completes with 31 real authorizations. `scripts/verify-onchain.ts` sees the
   corresponding batch tx(s) on Arc.

5. **Thu morning:** Add quality-monitor.ts + kill-gate.ts. Scripted bad output
   (we can test by lowering threshold to 0.99) produces a clean kill mid-run.

6. **Thu afternoon:** web-server/ + web/ wired up. Browser shows live tokens and
   a kill moment. No fancy styling yet.

7. **Thu evening / Fri morning:** UI polish (Panels F, G, 8). Run 3 full demo
   sessions. Hit ≥ 50 authorizations. `verify-onchain.ts` passes.

8. **Fri afternoon:** Record video, write `SUBMISSION.md`, deploy. Submit.

If gate 3 fails in a way that isn't fixable in ~4 hours, fall back to the
**x402 Digital Product** track with a simpler "single-chunk-per-request for
paid content" demo, and keep the streaming concept as "future work." That's
still a legitimate submission.

---

## One sentence for the team

> The seller serves 32 tokens per HTTP request, priced at $0.0005, gated by one
> x402 exchange; the buyer's quality monitor decides whether to make the next
> request; kill is silence; 30 requests × N sessions = 50+ on-chain settlements
> via Circle batching; all numbers are real.
