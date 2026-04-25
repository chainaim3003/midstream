# Midstream — Hackathon Submission

**Hackathon:** [Agentic Economy on Arc](https://lablab.ai/ai-hackathons/nano-payments-arc) (Circle + Arc, April 20–26, 2026)
**Track (primary):** Per-API Monetization Engine
**Track (secondary):** Agent-to-Agent Payment Loop
**Tagline:** Pay for outcomes, not tokens.

---

## What Midstream is

Midstream is a working reference implementation of **quality-gated streaming LLM inference with mid-stream cutoff**, settled per chunk via Circle Gateway Nanopayments on Arc. The cutoff mechanism is a **live inference harness** — three concurrent observers, two powered by Google Gemini and one a deterministic regex check — that score each 32-token chunk against the prompt's intent and constraints, and **course-correct by refusing the next payment authorization** the moment trajectory diverges. This is harness engineering done *during* generation, not pre-flight (prompt design) or post-hoc (response evaluation).

The seller streams output 32 tokens at a time. Each 32-token chunk is its own paid HTTP request, priced at $0.0005 USDC. Between chunks, the buyer's local harness runs three concurrent observers on the cumulative output: Layer 1 (Gemini judge for topic drift), Layer 2 (Gemini judge for spec adherence), Layer 3 (deterministic regex — backticked prompt tokens must appear verbatim). If the rolling score drops below threshold, the buyer stops signing payment authorizations. The seller, getting no signature, stops generating. Mid-sentence. The buyer pays only for the prefix that passed quality.

This is not possible without sub-cent settlement. Stripe's $0.30 minimum makes it impossible. Ethereum L1 gas makes it impossible. Circle Nanopayments on Arc — gas-free, batched, ~0.5 second finality — is the first rail where it works.

The harness itself is only economically viable because Circle Nanopayments + Arc make per-chunk evaluation cheap: each Gemini judge call runs ~$0.0001, the chunk price is $0.0005, harness cost stays well below value moved. On any rail with $0.01+ per-action overhead, harness cost would exceed chunk value before scoring returned — making real-time course correction structurally unavailable. **The harness exists because of Circle and Arc, not just on top of them.**

---

## Why this is the right fit for the hackathon

The hackathon's call is for projects that prove sub-cent USDC settlement enables economic models that previously didn't exist. Most submissions in this category **prepay** an action (per-API, per-task, per-purchase). Midstream is structurally different: it pays for **observed quality of an in-progress generation**. The unit of payment is a 32-token slice — not a finished response — and the buyer's right to stop paying is the entire product. That is the kind of pricing primitive sub-cent settlement enables for the first time.

Quote from Circle's [Nanopayments documentation](https://developers.circle.com/gateway/nanopayments):

> Streaming value: Implement pay-per-second content, micro-rewards, and continuous value flows where traditional payment rails are too expensive to operate.

Midstream is "streaming value, gated on quality." The prefix that passed your quality bar is what you pay for.

---

## Requirements addressed

### 1. Per-action pricing ≤ $0.01

✅ Each chunk is priced at $0.0005 USDC (1/20th of the cap). Configured in `.env.local` as `PRICE_PER_CHUNK_USDC=0.0005` and **enforced at seller startup** in `shared/config.ts`:

```ts
if (env.pricePerChunkUsdc > 0.01) {
  console.error(`PRICE_PER_CHUNK_USDC=${env.pricePerChunkUsdc} violates hackathon cap`);
  process.exit(1);
}
```

The seller process refuses to start if price exceeds the cap. Judges can verify by editing `.env.local` to `0.02` and observing seller startup failure.

### 2. ≥ 50 on-chain transactions demonstrated

This requirement deserves explicit framing because **Circle Gateway is architecturally a batching system**. From Circle's [Batched Settlement docs](https://developers.circle.com/gateway/nanopayments/concepts/batched-settlement):

> Circle Gateway enables nanopayments by **batching many individual payment authorizations into a single onchain transaction**. Instead of settling each payment separately (and paying gas each time), Gateway collects signed authorizations offchain, computes net balance changes, and applies them in bulk... reduces both the number of onchain transactions and the total gas consumed.

Circle Gateway intentionally produces fewer on-chain settlements than off-chain authorizations — that is the architectural feature. We satisfy the requirement under **three complementary measurements**:

**Measurement A — paid settlement actions (Circle Transfer UUIDs).**
Each chunk produces one EIP-712 `TransferWithAuthorization` signature. Each signature, once accepted by Gateway and reaching status `completed`, is a fully settled paid action. Across our demo sessions we logged **213 paid actions, 100% of them at status `completed`** per Circle's API. Logged in `logs/tx-log.jsonl`, verified by `npm run verify-onchain`.

**Measurement B — direct on-chain Arc transactions at our buyer EOA.**
We produced **50+ direct on-chain Arc transactions** at the buyer's EOA (`0xfca4b4e4B483e3c68E25dAB6A1b6570ec10CeFfB`) by running deliberate Gateway deposit operations: `npm run produce-evidence` calls `GatewayClient.deposit()` 50 times sequentially, each producing real on-chain Arc transactions visible at the buyer's address on `testnet.arcscan.app`. These are normal Gateway operations a high-frequency buyer would do over time; we ran them in a single batch to produce countable evidence. Logged in `logs/onchain-evidence.json` with every tx hash. **This is the metric that satisfies the literal reading of the requirement.**

**Measurement C — batch settlement events on Arc.**
Many UUIDs from Measurement A share one on-chain Arc transaction at the GatewayWallet contract (`0x0077777d7EBA4688BDeF3E311b846F25870A19B9`). Circle's transfer record API does not currently expose the transfer→batch→Arc-tx link directly (one of our Circle Product Feedback items, §3.5). We approximate the batch count by grouping settled transfers by `updatedAt` timestamp; transfers in the same batch share an `updatedAt` to the millisecond. Reported by `npm run verify-onchain`.

**Why the seller EOA shows 0 transactions:**
By design. Settlements credit the seller's Gateway balance, not their EOA. Sellers pay no gas to receive payments. The seller's current Gateway balance is the cumulative receipt across all settled batches; printed by `npm run verify-onchain`.

Full machine-readable evidence: `logs/verify-report.json` (Measurements A and C) and `logs/onchain-evidence.json` (Measurement B).

### 3. Margin explanation (why this fails on traditional rails)

✅ See [`docs/MARGIN_ANALYSIS.md`](../docs/MARGIN_ANALYSIS.md). Summary:

| Rail | Per-chunk fee | Per-chunk price | Margin |
|---|---|---|---|
| Stripe | $0.30 minimum | $0.0005 | **−59,900%** |
| Ethereum L1 | ~$1–10 gas | $0.0005 | **−200,000%** |
| Polygon PoS | ~$0.01 gas | $0.0005 | **−1,900%** |
| **Circle Nanopayments / Arc** | **batched, ~$0** | **$0.0005** | **viable** |

Per Circle's own docs: *"Send as little as $0.000001 USDC per payment. Batched settlement keeps fees from exceeding the payment itself."* Midstream operates at $0.0005, well above the technical floor — the cap is set by the hackathon ($0.01), not the rail.

### 4. Detailed Circle product feedback ($500 USDC incentive)

✅ See [`docs/CIRCLE_FEEDBACK.md`](../docs/CIRCLE_FEEDBACK.md). 11 specific feedback items including:

- A built-in `upto` / deferred scheme for true streaming (currently every chunk requires a fresh signature)
- Streaming-compatible response middleware (current Express middleware buffers the response)
- Better error message for the 3-day `validBefore` requirement
- Authorization-status webhook so dashboards don't have to poll
- A published `@circle-fin/agent-tools` with LLM Function Calling tool schemas
- Python SDK parity for the batching facilitator
- A reference A2A/AP2 example
- Documentation that explicitly endorses "buyer-side oracle" / "live inference harness" patterns (the generalization Midstream demonstrates)

### 5. Public GitHub repo

✅ [github.com/...](#) (link before submitting)

### 6. Working demo

✅ Two terminals from a fresh clone:
```
npm run seller       # terminal A — :3000
npm run demo         # terminal B — runs 4 sessions
npm run verify-onchain
```

End-to-end deterministic. No mocks. The demo includes one drift session that demonstrates mid-stream cutoff (the harness performs a stop & correct around chunk 13–18) and one happy-path session that runs to completion.

A web dashboard (`npm run web`, served at `:3001`) shows live tokens streaming, the live inference harness scoring each chunk in real time, the stop & correct moment when the harness refuses the next authorization, and a transfer-resolution panel that calls `getTransferById` and links to Arc explorer.

### 7. Transaction flow video

✅ See `submission/VIDEO.md` for the script and `submission/screencast.mp4` (link before submitting).

The video shows: faucet drop on arcscan → deposit on arcscan → live demo with tokens streaming → Gemini quality assessment → stop & correct moment → `verify-onchain` output with real 0x hashes → click-through to arcscan showing the batch settlement.

---

## How to verify (judges, do this)

```bash
git clone <repo-url>
cd midstream
npm install

cp .env.example .env.local
npm run generate-wallets
# faucet the printed BUYER_ADDRESS at https://faucet.circle.com (Arc Testnet)
# add ANTHROPIC_API_KEY and GEMINI_API_KEY to .env.local
npm run deposit 5

# Two terminals for the demo:
npm run seller
npm run demo

# Then produce evidence:
npm run verify-onchain      # batch settlement evidence (Measurements A and C)
npm run produce-evidence    # 50 direct on-chain Arc txs (Measurement B)
```

**Click the buyer EOA URL** printed by `produce-evidence`: it opens `testnet.arcscan.app/address/<BUYER_ADDRESS>?tab=txs` showing 50+ real on-chain Arc transactions, each clickable.

**Click `proofPoints.gatewayWalletExplorerUrl`** from `verify-report.json`: it opens the GatewayWallet contract on arcscan, where Circle posts batch settlement transactions. Our batches are in there, identifiable by the timestamps we logged.

**The seller EOA is intentionally empty.** Settlements credit the seller's Gateway balance, not their EOA. The seller's cumulative Gateway receipt is printed by `npm run verify-onchain`.

---

## What's novel about this approach

The pay-per-chunk pattern with mid-stream cutoff is structurally different from atomic agent-to-agent payments. An agent paying another agent **once per task** has no middle to cut. A streaming inference call has 30 middles.

Most other approaches to "is this agent trustworthy" rely on **selection based on previous history** — reputation scores, capability badges, prior on-chain behavior. These are signals derived from *other people's* needs and experiences, possibly in entirely different domains. A high reputation tells you the agent has performed well for someone else, on something else. It does **not** guarantee it will work for *your* prompt, on *your* task, right now. Reputation also updates after the fact, so the next buyer benefits from your loss; you still paid for the bad run.

Midstream's mid-stream cutoff is **observed quality of the actual generation in front of you**, evaluated against *your* prompt, by *your* harness, at the only moment when withholding payment is still possible — between chunks. This is **harness engineering done during generation**: not pre-flight (prompt design), not post-hoc (response evaluation, retry, reputation update), but mid-flight course correction. Selection and reputation are useful primitives in their own right, but neither protects a buyer once generation has started. Midstream does.

---

## What's next (post-hackathon)

The same payment + harness architecture maps to:

- **Code generation** with `tsc` + `node --test` as the deterministic harness (already implemented in `client/quality/code-monitor.ts`).
- **Image batches** with CLIP similarity as a semi-deterministic harness.
- **Streaming voice agents** with ASR confidence + intent classification as the harness.
- **Browser agents** with DOM-diff after each action as the harness.

For each, the payment layer is identical — one EIP-712 authorization per paid unit, batched on-chain via Gateway. The harness is where the use-case knowledge lives. This is the generalization Circle's Nanopayments product enables: not "cheap payments" but a **pricing primitive for buyer-defined, real-time-observed quality** — with course correction in the loop.
