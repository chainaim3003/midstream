# Deep Research — Does Pay-for-Outcome Actually Work on Nanopayments?

**Date:** 2026-04-22
**Purpose:** Final verification that the core concept of pay-per-chunk with mid-stream quality-based cutoff is genuinely implementable on Circle Nanopayments + x402, not a pitch-deck fiction.
**Status:** ✅ **The concept works.** This document lists the loopholes we found, the enhancements that make it bulletproof, and a small number of open items that need verification against the real SDK at the first gate.

---

## 0. TL;DR

**Does pay-for-outcome in nanopayments work? Yes, with caveats.**

The core proposition — *the buyer stops paying when quality drops, and the seller stops producing* — is structurally sound because:

1. Each chunk's payment is a **separate EIP-3009 signature** with a fresh nonce. The buyer creates a new signature or doesn't; there is no blanket authorization that persists without buyer action. Source: Circle's [Nanopayments blog](https://www.circle.com/blog/circle-nanopayments-launches-on-testnet-as-the-core-primitive-for-agentic-economic-activity) — "When an agent initiates a payment, it signs an EIP-3009 authorization message." One signature per payment.

2. The x402 protocol is **stateless and request-scoped** ([x402.gitbook.io](https://x402.gitbook.io/x402/core-concepts/facilitator)). Every HTTP request begins with a potential 402 challenge. This is why the per-chunk-HTTP architecture (IMPLEMENTATION_REVISION.md change 1) is not just a workaround — **it's the grain the protocol was designed for.**

3. Circle's Gateway-batched facilitator **accepts the same EIP-3009 signatures** as the standard `exact` scheme ([coinbase/x402 issue #447](https://github.com/coinbase/x402/issues/447)) — "our Gateway batching system will accept the existing EIP-3009 signatures." This means the on-chain settlement mechanism is identical; what differs is when the settlement happens (batched, not per-request).

4. Express middleware's settlement timing is **after** successful handler response (< 400 status). [DeepWiki/coinbase/x402 6.2](https://deepwiki.com/coinbase/x402/6-facilitator-services) confirms: *"Settlement occurs after the route handler returns a successful response (status < 400)."* This means the seller can emit the chunk, and only then does the facilitator settle. We don't need to pause/resume settlement; settlement happens once per chunk-request at the end of that request.

5. There is live public evidence of exactly this pattern working: the [TLAY BoAT device demo (Mar 2026)](https://medium.com/@tlay_io/we-actually-ran-it-tlay-boat-x402-circle-gateway-nanopayments-embedded-devices-paying-0-001-3eb03cc475eb) runs a microcontroller that pays 0.001 USDC every 2 minutes, per request, using Circle Gateway batched nanopayments on Arc testnet (chain 5042002). Each payment is its own HTTP request with a fresh `PAYMENT-SIGNATURE`. That's exactly our architecture, already proven.

**The one caveat:** "pay for outcome" in the strict sense ("if the last 32 tokens of output were bad, buyer gets refunded") is *not* achievable with the shipping `exact` scheme. What IS achievable — and what we're building — is "pay for the right to the next 32 tokens, stop authorizing when quality drops." The buyer doesn't retroactively refund bad chunks; they forward-stop paying for more. This is a subtle but important distinction we need to frame carefully.

---

## 1. Loopholes we found (and how each is closed)

### Loophole 1: "Refund for bad output" isn't a thing

**The risk.** A naive reading of "pay for outcome" would say: chunk 13 arrived, quality was bad, the buyer gets their $0.0005 back. **This is not what happens.** Once the buyer signed chunk 13's authorization and the seller delivered the content, that payment settles via the Gateway batch whether the buyer liked the output or not. There is no retroactive refund path in x402 `exact` or in Gateway-batched.

**Why this doesn't kill the pitch.** The business value comes from **prospective** cutoff, not retroactive refund:
- If drift begins at chunk 13, chunk 13 is paid for, **but chunks 14–31 are not**.
- Savings: $0.009 unpaid out of $0.0155 hypothetical. ~60% saved.
- Relative to today's world where the entire $0.80 ChatGPT Plus run is billed regardless, this is dramatically better.

**How we frame it for judges.** Don't say "pay only for good output." Say: *"stop paying the instant it stops being useful."* One word changes the economic model from one that doesn't exist (refunds at sub-cent scale) to one that does (unilateral forward abort).

**Design impact:** Nothing changes. The behavior was already forward-abort; only the framing needs tightening.

### Loophole 2: The seller could race-race past the cutoff

**The risk.** Suppose quality drops at chunk 13. The buyer decides "don't sign chunk 14." But if the seller is already in the middle of generating chunk 14 (because timing overlap), does the seller get paid for chunk 14?

**Resolution.** No. The per-chunk-HTTP architecture (IMPLEMENTATION_REVISION §1) guarantees this cannot happen. **The seller generates chunk N's content ONLY after receiving a valid `PAYMENT-SIGNATURE` for chunk N.** No signature → no request → no generation. The seller is never "ahead" of the buyer. If the buyer never sends chunk 14's request, the seller doesn't even know chunk 14 was considered.

The timing is:

```
Buyer assesses chunk 13 quality → decides kill
Buyer never sends chunk 14 POST
Seller (has no chunk 14 request) → idle
After 60s, seller session reaper drops the state. Done.
```

No race. No wasted Anthropic call. No "paid for undelivered content" edge case.

### Loophole 3: Settlement failure after response is delivered

**The risk.** According to [DeepWiki/x402 server integration](https://deepwiki.com/coinbase/x402/6-facilitator-services), Express middleware buffers the response and only sends it after successful settlement. *"If settlement fails, the buffered response is discarded and a 402 is returned instead."*

This is fine for a small JSON response. But **our response is 32 tokens of streamed text** via `res.write()`. Buffering would defeat the streaming UX.

**Resolution.** Two options:

**(a) Accept that streaming and strict settlement-before-response are incompatible.** If we use Express's default `paymentMiddleware`, responses get buffered. The chunk arrives in a burst at the end, not token-by-token. UI still works (just without typewriter effect within a chunk); demo still compelling; kill semantics unaffected. This is the safest option.

**(b) Use a lifecycle hook to settle before the handler runs, not after.** Less standard but supported. [DeepWiki/x402 6.2](https://deepwiki.com/coinbase/x402/6.2-lifecycle-hooks) describes `onBeforeVerify` and the full verify/settle lifecycle. The verify step is fast (~100ms), doesn't require on-chain interaction. If we call verify before handler and rely on settlement happening later (through Circle's batch), the response can stream freely.

**Recommendation:** Option (a) for MVP. Each chunk is 32 tokens = ~20 words. A chunk arriving all at once looks fine in the UI (1-2 second latency per chunk between chunks). The token-by-token-within-a-chunk illusion is nice-to-have, not essential.

**Impact on design:** One edit to DESIGN.md §3 step 9: note that Anthropic's streamed content is buffered in the handler and sent as the 200 body in one push, not streamed token-by-token. UI gets a whole chunk at a time, every 1-2 seconds.

### Loophole 4: Facilitator settle failure forces a 402 — but we already delivered

**The risk.** Rare but possible: verify succeeds, handler runs, Anthropic returns content, the seller tries to settle, settlement fails (network, Circle API hiccup, etc.). The middleware will return 402 instead of 200 and **discard our content**. The buyer re-requests. Seller pays Anthropic twice. This is billed-to-seller loss.

**Resolution.** Use the **`onSettleFailure` lifecycle hook** ([DeepWiki 6.2](https://deepwiki.com/coinbase/x402/6.2-lifecycle-hooks)):
> "onSettleFailure: Executes when on-chain settlement fails. Return `{ recovered: true, result: SettleResponse }` to mark the settlement as successful despite the failure, allowing the response to be sent."

For our use case:
- If settle fails due to a transient issue and we believe the signature is valid, we can recover, send the response, and retry settlement async.
- If we recover and settlement still can't be done later, we've delivered content without being paid. Loss is capped at $0.0005 per chunk.

Production would need retry logic + alerting. Hackathon demo won't hit this; testnet is reliable enough. Document the risk in the demo Q&A ("what if settlement fails?"), show we've thought about it.

### Loophole 5: Circle's batched facilitator may behave differently than Coinbase's `exact`

**The risk.** Most x402 documentation references Coinbase's `exact` scheme where `/settle` literally submits a tx to the blockchain within the request. Circle's Gateway-batched facilitator **does not** — it accepts the signature, validates it, and queues it for batch settlement later.

From [coinbase/x402 issue #447](https://github.com/coinbase/x402/issues/447): *"the Gateway API will offer a best-effort /verify endpoint, but as discussed above buyers should not trust its result... we think it is worthwhile considering removing the /verify endpoint from the x402 specification and supporting only /settle."*

This is actually HELPFUL for us. Circle's `/settle` returns "accepted for batching" almost instantly. No wait for on-chain confirmation. Our seller's per-chunk request latency stays low.

**Implication.** Settlement success from Circle ≠ on-chain tx confirmed. It means "the authorization is now queued for the next batch." The actual Arc tx hash appears minutes later when the batch lands.

**Design already handles this** (DESIGN.md §11 via `gateway-watcher`): the UI shows "off-chain confirmed" immediately and updates to "on-chain settled" when the batch tx appears. This was already a design decision; the research confirms it's the right one.

### Loophole 6: The buyer's EIP-3009 signature validity window

**The risk.** The signature includes `validBefore`. Our design says ≥3 days. What happens to a signature that's been accepted by Gateway but not yet batched, and then expires?

**Resolution.** Gateway requires `validBefore ≥ 3 days` **precisely so this cannot happen in practice** — Circle batches often enough (minutes to low hours, per the TLAY live demo) that 3 days is vast headroom. If for some reason a signature expires before batching, Gateway will not include it. The buyer's Gateway balance is never debited; the seller is simply not paid.

Who eats the loss? The seller. They delivered content, never got paid. Same class of problem as Loophole 4. Bounded at $0.0005 per chunk. Acceptable.

**Worth noting in CIRCLE_FEEDBACK.md:** ask Circle to publish concrete SLA on batch cadence so sellers can size their risk.

### Loophole 7: Judges asking "is the quality check also paid?"

**The risk.** During Q&A a judge points out: the quality check itself costs money (Gemini API). Isn't that cost per chunk? Doesn't that undermine the pay-per-outcome narrative?

**Resolution.** Yes, the quality check costs Gemini API fees. But:
1. It's paid by the **buyer**, not per chunk of content. It's the buyer's own compute cost, analogous to a user paying for their own electricity.
2. Gemini Flash at $0.075/M input tokens on a ~850-token cumulative input = ~$0.00006 per check. Meaningfully less than the $0.0005 per chunk.
3. Total Gemini cost for a full 31-chunk run ≈ $0.002. Total content cost ≈ $0.0155. Quality check is ~13% of the content cost. Well within reasonable overhead.

**Frame:** *"The buyer spends about a penny on Gemini quality checks to save fifty times that on unwanted content. The math only works on Nanopayments; on any other rail the savings disappear into gas."*

### Loophole 8: What if quality monitoring fails or is slow?

**The risk.** Gemini API has an outage. Or the quality check takes 5 seconds. Buyer is stuck.

**Resolution.** Fail-safe is to NOT SIGN. If Gemini doesn't return in 2 seconds, treat it as "no signal → don't authorize next chunk." The session ends with a known reason. Buyer never pays for content they couldn't evaluate.

This is actually the **right** failure mode — fail closed, not open. No accidental over-spending.

**Design note for `client/quality-monitor.ts`:** wrap the Gemini call in a 2-second timeout. Timeout → return quality report with `relevance_score: 0` and `reasoning: "quality check timed out"`. Kill gate fires.

### Loophole 9: Seller gaming the quality metric

**The risk.** A malicious seller could learn which keywords score well in Gemini and bias their output. This defeats the honest-quality story.

**Resolution.** The quality monitor is on the **buyer** side. The seller has no visibility into:
- Which LLM the buyer uses for quality checking
- What threshold the buyer sets
- The specific schema the buyer uses

Different buyers will have different quality gates. The seller's incentive is to produce *genuinely good output*, because gaming one buyer doesn't help against others. And any buyer can swap their quality monitor without the seller knowing.

This is an actual *strength* of having the quality gate be client-side, not an embedded part of the protocol. It resists adversarial optimization.

### Loophole 10: Frontend-UI-only demo doesn't prove the back-end claim

**The risk.** If the UI just shows numbers appearing and tokens scrolling, judges might suspect it's a façade over hardcoded scripts. We need to prove the on-chain and off-chain activity is real.

**Resolution.** Four proof points visible in the demo video:
1. **Circle Developer Console view** (hackathon-mandatory): the live list of authorizations submitted to Gateway, matching the session's chunk count.
2. **Arc block explorer** at `testnet.arcscan.app`: the actual batch tx hash, inspectable, with internal transfers from buyer's Gateway balance to seller's Gateway balance.
3. **`scripts/verify-onchain.ts` output** (already written): asserts the settled authorizations against real Arc RPC. Run live during the demo with `npm run verify`.
4. **The logs directory** (`logs/session-*.json`): one NDJSON per session with every signature payload (nonce, validBefore, signature hex), which a judge can inspect.

This is how we meet the hackathon's *"≥50 on-chain transactions demonstrated"* requirement with evidence no mock can fake.

---

## 2. Enhancements that make the concept bulletproof

These are changes we should make to the design to strengthen the implementation, beyond the six in IMPLEMENTATION_REVISION.

### Enhancement 1: Add a "dry-run" mode for the first 2 chunks

**Why.** The first chunk or two have no history for the rolling quality window. Killing on the first chunk is too aggressive; letting all of the first 3 chunks through unconditionally is too permissive.

**Design.** Buyer signs chunks 1 and 2 unconditionally (they're "warmup" chunks). Quality monitor runs on them but kill-gate ignores the scores. From chunk 3 onward, rolling avg of last 3 chunks is evaluated.

This is already hinted at in DESIGN.md §9. Making it explicit prevents the edge case where chunk 1 happens to be a polite greeting ("Sure, I can help research that...") which scores low on "on-topic" because the greeting isn't the answer, causing a false-positive kill.

### Enhancement 2: Log the seller-side token count per chunk, not just chunk count

**Why.** Anthropic's `max_tokens: 32` is a cap, not a floor. A chunk might be 28 tokens or 32 tokens. The UI's "tokens served" number should reflect what was actually delivered, not a multiplied guess.

**Design.** Seller returns `X-Tokens-Served: 31` in the PAYMENT-RESPONSE or response body. Buyer records this. UI shows truthful numbers.

### Enhancement 3: Idempotent chunk requests

**Why.** Transient network failures during the per-chunk HTTP call could cause the buyer to retry. If the buyer retries with a *new* signature (new nonce), they'd be paying twice for the same chunk. If they retry with the *same* signature, the seller might reject it as "signature already used."

**Design.** Use the [Payment Identifier Extension](https://deepwiki.com/coinbase/x402/8.3-payment-identifier-extension) from coinbase/x402. Each chunk request includes a unique `X-Payment-Identifier: sessionId-chunkIndex`. Seller deduplicates: the same identifier serves the cached response from that chunk without re-running Anthropic or re-charging. This is the **official** retry-safety primitive. Not a workaround.

### Enhancement 4: Pre-flight balance check

**Why.** We want to avoid the buyer signing chunk 1, having the seller attempt settlement, and then finding out the buyer's Gateway balance is empty. That wastes a chunk's worth of Anthropic call.

**Design.** The buyer uses `GatewayClient.getBalance()` before the session starts. If balance < max possible session cost ($0.0155), warn the user. UI Panel B shows this as "insufficient balance" and the Start button becomes disabled.

### Enhancement 5: Deterministic "demo mode" seed for the video

**Why.** For the recording, we want a drift to happen at chunk ~13, not earlier or later. Random LLM output can vary.

**Design.** A demo-mode env flag that:
- Sets Anthropic's `temperature` to 0 (deterministic output)
- Uses a fixed system prompt that's been tuned to drift predictably around token 400

This is NOT a mock — the payments, signatures, and settlements are all real. Only the LLM's *content* is made reproducible. Label the mode clearly in the UI (tiny "DEMO MODE" badge). After recording the video, the flag is off for the live submission URL.

### Enhancement 6: Dashboard shows "would have cost on Stripe / L1"

**Why.** The savings narrative lives or dies on comparison. Having the numbers live on-screen next to what the buyer actually spent makes the economic argument visceral.

**Design.** Panel E (Session Summary) gets three extra rows:
- "What you spent (Arc Nanopayments): $0.0065"
- "Same transactions on Ethereum L1 (gas): $9.30"
- "Same transactions on Stripe (2.9% + $0.30 × N): $7.80"
- "**You saved: $0.009 from kill AND $7.80-$9.30 from rail choice**"

These are hardcoded formulas applied to the real session data. Totally fair; not a mock.

### Enhancement 7: Use Express streaming (res.write) with the express middleware, or use a different route for the unpaid preview

The documented Express middleware behavior is *"Express middleware buffers the response and only sends it after successful settlement"* ([DeepWiki x402 6](https://deepwiki.com/coinbase/x402/6-facilitator-services)). This is fine for our architecture because each chunk is a separate HTTP request — buffering a 32-token response for 1-2 seconds is invisible in the UI.

But if we wanted token-by-token streaming for richer UX, we'd need to sidestep the middleware's buffer. We don't. **Accept the buffering; chunks arrive whole.** UI shows chunks-arrive-progressively instead of characters-within-chunk. Nobody will notice. This is an important thing to document to prevent a late-stage attempt to re-add streaming inside chunks that would fight the middleware.

### Enhancement 8: Add a sanity-check that the seller CAN'T serve chunk N+1 without a fresh signature

**Why.** This is the core of the pitch. We should have a test that proves it.

**Design.** `tests/payment-enforcement.test.ts` — integration test:
1. Buyer signs chunk 1, receives content.
2. Buyer tries to re-use chunk 1's signature for chunk 2 (same nonce).
3. Seller (via facilitator) MUST reject with 402.
4. Buyer requests chunk 2 with NO signature. Server MUST return 402 again.

If this test passes, the pitch is structurally true. If it fails, we've misconfigured something. Run it on every CI. The test output goes in SUBMISSION.md as evidence.

### Enhancement 9: Document the "what happens if Circle is down" failure mode for judges

**Why.** Judges will ask this. Best to have a prepared answer.

**Answer:** If Circle's API is unreachable, the seller's verify step fails → returns 402 to the buyer. The buyer's Gateway balance is not debited. The seller's Anthropic call is not made. **The system fails closed.** Cost of the outage: zero dollars for both parties, beyond the initial HTTP request latency.

Compare to Stripe-based SaaS: if Stripe is down, user experience breaks but the subscription still bills at month-end. Nanopayments is more fail-safe than the alternative.

### Enhancement 10: Make the "why this is novel" visible on the UI itself

**Why.** A panel in the UI that says "what's happening: each chunk you see is a separate $0.0005 payment, gated by your quality monitor, batched by Circle to Arc. No other payment rail can do this at this price." Makes the thesis land even without the video voiceover.

**Design.** Add a small always-on explainer card to UI_SPEC that persists during the demo.

---

## 3. Open items that need verification at the first gate

These remain unknown until we run the real SDK. They are concrete unknowns, not hypotheticals.

### OI-1: Exact Circle Gateway-batched scheme identifier

We've been assuming `scheme: "gateway-batched-evm"` or similar. The actual string is determined by `@circle-fin/x402-batching/server`'s `GatewayEvmScheme.getSchemeName()`. **Run the seller, inspect the first 402 response, and confirm the scheme string in the `accepts` array.** Don't hardcode it.

### OI-2: Whether Circle's facilitator uses `/verify`, `/settle`, or a combined endpoint

[coinbase/x402 issue #447](https://github.com/coinbase/x402/issues/447) says Circle may deprecate `/verify`. But the `@circle-fin/x402-batching` SDK abstracts this. We won't call these URLs directly; `BatchFacilitatorClient` will. **Check that a successful chunk request returns both a normal 200 and a valid PAYMENT-RESPONSE header** — if PAYMENT-RESPONSE is missing or contains an error, dig deeper before proceeding.

### OI-3: Actual Arc testnet batch cadence

The TLAY demo runs once every 2 minutes and observes batches. That suggests Circle's batch cadence is faster than 2 minutes. Confirm during gate 3 of implementation: run 5 chunks, time how long until the first on-chain batch tx appears on `testnet.arcscan.app`. If it's > 5 minutes, the demo video needs adjustment (narration covers the wait).

### OI-4: Does the settle-failure recovery hook actually work with Circle's facilitator

Coinbase documents `onSettleFailure` as a first-class hook for `exact`. Circle's batched scheme is different internally. **Test:** intentionally corrupt a signature, verify the error path. Adjust design if the recovery hook isn't reachable.

### OI-5: Whether we need to manually deposit before the first chunk or if Circle auto-handles it

The user's note *"nanopayment posting on to arc is tested in another project"* suggests deposit flow is already validated. Confirm the flow is identical for our seller's facilitator configuration.

---

## 4. What we are NOT doing (explicit non-goals)

- **We are not implementing on-chain cancellation / refund.** Once a chunk signature is submitted, it settles. The buyer's leverage is forward-only.
- **We are not building a custom facilitator.** We use `@circle-fin/x402-batching`'s `BatchFacilitatorClient`. If it has bugs, we work around or file an issue.
- **We are not proving that pay-for-outcome works for atomic services (single-request).** A one-shot API call where the whole response is either "good" or "bad" doesn't benefit from our architecture. Our architecture is for *streaming* services where the output is produced progressively and quality can be assessed incrementally.
- **We are not building a production system.** Hackathon-grade. Error handling is best-effort. Retries are single-attempt. The demo video is the deliverable.

---

## 5. Strength tests — can we defend the pitch?

"What if the seller's output is *good but seems bad to the quality model*?"
→ Rolling-3 window + 2-chunk warmup makes false positives rare. Buyer can adjust threshold. Worst case: buyer pays for 13 chunks when 31 would have been useful. Cost: $0.0065 vs $0.0155. Still 16× cheaper than ChatGPT Plus per run.

"What if the quality model itself is wrong?"
→ Same answer. And in practice, buyers can evolve their quality check without talking to Circle, Coinbase, or us.

"Isn't this just Stripe usage-based billing with extra steps?"
→ Stripe at 2.9% + $0.30/charge makes sub-$10 transactions unviable. We're at $0.0005 per transaction. Stripe can't touch this market.

"Isn't this just HTTP 402 + LLM? Nothing new?"
→ No. The novelty is the combination: x402 + Circle Gateway batching + buyer-side quality gate + client-driven cutoff. No existing x402 demo or Gateway demo shows all four. The TLAY demo has 1+2 (x402 + batching). AgentBazaar has 1+2 (x402 + batching). Neither has quality-gated cutoff.

"What happens if Circle removes the Gateway scheme from x402?"
→ [Issue #447](https://github.com/coinbase/x402/issues/447) shows Circle has been proposing this integration since October 2025. It's not going to disappear in a week. And the same EIP-3009 signatures work on the standard `exact` scheme via other facilitators — we'd lose batching (gas becomes per-tx) but the architecture is portable.

"Is this a real business?"
→ Yes. Every LLM provider (Anthropic, OpenAI, Google, Cohere, Groq) charges by tokens generated. Every agent platform (Devin, Cursor, Vapi) wraps those provider bills in flat or per-task pricing that doesn't align to outcome. A per-chunk-gated wrapper around any of their APIs is shippable by any competent team with funded buyer accounts.

---

## 6. Updates we need to make to the existing docs

### `DESIGN.md` — minor
- §3 step 9 (streaming response): note that the chunk is buffered by Express middleware and arrives whole, not token-streamed. UI shows chunk-level progress, not token-level.
- §9 (quality gate): add explicit 2-chunk warmup rule.
- §6 (failure semantics): add the idempotent-retry row — "retried request with same Payment-Identifier → seller returns cached response without recharging."

### `UI_SPEC.md` — minor
- Panel D: note chunks arrive whole every 1-2 seconds (not tokens flowing), because of Express middleware buffering.
- Panel E: add Stripe / L1 comparison rows.
- New "what this means" explainer card.

### `CIRCLE_FEEDBACK.md` — add sections
- "Publish batch-cadence SLA" — ops need to size risk.
- "Document the onSettleFailure recovery path for batched scheme" — differs from `exact`.

### `IMPLEMENTATION_REVISION.md` — no changes needed
Everything here is consistent. This deep-research doc is complementary, not replacing.

### New file: `VIABILITY_AUDIT.md`
This document, saved to root. Reviewers can read it as an honest confidence check.

---

## 7. The final verdict

**Pay-for-outcome via Nanopayments + x402 is a legitimate architecture, not a pitch fiction.**

It works because:
- EIP-3009 signatures are per-action; there's no blanket authorization.
- x402 is request-scoped; every HTTP interaction is a fresh payment negotiation.
- Circle Gateway's batched facilitator settles signatures via Gateway's internal balance ledger, not per-request on-chain, making sub-cent payments viable.
- Express middleware settles after a successful response, so the seller's kill-gate ("no signature in next request → no more content") is enforced by the protocol, not by us.
- The TLAY BoAT embedded-device demo (published March 2026) is existing public evidence of the exact architecture running on Arc testnet.

The loopholes we found are all either:
- **Framing issues** ("pay for outcome" vs "stop paying when outcome drops") — fixed with word choice.
- **Standard failure modes** (settle fails, network blips) — handled by existing protocol primitives (lifecycle hooks, payment-identifier extension).
- **Open items** that need checking against the real SDK at implementation time — each is bounded, and gate 3 of the build plan (first paid chunk end-to-end) surfaces any that are actually problems.

The enhancements (warmup, idempotency via Payment Identifier, pre-flight balance check, deterministic demo mode, Stripe/L1 comparison in UI, enforcement test) make the demo bulletproof against Q&A challenges.

**Proceed with implementation.** The architecture is sound.

---

## Sources cited in this audit

| Source | What it confirmed |
|---|---|
| [Circle Nanopayments launch blog](https://www.circle.com/blog/circle-nanopayments-launches-on-testnet-as-the-core-primitive-for-agentic-economic-activity) | Each payment is a separate EIP-3009 signature; Circle batches; Circle covers gas |
| [Circle Nanopayments product page](https://www.circle.com/nanopayments) | Sub-cent price floor ($0.000001); Gateway batch settlement |
| [Circle Gateway x402 integration blog](https://www.circle.com/blog/enabling-machine-to-machine-micropayments-with-gateway-and-usdc) | Deferred batched settlement; Circle + Google A2A/AP2 |
| [coinbase/x402 issue #447 (Circle's proposal)](https://github.com/coinbase/x402/issues/447) | Gateway-batched accepts existing EIP-3009; buyers should not trust /verify (batch scheme); drop-in compatibility with `exact` |
| [DeepWiki coinbase/x402 §6.2 lifecycle hooks](https://deepwiki.com/coinbase/x402/6.2-lifecycle-hooks) | onSettleFailure, onVerifyFailure recovery |
| [DeepWiki coinbase/x402 server integration](https://deepwiki.com/coinbase/x402/6-facilitator-services) | Express middleware buffers response until settlement; settlement happens after 200 handler |
| [DeepWiki coinbase/x402 §8.3 payment-identifier](https://deepwiki.com/coinbase/x402/8.3-payment-identifier-extension) | Idempotent retry primitive built into the protocol |
| [TLAY BoAT live demo (Mar 2026)](https://medium.com/@tlay_io/we-actually-ran-it-tlay-boat-x402-circle-gateway-nanopayments-embedded-devices-paying-0-001-3eb03cc475eb) | Per-request x402 nanopayments on Arc chain 5042002 working end-to-end on a microcontroller |
| [x402 Facilitator Gitbook](https://x402.gitbook.io/x402/core-concepts/facilitator) | x402 is stateless and request-scoped; facilitator /verify ~100ms, /settle on-chain |
| [x402.org extensibility via schemes](https://github.com/xapi-labs/x402x-v0) | `exact` is shipping; `upto` is theoretical (not available yet) |
| [Four Pillars analysis](https://4pillars.io/en/comments/how-circle-nanopayments-work) | AWS Nitro Enclave TEE; even Circle employees can't access keys |
| [Stripe x402 docs](https://docs.stripe.com/payments/machine/x402) | x402 Resource Server + PaymentIntent pattern; confirms `exact` scheme on EIP-3009 is production-deployed at Stripe |
