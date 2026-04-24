# DESIGN.md (v2)

**Revised 2026-04-22.** Supersedes `docs/archive/DESIGN.original.md`. See
`IMPLEMENTATION_REVISION.md` for the six specific changes and why.

Project: **Quality-Gated Per-Chunk LLM Inference on Arc**

---

## 1. Business problem — unchanged from v1

**Buyer:** developer or agent buying LLM inference, wants to pay only for output
that survives a quality check.
**Seller:** LLM inference provider willing to compete on "pay for what's useful"
terms.

See `docs/USE_CASE_EXPLAINED.md` for the plain-English version and
`docs/MARGIN_ANALYSIS.md` for the economic argument. Nothing in the pitch
changes in v2.

---

## 2. The architecture (revised)

```
┌─────────────────────────────────────────────────────────────────────────┐
│                              BROWSER                                     │
│                                                                          │
│  React UI (Vite)   ─── POST /api/session ───►                           │
│                    ◄── SSE events ────────────                           │
└───────────────────────────────────────────────┬─────────────────────────┘
                                                │
                                                ▼
┌─────────────────────────────────────────────────────────────────────────┐
│                   web-server/  (Express :3001)                           │
│                                                                          │
│  - imports client/ library                                               │
│  - one Buyer instance per session                                        │
│  - forwards buyer events to browser SSE                                  │
└──────┬──────────────────────────────────────────┬───────────────────────┘
       │ Buyer.runSession(opts, emit)             │
       ▼                                          │
┌─────────────────────────────────────────────┐  │
│         client/ library (in-process)         │  │
│                                              │  │
│  per chunk i = 0..N:                         │  │
│    quality.assess(prompt, cumulativeText)    │  │
│    if killGate.decide() == stop: break       │  │
│                                              │  │
│    ──► POST seller /chunk {sessionId, i}     │  │
│    ◄── 402 PAYMENT-REQUIRED                  │  │
│    signer.signTypedData(domain, msg)         │  │
│    ──► POST seller /chunk (with sig header)  │  │
│    ◄── 200 OK, streamed text (chunked body)  │  │
│                                              │  │
│    emit events → web-server → browser        │  │
└──────┬──────────────────────────────────────┘  │
       │ HTTP fetch                              │
       ▼                                          │
┌─────────────────────────────────────────────┐  │
│         server/ (Express :3000)              │  │
│                                              │  │
│  POST /chunk:                                │  │
│    @x402/express paymentMiddleware           │  │
│       no sig → 402 with domain extra         │  │
│       with sig → verify via Circle facilitator  │
│                 → handler runs               │  │
│                                              │  │
│    handler:                                  │  │
│       anthropic.messages.stream(             │  │
│         max_tokens: 32,                      │  │
│         messages: prior + userPrompt         │  │
│       )                                      │  │
│       pipe content_block_delta → res.write() │  │
│       res.end()                              │  │
│                                              │  │
│  Session state: Map<sessionId, {textSoFar,   │  │
│                     tokensEmitted, ...}>     │  │
│  Idle-cleanup reaper every 60s               │  │
└──────┬────────────────────┬─────────────────┘  │
       │                    │                    │
       ▼                    ▼                    │
  ┌────────────┐      ┌───────────────┐          │
  │ Anthropic  │      │Circle Gateway │          │
  │ API        │      │(facilitator)  │          │
  │(stream=32) │      │ batches sigs  │          │
  └────────────┘      │     │         │          │
                      │     ▼         │          │
                      │  Arc L1       │          │
                      │ (batch tx per │          │
                      │  Circle cycle)│          │
                      └───────┬───────┘          │
                              │                  │
                              ▼                  │
                  Arc testnet block explorer     │
                  (testnet.arcscan.app)          │
                                                 │
                                                 ▼
                           Gateway-watcher polls publicClient.getTransaction(hash)
                           emits batch-settled → web-server → browser
```

---

## 3. Sequence of one paid chunk

The atomic unit of this system is one paid chunk. This sequence happens 5-31
times per session. Every step is a real call to a real service.

1. **Client: quality gate check.** Before spending on chunk i, buyer runs
   `quality.assess(prompt, cumulativeText_so_far)` via Gemini 3 Flash with
   Function Calling. Returns `{relevance_score, on_topic, citation_plausible,
   drift_detected, reasoning}`. Rolling average of last 3 updated.

2. **Client: kill-gate decision.** If `rollingAvg < threshold` OR
   `spent + pricePerChunk > budget`, abort. Emit `kill-decision` event. Return.

3. **Client: first request (no signature).**

   ```
   POST /chunk HTTP/1.1
   Content-Type: application/json
   {"sessionId": "a1b2...", "chunkIndex": 5}
   ```

4. **Server: paymentMiddleware returns 402.**

   ```
   HTTP/1.1 402 Payment Required
   PAYMENT-REQUIRED: base64(json({
     x402Version: 2,
     accepts: [{
       scheme: "gateway-batched-evm",
       network: "arcTestnet",
       maxAmountRequired: "500",              // 0.0005 USDC * 1e6
       payTo: <SELLER_ADDRESS>,
       asset: <USDC_CONTRACT_ADDRESS>,
       resource: "https://.../chunk",
       extra: {
         name: "GatewayWalletBatched",
         version: "1",
         chainId: 5042002,
         verifyingContract: <GATEWAY_WALLET_ADDRESS>
       }
     }]
   }))
   ```

   The `extra` is the EIP-712 domain the client must sign against. Note: this
   is pulled by the middleware from its config, but **the client treats the
   `extra` in the response as ground truth**. Never hardcode `verifyingContract`
   on the client.

5. **Client: build EIP-712 message.**

   ```ts
   const message = {
     from: buyerAddress,
     to: sellerAddress,
     value: 500n,                                  // 0.0005 * 1e6
     validAfter: 0n,
     validBefore: BigInt(Math.floor(Date.now()/1000) + 4*24*3600),  // ≥ 3 days
     nonce: randomBytes(32) as Hex,
   };
   ```

6. **Client: sign with viem.**

   ```ts
   const signature = await account.signTypedData({
     domain: extra,                                // from 402 response
     types: {
       TransferWithAuthorization: [
         {name: 'from',        type: 'address'},
         {name: 'to',          type: 'address'},
         {name: 'value',       type: 'uint256'},
         {name: 'validAfter',  type: 'uint256'},
         {name: 'validBefore', type: 'uint256'},
         {name: 'nonce',       type: 'bytes32'},
       ],
     },
     primaryType: 'TransferWithAuthorization',
     message,
   });
   ```

7. **Client: retry with signature.**

   ```
   POST /chunk HTTP/1.1
   Content-Type: application/json
   PAYMENT-SIGNATURE: base64(json({
     x402Version: 2,
     scheme: "gateway-batched-evm",
     network: "arcTestnet",
     payload: {
       authorization: message,
       signature: "0x..."
     },
     resource: "https://.../chunk",
     accepted: { ... from 402 accepts[0] ... }
   }))
   {"sessionId": "a1b2...", "chunkIndex": 5}
   ```

8. **Server: middleware verifies, handler runs.** Circle's
   `BatchFacilitatorClient.verify()` validates the signature. Handler emits
   chunks of text via `res.write()` as Anthropic streams them, with
   `max_tokens: 32`. When Anthropic ends, `res.end()`.

9. **Server: writes PAYMENT-RESPONSE header before first body byte.**

   ```
   HTTP/1.1 200 OK
   PAYMENT-RESPONSE: base64(json({
     transaction: {batch_id: "...", ...},
     network: "arcTestnet",
     ...
   }))
   Content-Type: text/plain; charset=utf-8
   Transfer-Encoding: chunked

   The European Union AI Act...
   ```

10. **Client: streams response body.** Each chunk of text is relayed to the
    browser SSE feed as a `token` event. Text is accumulated into
    `cumulativeText`. When response ends, emit `chunk-complete`. Increment
    `locallyCommittedSpend`.

11. **Gateway-watcher (parallel):** `batch_id` from PAYMENT-RESPONSE is tracked.
    When a new batch tx hash becomes visible via Circle's API
    (or by polling its own wallet's pending transactions), the watcher calls
    `publicClient.getTransaction({hash})` on the Arc RPC. When confirmed, emit
    `batch-settled` event with block number. UI Panel G renders a new row.

12. **Loop:** back to step 1 for chunk i+1.

Total latency per chunk: ~50ms (first HTTP) + ~100ms (sign) + ~1500ms (second
HTTP with Anthropic streaming inside) = ~1.6s per chunk. A 31-chunk full run
takes ~50 seconds. Good pacing for a demo video.

---

## 4. One-time setup (run once per buyer)

Separate from the per-chunk loop.

1. `npm run generate-wallets` — produces buyer + seller keypairs in `.env.local`.
2. Buyer address receives Arc testnet USDC from `faucet.circle.com` (20 USDC
   per 2 hours). **One real on-chain tx** (faucet → buyer).
3. `npm run deposit -- 5` — buyer calls `USDC.approve(GatewayWallet, 5 USDC)`
   then `GatewayWallet.deposit(USDC, 5 USDC)`. **One real on-chain tx** (or two,
   depending on whether approve is separate). After ~0.5s Arc finality the
   buyer's Gateway balance is $5 and ready for paid chunks.

From here, the buyer's Gateway balance funds every chunk signature. No more
on-chain txs from the buyer's wallet directly; Circle's batcher handles the
on-chain settlements on behalf of all buyers in a batch.

---

## 5. Economics — unchanged

See `docs/MARGIN_ANALYSIS.md`. Summary:

| Outcome | Chunks | Cost |
|---|---:|---:|
| Full run (1000 tokens / 31 chunks) | 31 | $0.01550 |
| Killed at chunk 13 (drift detected) | 13 | $0.00625 |
| Killed at chunk 4 (rapid drift) | 4 | $0.00200 |

Three demo runs × 31 chunks worst case = 93 signed authorizations, netted into
~5–15 on-chain batch settlements on Arc. **Both interpretations** of the
hackathon's "≥50 on-chain transactions" requirement are satisfied — either by
authorization count (93 ≥ 50) or batch-tx count (assumes ≥ 50 over 5+ demo
sessions; easy to achieve with `scripts/run-demo.ts`).

Every per-action price is $0.0005, well within the **≤ $0.01 cap**.

---

## 6. Failure semantics

| Failure | Behavior | Buyer pays? |
|---|---|---|
| Buyer's quality gate rejects | Buyer stops making requests | No. Last paid chunk is the last settled chunk. |
| Buyer's budget exhausted | Buyer stops | No further spend. |
| Buyer crashes mid-session | Seller's idle reaper drops session after 60s | No. Only already-signed authorizations settle. |
| Seller crashes mid-chunk | Buyer's fetch sees a connection reset | No. Current chunk's signature is still valid for the configured window, but no new request is needed; buyer can choose to retry (new chunk N) or abort. The already-signed auth for the failed chunk is valid for 4 days; Circle's batcher will still settle it on the next batch cycle, and the seller **received payment for a chunk they failed to deliver**. This is a real risk, not a mock one. Mitigation: the seller is motivated to restart; our demo won't intentionally crash. For production this requires the seller to emit a void/cancel signal to Circle — out of scope for hackathon. |
| Network partitions between buyer and Circle Gateway | Signatures pile up locally | Buyer's `locallyCommittedSpend` goes up; signatures settle when Gateway reachable again. No double-spend possible because nonces are unique. |
| Buyer signs but seller never runs facilitator.verify | Seller received signature but never settled it | Authorization expires at `validBefore`. No settlement. Buyer's in-flight pending shows this. |

The last two rows are the cases `CIRCLE_FEEDBACK.md` highlights as "we'd want
better observability into the signed-but-not-settled state."

---

## 7. Seller's session state

```ts
interface SellerSession {
  id: string;
  buyerAddress: Address;
  prompt: string;
  systemPrompt: string;
  chunksEmitted: number;
  textSoFar: string;
  tokensEmitted: number;
  createdAt: number;
  lastActiveAt: number;
}

const sessions = new Map<string, SellerSession>();

// Reaper: every 30s, drop sessions where now - lastActiveAt > 60_000.
```

Kept in-memory; not persisted. If the seller restarts, sessions reset — the
buyer will either start a new session or receive an error on its next chunk
request. Fine for a single-node hackathon demo.

For multi-node production: Redis.

---

## 8. Client's session state

```ts
interface BuyerSessionState {
  id: string;
  prompt: string;
  budgetUsdc: number;
  qualityThreshold: number;  // 0-1
  chunkPriceUsdc: number;    // 0.0005 default
  chunkSizeTokens: number;   // 32 default
  maxTokens: number;         // 1000 default
  chunksCompleted: number;
  textSoFar: string;
  tokensReceived: number;
  spentUsdc: number;
  qualityHistory: QualityReport[];   // one per completed chunk
  authorizations: SignedAuthorization[];
  batchSettlements: Map<batchId, { txHash?: Hex, block?: bigint, settledAt?: number }>;
  status: 'running' | 'killed' | 'completed' | 'error';
  killReason?: string;
}
```

Lives in memory in `client/buyer.ts` for the duration of a session. The
web-server holds a reference; when the session completes the state is serialized
to `logs/session-<id>.json` for `scripts/verify-onchain.ts` to consume later.

---

## 9. Quality gate logic

```ts
// client/quality-monitor.ts
async function assess(prompt, cumulativeText, chunkIndex) {
  // Gemini 3 Flash with Function Calling. Schema: QualityReport.
  // System prompt: "You are evaluating whether a research response has stayed
  //   on topic. Score 0-1."
  // Input: prompt + cumulativeText + chunkIndex context.
  // Output: structured JSON via Function Calling tool.
}

// client/kill-gate.ts
function shouldKill(state: BuyerSessionState): { kill: boolean; reason?: string } {
  if (state.spentUsdc + state.chunkPriceUsdc > state.budgetUsdc) {
    return { kill: true, reason: 'budget-exhausted' };
  }
  if (state.qualityHistory.length < 2) {
    return { kill: false };   // warmup — don't kill on first chunk
  }
  const recent = state.qualityHistory.slice(-3);
  const avg = recent.reduce((s, r) => s + r.relevance_score, 0) / recent.length;
  if (avg < state.qualityThreshold) {
    return { kill: true, reason: `rolling quality ${avg.toFixed(3)} below threshold ${state.qualityThreshold}` };
  }
  if (state.tokensReceived >= state.maxTokens) {
    return { kill: false };  // natural completion handled by caller
  }
  return { kill: false };
}
```

**Warmup rule.** Don't kill before chunk 2 completes; one or two chunks is too
little signal. This matches the UI's Panel C showing "rolling avg (last 3)" —
the first 2 chunks are "too early to decide."

---

## 10. Event types emitted (see shared/events.ts — unchanged)

- `session-started`
- `quality-assessed` {chunkIndex, report, rollingAvg}
- `authorization-signed` {chunkIndex, nonce, sig, priceUsdc}
- `tokens` {chunkIndex, text} — emitted multiple times per chunk as Anthropic streams
- `chunk-complete` {chunkIndex, tokenCount}
- `batch-settled` {batchId, arcTxHash, arcBlock}
- `kill-decision` {reason, spent, threshold}
- `session-complete` {outcome, totalChunks, totalTokens, spent, wouldHaveSpent}

---

## 11. What the UI shows (see UI_SPEC.md — mostly unchanged)

Only two changes from the original UI_SPEC:

- Panel B's "Gateway balance" shows **two numbers**: API-reported and
  locally-adjusted. See `IMPLEMENTATION_REVISION.md` change 4.
- Panel 8 renders tx details we query via viem, with a link out to
  `testnet.arcscan.app`. No iframe. See `IMPLEMENTATION_REVISION.md` change 5.

Every other panel (Panels A, C, D, E, F, G, kill moment) stays as specified.

---

## 12. Why this is novel vs. AgentBazaar / agentswarm — unchanged

The pay-per-chunk pattern with mid-stream cutoff is not something atomic
agent-to-agent systems can demonstrate. An agent paying another agent once per
task has no middle to cut. A streaming inference call has 30 middles.

This is the wedge.

---

## 13. Training, multimodal, future work — unchanged

See archived DESIGN §5 and §6 for the "same mechanism maps to audio, video,
code-gen, labeling" table. Still the right pitch for "why this is a primitive,
not a one-off."
