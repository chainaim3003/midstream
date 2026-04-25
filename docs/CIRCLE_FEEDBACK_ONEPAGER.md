# Circle + Arc Feedback — One-Pager
**Project:** Midstream — Quality-Gated Streaming Inference
**Hackathon:** Agentic Economy on Arc, April 20–26 2026
**Demo cost:** ~$0.20 USDC across 213 paid actions
**Code:** [repo URL] · **Detailed feedback:** `docs/CIRCLE_FEEDBACK.md`

---

## What we built — and what it taught us about the rails

Midstream sells LLM inference **per chunk** with a buyer-side quality oracle that can stop payment mid-stream. Two days, 213 settled paid actions, sub-cent per chunk, on Arc testnet via Circle Gateway batching.

The thesis: *if* sub-cent settlement actually exists *and* per-unit cancellability actually works, then **a new pricing primitive emerges** — pay-per-outcome instead of pay-per-token. Arc + Gateway are the first rails where both halves are real at the same time.

Three things we want Circle and Arc to know.

---

## 1. The pricing primitive is bigger than "cheap payments"

Circle's marketing emphasizes payment cost. The deeper unlock is **buyer-defined quality oracles as a pricing primitive**. Same x402 + Gateway plumbing works for:

| Domain | Oracle | Seen in our demo? |
|---|---|---|
| Text generation | LLM-as-judge | ✅ shipped |
| Code generation | compiler + test suite | ✅ shipped (deterministic — cannot be gamed) |
| Image batches | CLIP similarity | scaffolded |
| Voice agents | ASR confidence + intent | future |
| Browser agents | DOM-diff after action | future |

**Ask:** a reference project from Circle showing two different oracle types over the *same* payment plumbing. Today's docs lean "pay per API call"; the primitive is far broader. Lead with that and we'll see ten hackathon teams build new billing models, not ten copies of the same per-API-call demo.

## 2. The single biggest blocker to LLM-native UX is the missing `upto` scheme

Our `exact` per-chunk loop costs ~31 EIP-712 round-trips for a 1000-token session. Each round-trip adds 200–800ms of buyer/seller latency. **Streaming feels chunky, not smooth.**

A `deferred` / `upto` scheme — buyer signs once for a ceiling, seller streams freely, settlement is `min(consumed, ceiling)` — would cut latency 10–20× and make streaming inference feel native. This is already proposed in [coinbase/x402 #447]. **Ship it.** This single feature unlocks the deep-research / agentic-streaming use case Circle's own marketing leans on.

Adjacent, smaller, equally important:
- **3-day `validBefore` minimum** is awkward for second-long sessions; clarify in SDK error message.
- **Express middleware buffers the response** until settlement; document a streaming-compatible mode where PAYMENT-RESPONSE is a trailing header.

## 3. Observability gap: transfer → batch → on-chain Arc tx isn't a queryable link

Empirically verified during our demo: Circle's `getTransferById` returns `{id, status, token, networks, addresses, amount, timestamps}` — no on-chain tx hash, no batch ID. The transfer→batch→Arc-tx link is implicit in shared `updatedAt` timestamps. We had to *infer* batch grouping by clustering settlements within a 1-second window.

This made our judge story harder than it needed to be: "213 paid actions, all `completed`, settled in 7 batches you can identify by timestamp" instead of "click here for the on-chain tx that settled this authorization."

**Ask:** add to per-transfer record:
```
{ batch_id, on_chain_settlement_tx_hash, on_chain_settlement_block }
```
Or expose `GET /v1/batches/{batch_id}` returning the member transfers and the Arc tx. Or both. Plus a webhook on batch settlement.

This is the gap most likely to cost Circle judge confidence in future hackathons. Builders want to point at a 0x hash for every authorization. Give them one.

---

## What's strongest about Arc + Circle today

- **Arc.** USDC-as-gas eliminates two-token balancing. Sub-second deposit confirmation made our streaming UX feel instant. Block explorer links are clean enough that demo videos record themselves.
- **`@circle-fin/x402-batching`.** Three or four SDK calls bolt clean payment onto a vanilla Anthropic streaming endpoint. No restructuring required.
- **`viem` + `GatewayWalletBatched` domain.** Signed correctly on first try against the real Gateway when we pulled `verifyingContract` from the 402 response.
- **Non-custodial 7-day withdrawal.** Lets us pitch enterprise buyers with "Circle cannot rug you" instead of trust-us language.
- **Reference sample [`circlefin/arc-nanopayments`](https://github.com/circlefin/arc-nanopayments).** Fastest hackathon on-ramp our team has used.

---

## Three asks, ranked by impact

| # | Ask | Why it matters | Effort |
|---|---|---|---|
| 1 | Ship `upto` / `deferred` scheme | Unlocks all streaming-native use cases | High |
| 2 | Expose batch ID + Arc tx hash on transfer records (+ webhook) | Closes the demo/observability story for every Gateway builder | Medium |
| 3 | Publish a multi-oracle reference project | Reframes Nanopayments as a pricing primitive, not just cheap rails | Low |

We'd happily co-build #3 if useful.

---

*Thanks to Blessing Adesiji, Corey Cooper, Evelina Kaluzhner, and Neha Komma for on-site mentorship. Going from `git clone` to real on-chain settled chunks in under two days is Circle's accomplishment, not ours.*

— Midstream team, April 26, 2026
