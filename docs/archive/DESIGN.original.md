# DESIGN.md

Refined project: **Quality-Gated Streaming Inference on Arc**

## 1. The business problem

**Who is the buyer?** An agent (or developer building one) that needs to pay for LLM inference, but cannot afford to pay for bad output. Examples:

| Buyer scenario | Why bad output is expensive |
|---|---|
| Autonomous research agent calling a smaller, cheaper model as a sub-provider | Agent has a budget cap per task; wasted tokens are wasted dollars |
| Real-time transcription / translation feeding a UI | Quality drop past some threshold is worse than no output at all |
| Agent composing a legal, medical, or financial document | Low-quality prose must be cut, not paid for |
| Any buyer of long-form generation (>1000 tokens) where quality is variable | Today you commit to the whole bill before you see the output |

**Who is the seller?** An LLM inference provider that wants to charge competitively for quality output and is willing to accept "no pay if output is bad" because they are confident in quality and want to dominate agentic market share.

**The gap today**: Every commercial inference API charges on total tokens consumed regardless of usefulness. You can cancel a stream, but you are still billed for tokens generated up to the cancel. Refunds are manual, slow, and uneconomical at per-token prices.

**What Nanopayments + x402 unlock that nothing else does**:
1. Per-chunk pricing at sub-cent granularity (impossible with Stripe: $0.30 fixed fee)
2. Buyer-authorized pay-as-you-go: each chunk requires a fresh signed authorization; no authorization, no chunk
3. Zero gas on every chunk: buyer signs EIP-712 offchain, no on-chain tx per chunk
4. Net-settled in batches: Gateway's TEE aggregates the authorizations and settles net positions on Arc in one on-chain tx per batch
5. Sub-second Arc finality means withdraws / balance views stay current

**The economic argument** (why this isn't possible today, in three rows):

| Rail | Per-tx cost | Minimum viable per-tx charge | Can support per-chunk LLM billing? |
|---|---|---|---|
| Stripe / Visa | 2.9% + $0.30 | ~$10 | No |
| Ethereum L1 gas | $1–5 | ~$100 | No |
| Arc + Circle Gateway Nanopayments | ~$0 per signature; gas shared across the whole batch | $0.000001 | Yes |

## 2. The architecture

```
┌───────────────────────────────────────────────────┐
│                  BUYER (Node.js)                  │
│                                                   │
│  prompt ──► buyer client ──► quality gate         │
│                  │                │               │
│                  ▼                ▼               │
│         PAYMENT-SIGNATURE     rolling score       │
│         (x402, per chunk)     (Anthropic          │
│                               or Gemini,          │
│                               local to buyer)     │
└─────────┬───────────────────────┬─────────────────┘
          │                       │
          ▼ HTTP stream (SSE)     │ (local; no payment)
┌─────────────────────────────────┴─────────────────┐
│                  SELLER (Node.js)                 │
│                                                   │
│  x402ResourceServer                               │
│   + BatchFacilitatorClient  ──► Circle Gateway    │
│   + GatewayEvmScheme                              │
│                                                   │
│  /stream (SSE):                                   │
│    loop:                                          │
│      emit N tokens from Anthropic                 │
│      respond 402 PAYMENT-REQUIRED                 │
│      verify PAYMENT-SIGNATURE (via Gateway)       │
│      continue stream                              │
│      if no signature in T seconds: abort          │
└───────────────────────────────┬───────────────────┘
                                │
                                ▼
                      Circle Gateway (TEE)
                                │
                      batches → single tx on Arc
                                │
                                ▼
                  Arc testnet chainId 5042002
                  (public block explorer)
```

## 3. Flow, in sequence

1. **One-time setup (buyer)**. Buyer obtains Arc testnet USDC from `faucet.circle.com` (20 USDC / 2h). Buyer runs `client.deposit("5")` once — a single on-chain tx depositing USDC into the Gateway Wallet contract. After ~0.5 seconds on Arc this $5 is in the buyer's Gateway balance, available for gas-free nanopayments.

2. **Request (buyer)**. Buyer posts `{prompt, qualityThreshold, maxTokens, pricePerChunk, chunkSize}` to `POST /stream`.

3. **First 402 (seller)**. Seller returns `402 Payment Required` with an `accepts` array whose entry for the Gateway batch scheme carries `extra.name === "GatewayWalletBatched"`, `extra.verifyingContract`, the seller's address, and the price for the first chunk.

4. **Sign chunk 1 (buyer)**. Buyer constructs a `TransferWithAuthorization` message and signs it with `viem`'s `signTypedData` against the `GatewayWalletBatched` domain. The `value` is `pricePerChunk * 10^6` (USDC has 6 decimals). The `nonce` is 32 random bytes. `validBefore` is set to ≥ 3 days in the future.

5. **Retry with signature (buyer)**. Buyer sends the same `POST /stream` request with `Payment-Signature: base64(JSON({x402Version: 2, payload: {authorization, signature}, resource, accepted}))`.

6. **Verify + stream (seller)**. Seller's `BatchFacilitatorClient` submits the authorization to Gateway, which verifies the signature and locks the buyer's funds internally. Seller opens an SSE stream and begins emitting tokens from Anthropic's Claude streaming API. After `chunkSize` tokens (e.g. 32), seller pauses emission and sends `event: payment-required` with the next chunk's 402 challenge.

7. **Quality evaluation (buyer)**. Buyer accumulates tokens. Every N tokens (or at each chunk boundary), a rolling window of the last K tokens is scored by a second LLM (Claude Haiku or Gemini Flash — cheap, fast, local to the buyer's process). The score is averaged over the last W windows.

8. **Decision point (buyer)**.
   - **If rolling score ≥ threshold**: buyer signs chunk N+1's authorization and sends it. Stream continues.
   - **If rolling score < threshold**: buyer does not sign. Seller waits `T` seconds (configurable; default 5), sees no signature arrive, closes the stream with `event: aborted reason: payment-timeout`.

9. **Settlement (Gateway, async)**. Gateway collects all authorizations from the session into a batch. At the next batch interval, the TEE verifies all signatures, computes net balance changes across all buyers/sellers in the batch, and signs a single on-chain tx. The Gateway Wallet contract on Arc verifies the TEE signature and applies the net balance changes atomically. Seller's Gateway balance becomes `available`.

10. **Withdraw (seller, optional)**. `client.withdraw("X")` — instant same-chain, or crosschain via Gateway's minting infrastructure.

## 4. Economics of a single run

Assume: 1000-token target output, chunk size 32 tokens, per-chunk price $0.0005 (a fiftieth of a cent).

- Maximum full-output cost: `1000 / 32 * $0.0005 = $0.0156`
- Typical cutoff at quality drop around token 400: `400 / 32 * $0.0005 = $0.00625`
- Number of Payment-Signatures created/submitted: 31 for full run, 13 at the cutoff above
- On-chain settlements: 1 batch per Gateway cycle; a 100-stream demo session produces ~3100 signed authorizations netted into ~5-10 on-chain settlements — satisfies the "≥50 on-chain transactions" requirement even with conservative batch sizes.

The argument to judges: **the buyer pays $0.00625 for output that was acceptable, and the seller forfeits ~$0.0094 of expected revenue for output that was not**. That economic alignment does not exist on any other rail.

## 5. Training vs. inference

- **Inference side (this project)**: Buyer pays per chunk of output tokens. Natural fit. Buyer's quality signal is whatever task-specific scorer they can run locally.
- **Training side (out of scope for this project, but worth mentioning in the pitch)**: Same mechanism maps onto paying a data-labeling provider per labeled example, with the buyer's quality gate being the consensus of verified labels. Labeler gets cut off if disagreement rate crosses threshold. Same SDK, same x402, same Gateway.

## 6. Use cases beyond text

| Medium | Unit of billing | Quality signal |
|---|---|---|
| Text | 32-token chunk | rolling LLM-judge score |
| Audio (TTS / translation) | 1-sec audio frame | phoneme-level confidence / MOS proxy |
| Video (generative) | 24-frame block | CLIP similarity to prompt, motion stability |
| Code generation | 1 function / block | lint pass + test pass |
| Real-time transcription | 1-sec chunk | confidence from ASR logits |
| Data labeling | 1 labeled example | agreement with gold set |

All of these have the same shape: buyer wants to pay sub-cent per unit, buyer has a local quality signal, buyer wants unilateral right to stop paying mid-stream. All of these only work economically on Nanopayments / Arc.

## 7. Can the buyer "pay for what was used and stop"?

Yes, and this is the core value proposition.

The mechanism: each chunk requires a **fresh** EIP-3009 `TransferWithAuthorization` signature. There is no subscription, no pre-auth for the whole stream, no refund logic. The seller has received payment only for chunks for which it received a valid signature. If the buyer stops signing at chunk 13 of 31, the seller has received payment for 13 chunks — nothing more.

There is no refund path because there is nothing to refund. This is why per-chunk x402 is structurally different from every other payment model.

**The caveat**: for the chunks the buyer *did* accept, the buyer has already given up unilateral right to retract. The signature is a firm commitment against the buyer's Gateway balance. The buyer's leverage is prospective (future chunks), not retrospective (past chunks). This is correct and matches how product quality contracts work in the physical world: you can stop buying, but you can't un-buy what you've already taken.

## 8. What's novel vs. existing hackathon projects

| Project | What it shows | What it doesn't show |
|---|---|---|
| AgentBazaar (reference) | Multiple specialist agents, each paid per call; coin-flight visualization | No mid-stream cutoff; each agent call is atomic |
| Sibling project | Inference, quality, payments as separate stages | All of the payment layer is a Python simulator |
| **This project** | Mid-stream quality-gated cutoff with real EIP-712 Gateway signatures and real Circle API calls | — |

The mid-stream cutoff is the wedge. Nothing that lives on Stripe or L1 gas can demonstrate it.

## 9. Why the UI matters

A judge in a 5-minute demo slot has to understand, within the first 30 seconds, what is economically new. The UI has to make three things undeniable, on screen:
1. Tokens streaming live, with a cost meter incrementing
2. A quality gauge falling below the user-set threshold
3. The stream stopping mid-sentence, with a receipt showing "paid for 142 tokens, stopped at token 143 due to quality = 0.68 < threshold 0.75"

The accompanying React UI artifact does exactly this — see the end of this response.
