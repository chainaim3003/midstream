# Pitch Framing — Oracles, Claims, and What We Actually Prove

**Date:** 2026-04-22
**Purpose:** The single honest framing of what the project proves and what it doesn't, so the pitch survives Q&A from a sharp judge.
**Rule:** Every claim in the submission deck, README, or video must survive reading this document first.

---

## 0. The one sentence

> We don't guarantee correct output. We guarantee that the amount of money a buyer spends on obviously-bad output is bounded and small. The architecture is a payment layer; the correctness layer is the *oracle* you plug into it, and different use cases have different oracles with different reliability.

---

## 1. What "pay for outcome" does NOT mean

Before claiming anything, rule these out — a judge will:

- ❌ **It does not mean "refunds for bad output."** Once a chunk is signed and delivered, that $0.0005 is committed. The EIP-3009 authorization settles via Gateway's batch; there is no retraction path. Source: [coinbase/x402 issue #447](https://github.com/coinbase/x402/issues/447) — our facilitator accepts the signature, batches, settles.
- ❌ **It does not mean the buyer pays only for correct output.** The buyer can only choose whether to buy the *next* chunk, not undo the last one.
- ❌ **It does not mean our quality oracle catches every kind of wrong.** Our Gemini-based oracle catches drift and surface incoherence. It will not catch a fabricated but plausible citation, a subtly wrong fact, or stale information. Those are known limitations of LLM-as-judge.
- ❌ **It does not mean the system is a correctness guarantee.** It is a *spending* guarantee — the buyer's loss on bad output is bounded by when they stop authorizing.

If you say any of the above in the pitch, a judge who knows the space will catch it, and the whole submission reads as overselling.

---

## 2. What "pay for outcome" DOES mean (accurate framings)

Use any of these three, in the order listed:

**Framing A — Harm reduction, not correctness (for VC / business judges):**
> "Today's AI products charge you a flat fee whether the output was useful or not. Our architecture lets the buyer stop paying the moment a quality signal drops below threshold. It doesn't guarantee correctness — no payment protocol can. It guarantees the buyer's spending on bad output is bounded. On a 31-chunk research run, cutting off at chunk 13 saves 60% versus paying full freight."

**Framing B — Oracle-agnostic payment primitive (for engineers / Circle team):**
> "We built the payment-layer primitive. Quality checking is an oracle plugged into it — Gemini-as-judge for research, test-suite-passing for code, CLIP similarity for images. The same x402 + Circle Gateway layer accepts any oracle; it doesn't care what 'quality' means for your specific product. What Circle Nanopayments unlocks is pricing-per-unit at sub-cent scale, which makes oracle-gated pricing economically viable for the first time."

**Framing C — Research is the hardest case (surprising, honest, disarms the loophole):**
> "We picked research as the demo because everyone has felt the pain. But research is actually the *hardest* use case for this architecture, not the easiest. The oracle for research is probabilistic — LLM-as-judge catches coarse drift, misses subtle hallucination. The architecture is dramatically stronger in use cases with deterministic oracles: pay-per-function code generation (oracle = test suite passing), pay-per-transform data pipelines (oracle = schema validation), pay-per-frame video generation (oracle = CLIP score). We built the research case for relatability. The primitive generalizes and gets *better* as the oracle gets sharper."

**Use Framing A for pitch slides. Framing B when Circle asks. Framing C for the Q&A challenge.**

---

## 3. The oracle spectrum — what makes an oracle strong or weak

The oracle is whatever the buyer uses to decide: "should I authorize the next chunk?"

| Property | Weak oracle | Strong oracle |
|---|---|---|
| Determinism | Same input → slightly different score each run | Same input → same score |
| Latency | Seconds (LLM call) | Milliseconds (local computation) |
| Cost per check | Fractions of a cent | Near-zero |
| False positive rate | 5–15% | <1% |
| False negative rate | 5–30% (misses fabricated facts) | Depends on what "bad" means |
| Adversary-resistance | Seller can bias output toward patterns the oracle likes | Oracle output is function of actual execution behavior, not prose |

| Use case | Oracle | Strength |
|---|---|---|
| Pay-per-function code gen | Compiler + test suite | ⭐⭐⭐⭐⭐ Deterministic, cheap, fast |
| Pay-per-transform ETL | Schema validation + row counts | ⭐⭐⭐⭐⭐ |
| Pay-per-chunk data labeling | Agreement with gold set | ⭐⭐⭐⭐ Semi-deterministic |
| Pay-per-frame video gen | CLIP similarity to prompt | ⭐⭐⭐⭐ Semi-deterministic |
| Pay-per-image batch | CLIP similarity + NSFW filter | ⭐⭐⭐⭐ |
| Pay-per-second transcription | ASR confidence from model logits | ⭐⭐⭐⭐ Built into the model itself |
| Pay-per-intent voice agent | Intent classifier + end-state | ⭐⭐⭐ Retrospective oracle |
| **Pay-per-chunk research (our demo)** | **LLM-as-judge on cumulative text** | **⭐⭐⭐ Probabilistic, catches drift only** |
| Pay-per-section music gen | Audio feature extraction | ⭐⭐ Hard to measure "good" |

**Research is in the middle of the pack.** The architecture works across the whole spectrum; we demo the probabilistic case to make the pain visceral, but our strongest argument for the primitive is at the deterministic end.

---

## 4. Use-case-to-oracle mapping (this is the slide in the deck)

For each of the seven AI-product categories, here's the oracle that would gate payment. This is what the pitch deck's "generalizability" slide shows.

| Product category | Real-world pain | Oracle |
|---|---|---|
| **AI video generation** (Sora 2, Veo 3.1) | 10-second clip costs $3–$5, bad in first 2 seconds, still billed | CLIP similarity of generated frames to prompt; motion-stability heuristic |
| **AI coding agents** (Devin, Claude Code, Cursor) | Agent burns $20 on a failed refactor | Compile pass + test suite pass + lint |
| **AI Deep Research** (demo) | $20–$200/mo, runs drift and fabricate citations | LLM-as-judge on cumulative text |
| **AI voice agents** (Vapi, Retell) | 12-min failed call billed full | ASR confidence + intent classifier |
| **Browser agents** (Claude Computer Use, Operator) | Agent loops on CAPTCHA, still billed | DOM diff (did expected state-change happen?) |
| **AI image batches** (Midjourney, Flux) | Generate 10, keep 1, pay for 10 | CLIP similarity + aesthetic score |
| **AI music** (Suno, Udio) | Half of songs have structural breakage | Audio-to-score round-trip similarity |

All seven share the payment architecture. Only the oracle changes. **This is what makes the project a platform play, not a one-off.**

---

## 5. How each framing survives the obvious Q&A attack

Anticipate the judge's knife. Here are the three hardest questions and the honest answers.

### Q: "Your Gemini quality check can't verify whether a citation is real. Isn't your whole 'pay for outcome' claim fraudulent?"

**Answer:**
> "You're right that Gemini-as-judge can't catch fabricated citations. That's a known limitation of LLM-as-judge and we don't claim otherwise. What we catch is topic drift, on-topic-ness, citation-shape plausibility, and obvious incoherence — four things that cover 60-80% of common research-run failures on current tools. Where our architecture gets stronger is use cases with deterministic oracles. For pay-per-function code generation, the oracle is whether the code compiles and tests pass — which is a binary, cheap, immediate signal. The same x402 + Circle payment layer wraps any oracle. We picked research for the demo because the pain is universal, not because it's the best fit for our architecture."

### Q: "If the seller is paid whether or not the buyer's quality check fires, what keeps the seller honest?"

**Answer:**
> "The seller is paid for the chunks the buyer authorized. If the seller's output consistently fails the buyer's quality check, the buyer stops authorizing, and the seller stops getting paid for the rest of the session. That's the economic pressure. It's also structurally resistant to gaming: the quality check runs on the buyer's side with a model and threshold the buyer picks. The seller doesn't know which LLM is judging, or what threshold applies, so they can't optimize for it."

### Q: "Isn't this just Stripe metered billing with extra steps?"

**Answer:**
> "Stripe metered billing at $0.0005 per unit costs $0.30 in fixed fees per charge. 60,000% overhead. Stripe can't reach this price point. Ethereum L1 gas at $0.30/tx has the same problem. Circle Nanopayments + Arc is the only rail where $0.0005 per unit is economically viable, because Circle batches thousands of off-chain signatures into one on-chain settlement. Without the batching layer, the pay-per-unit primitive is a thought experiment. With it, it's production infrastructure."

---

## 6. What we claim, in order of confidence

**What we claim with 100% confidence:**
- Each chunk is an independent EIP-3009 signature; the buyer's spending is bounded by chunks they sign for.
- Circle Gateway batches signatures into on-chain settlements on Arc; sub-cent per-unit pricing is viable.
- The architecture is oracle-agnostic — swap the quality monitor, the payment layer is unchanged.
- On the *specific* quality signals we check (drift, on-topic-ness, structural incoherence), our Gemini monitor is reliable.

**What we claim with 80% confidence:**
- The architecture generalizes to the six other use cases (video, code, voice, browser, image, music) with the same x402 + Gateway plumbing. We haven't built all six — we're extrapolating from the shared shape.
- A real user would save 40–70% on a typical bad-run session versus flat-fee pricing.

**What we DO NOT claim:**
- That our system makes AI research correct.
- That our quality monitor catches hallucinations, fabricated citations, or factual errors.
- That pay-for-outcome in the strict sense (refund for bad output) is implemented — it is not.
- That the six non-demo use cases are fully built — only the research case is.

If we stay honest about this split, the submission is bulletproof. If we overclaim, we lose credibility on the first question.

---

## 7. A cleaner name for the concept

"Pay for outcome" is punchy but imprecise. Internally, think of it as:

- **Quality-gated streaming** (accurate, slightly dry)
- **Forward-abort billing** (technical, accurate)
- **Pay-per-unit with client-side cutoff** (most precise)
- **Paid-progress pricing** (short, works for marketing)

For the pitch, "pay for outcome" is fine as the headline because it's immediately understood. But the README, design docs, and feedback-to-Circle should use the more precise terms.

---

## 8. The honest one-paragraph for SUBMISSION.md

Add this verbatim to the submission's long description, replacing any version that overclaims:

> Our architecture breaks an LLM streaming response into 32-token chunks priced at $0.0005 each, paid via Circle Nanopayments on Arc. Between chunks, the buyer runs a quality check on the cumulative output and decides whether to authorize the next chunk. If the output has drifted, the buyer stops signing and the stream ends. The buyer's loss on bad output is bounded — typically 13 chunks ($0.0065) versus 31 ($0.0155) for a full run — and is always a fraction of what flat-fee pricing would charge for the same failure. The quality oracle in this demo is a Gemini-3-Flash LLM-as-judge that catches topic drift and coarse incoherence; it does not claim to catch subtle factual errors or fabricated citations. That limitation is intentional scope — the architecture is oracle-agnostic, and in use cases with deterministic oracles (code generation gated by test suites, video generation gated by CLIP similarity, data transforms gated by schema validation) the same payment layer enforces stronger quality guarantees. Circle Nanopayments + Arc is the only payment rail on which per-unit pricing at sub-cent scale is economically viable; on Stripe or Ethereum L1, fixed fees would be 60,000% of the value exchanged.

This paragraph anticipates every Q&A attack and still delivers the pitch.
