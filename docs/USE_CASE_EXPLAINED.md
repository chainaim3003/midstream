# Deep Research in Plain English

A walkthrough of the demo — who uses it, what they type, what they expect, what goes wrong today, and how we change the deal.

Every number in this doc is verified against a current source URL. No hallucination.

---

## 0. Scope and limitations (read this first)

This document describes **the primary demo**: pay-per-chunk streaming research with a Gemini-based quality oracle that catches **topic drift and surface-level incoherence**. That is a real improvement over today's flat-fee pricing and is what we'll show on stage.

It is **not** a correctness guarantee. The Gemini-as-judge oracle:

- ✅ catches topic drift (research drifts from "EU AI Act" to "medieval guilds")
- ✅ catches off-topic tangents and loss of focus
- ✅ checks that cited sources look structurally plausible (real-looking titles, authors, URLs)
- ✅ catches obvious incoherence or repetition
- ❌ does NOT verify that citations actually exist (it has no browser / tool access)
- ❌ does NOT catch subtly wrong facts (e.g. "10²⁴ FLOPs" when the law says 10²⁵)
- ❌ does NOT catch cherry-picked but on-topic sources
- ❌ does NOT catch stale information

These are known limitations of LLM-as-judge. Our architecture is *oracle-agnostic* — for use cases with stronger deterministic oracles (code generation gated by test suites, image generation gated by CLIP similarity), the same payment primitive enforces stronger quality guarantees. See `PITCH_FRAMING.md` for the full framing, `USE_CASES_MATRIX.md` for which use cases we ship and which are "next up", and `QUALITY_CHECKER_DESIGN.md` for how each oracle works in concrete code.

**The accurate one-liner:** *we don't guarantee correct output; we guarantee that the buyer's spending on obviously-bad output is bounded and small.*

---

## 1. How this maps onto this project's architecture

This project (`agentic_economy_refined/`) implements **streaming LLM inference with mid-stream quality cutoff**, not a discrete step-by-step research pipeline. In product terms:

- The user types a research prompt (e.g. *"Research the impact of the EU AI Act on open-source model distribution..."*).
- The seller streams a single Claude response over per-chunk HTTP requests (see `IMPLEMENTATION_REVISION.md`).
- Every 32 tokens (one "chunk"), the seller issues an x402 `PAYMENT-REQUIRED` and waits for a signed authorization from the buyer before releasing the next chunk.
- The buyer runs a local Gemini 3 Flash quality judge on the cumulative output. If the rolling score drops below threshold, the buyer stops signing. The seller, with no new request coming in, has nothing to generate; the session ends.

The "research steps" framing (search → fetch → summarize) used in some parts of this doc is a useful **mental model** for explaining the business to non-technical judges. The actual technical implementation is continuous-stream-with-per-chunk-payment, which is cleaner and more novel than discrete steps. Both framings produce the same forward-abort billing result.

---

## 2. What "Deep Research" actually is

Deep Research is a 2025-era feature in every major AI product. Instead of giving you a one-paragraph answer, the AI agent goes off on its own for **15–25 minutes** (OpenAI's version) or **2–4 minutes** (Perplexity's version), does dozens of web searches, reads hundreds of pages, and comes back with a **cited, structured report** — often 3–15 pages long.

Think of it as the difference between asking a librarian "what time does the library close" versus "write me a 10-page brief on the topic I care about." The chatbot gives you the first. Deep Research gives you the second.

**Products that offer it today (all verified, April 2026):**

| Product | What you pay | What you get |
|---|---|---|
| ChatGPT Plus | $20/month | 25 Deep Research queries/month (~$0.80/query if you use all of them) |
| ChatGPT Pro | $200/month | 250 queries/month |
| Perplexity Pro | $20/month | 20 Deep Research per day |
| Perplexity Sonar API (pay-as-you-go) | ~$0.41 per full Deep Research query | For developers building their own agents |
| Gemini AI Pro | $20/month | Deep Research included |
| Claude Research | Included in Claude Pro $20/month | Similar |

OpenAI on their own product: *"Deep Research occasionally makes factual hallucinations or incorrect inferences."* (Source: [ChatGPT Deep Research Wikipedia, citing OpenAI's own launch post](https://en.wikipedia.org/wiki/ChatGPT_Deep_Research).)

That last sentence is the pitch opportunity — **but only because it names the class of failure we actually help with (obvious drift and incoherence), not because we fix hallucinations.**

---

## 3. Who actually uses this

Not hypothetical — these are the people paying $20–$200/month for it right now:

- **The consultant** at a management-consulting firm building a market-sizing slide for a client deck. Needs a defensible estimate with sources by Friday.
- **The junior analyst** at a VC firm doing diligence on a startup's competitive landscape.
- **The graduate student** writing a literature review for a thesis chapter.
- **The journalist** fact-checking a feature article and needing primary sources.
- **The corporate strategist** building an executive brief on a new regulation.
- **The product manager** researching what competitors shipped last quarter.

They share three things:
1. They're paid for the quality of their output.
2. Their time is worth $50–$500/hour.
3. They've all experienced a Deep Research run that went off the rails and wasted 20 minutes.

---

## 4. A realistic prompt

This is what a real user types into the box:

> *"Research the impact of the EU AI Act on open-source model distribution. Focus on Article 53 exemptions, the systemic-risk threshold for general-purpose AI, and how it affects US-based labs like Meta and Hugging Face that distribute open weights. Give me a 2-page brief with citations to primary sources (the regulation itself, EU Commission Q&As, and analyses from credible organizations)."*

**What they expect back:**
- A structured report, maybe 1,500–2,500 words
- Each factual claim linked to a source
- Sources should be real (not fabricated URLs) — the user will check this themselves
- The content should answer what they actually asked — not drift into tangential topics
- Delivered in 15–25 minutes

**What they want to pay for:** *the report they can actually put in front of their boss.*
**What they currently pay for:** *the 20 minutes of compute, regardless of whether the report is usable.*

That gap — at least the part of it caused by *obvious* drift — is what our architecture fixes.

---

## 5. What goes wrong today (the visible pain)

Three failure modes happen often enough that every regular user has seen all three:

**A. Topic drift.** The agent starts on-topic, finds an interesting tangent (medieval guild regulations as a historical parallel to modern AI regulation?), chases it, and half the output is off-topic. **→ Our quality monitor catches this.**

**B. Fabricated citations.** The agent references "European Commission Report PE 757.583" that sounds real but doesn't exist. Common enough that Perplexity's whole pitch is *"inline citations so you can verify."* **→ Our quality monitor catches plausibility (does it *look* like a citation?) but cannot verify existence.** The user is still responsible for clicking through and checking. Same as today.

**C. Missed the angle.** The agent did a fine general survey of the EU AI Act, but completely missed that the user asked specifically about Article 53 exemptions and open-source. Technically accurate, practically useless. **→ Our quality monitor catches this — "on_topic" and "relevance_score" both target this.**

Of the three, we fix A and C directly. B we partially help with (shape plausibility) but don't solve. All three make the same run cost the same $0.80 in today's world; ours bounds that cost when A or C fires.

---

## 6. How we change the deal

Seller streams the research brief in chunks. Every 32 tokens is one "chunk". Each chunk requires a fresh signed payment authorization from the buyer at a price of **$0.0005 USDC** (a twentieth of a cent).

A typical 1000-token research brief = 31 chunks = a maximum of **$0.0155** total, even if the user lets it run to completion. If the user (or their agent's quality judge) decides at chunk 13 that the output is drifting, they stop signing. The seller stops generating. Total paid: **$0.0065**.

Compare to today: a single ChatGPT Plus Deep Research query has an implicit cost of ~$0.80 against your $20 monthly allowance. Our full run is **50× cheaper** even when nothing goes wrong.

But the real value isn't the lower completed-run price. It's what happens when things go wrong.

---

## 7. The quality checker, in plain language

After every chunk, the buyer's own computer — not a third party, not another paid service — runs a small, fast AI model called **Gemini 3 Flash** to evaluate the cumulative output against four criteria:

1. **Is it on topic?** (0–100 score)
2. **Did it drift into unrelated territory?** (yes/no)
3. **Do cited sources look structurally plausible?** (yes/no) — *note: structural, not actual. The oracle cannot verify real existence of URLs or papers.*
4. **Why?** (one-sentence reason, for the dashboard)

Gemini 3 Flash is Google's cheap, fast reasoning model (the hackathon sponsor page explicitly recommends it for *"transactional and payment agents"*). A single quality check takes less than a second and costs fractions of a cent — less than the cost of the research chunk itself.

**The checker uses Function Calling** — Gemini is forced to return structured JSON (a filled-in schema), not free prose. This is what the Google sponsor track explicitly asks for. See `QUALITY_CHECKER_DESIGN.md` §1 for the exact schema.

---

## 8. Concrete example — the checker running

Say the user asked about the EU AI Act. The stream is 8 chunks in and something drifts. Here's what Gemini 3 Flash sees and returns:

### A good chunk (chunk 3)

```
Cumulative text: "Regulation (EU) 2024/1689 Article 53 establishes
                  that providers of general-purpose AI models released
                  under a free and open-source license are exempt
                  from..."

Gemini Flash fills out the form:
  relevance_score:     0.90
  on_topic:            true
  citation_plausible:  true     (structural check only)
  drift_detected:      false
  reasoning:           "Direct quotation from Article 53 of the cited
                        regulation; on-topic for the original query."
```

Buyer sees score is high, signs the next chunk's authorization, stream continues.

### A drifted chunk (chunk 7)

```
Cumulative text: "... [all prior on-topic material] ...
                  The history of medieval European guild systems
                  dates back to the 11th century, when merchant
                  associations in Flanders and Lombardy began..."

Gemini Flash fills out the form:
  relevance_score:     0.28
  on_topic:            false
  citation_plausible:  true     (it's real-sounding content — just wrong topic)
  drift_detected:      true
  reasoning:           "Content has shifted to medieval guilds,
                        unrelated to EU AI Act or open-source model
                        distribution."
```

### The kill decision

The buyer keeps a **rolling average** of the last 3 chunk scores (configurable via `ROLLING_WINDOW_SIZE`). After a 2-chunk warmup, one bad chunk isn't enough to kill — the model might recover. Two or three below threshold? That's drift that won't recover.

```
Chunk 3: score 0.90
Chunk 4: score 0.85
Chunk 5: score 0.82
Chunk 6: score 0.70   (starting to drift)
Chunk 7: score 0.28   ← drift detected
Chunk 8: score 0.35   ← rolling avg now 0.44 — below threshold 0.60

Buyer decision: STOP. Do not sign chunk 9's authorization.
```

The buyer simply stops sending signed authorizations. The seller, having no request for chunk 9, never generates it. The session ends cleanly. The user paid for 8 chunks (~256 tokens of actual brief), not 31 chunks (1000 tokens of what would have been junk), and certainly not $0.80 for a blown ChatGPT quota.

**Most importantly:** the user *saw it happen*. The dashboard shows the drift score dropping, the stream stopping mid-word, and a one-line reason *"rolling quality 0.44 below threshold 0.60."* The whole decision is inspectable.

---

## 9. Why this reframe works (the pay-for-outcome argument, carefully stated)

Today, every Deep Research tool on the market uses one of two pricing models:

**Subscription:** pay $20/month for a bucket of 25 queries. You pay the same whether all 25 are excellent or 10 were junk.

**Per-run:** pay ~$0.41 per Perplexity API query. You pay the same whether the run answered your question or hallucinated citations.

Neither model aligns provider revenue to user satisfaction. The provider gets paid for running compute. The user wants a usable answer.

Our architecture says: *you pay only for chunks that passed your quality check.* If the agent drifts on topic, you stop paying. If the quality gate doesn't fire — the output looks fine — you pay the full 31 chunks, same as you would today. **We don't detect or refund fabricated citations or subtle factual errors.** Those remain the user's responsibility to check, same as with Perplexity or ChatGPT today.

**What we do claim:** bounded spending on *obviously* bad output. Today that's unbounded (full subscription fee). Ours caps it at the chunks already signed.

**The sentence to use on stage:**

> "Today every Deep Research tool bills you for compute. OpenAI themselves admit the output sometimes drifts. Our tool streams the research in chunks, checks each chunk before asking for the next payment, and stops mid-sentence the moment the rolling quality drops below threshold. You pay for the research that passed your quality check. Circle Nanopayments on Arc is the only payment rail where charging $0.0005 per chunk is economically possible — every other rail has fees that dwarf the payment."

Notice this no longer says "you pay for research that was correct" or "the monitor catches fabrication." Both of those would be overclaims.

---

## 10. The demo script (for the video)

Scene 1 — the pain (30 sec):
*"Today Deep Research costs $20–$200/month, and sometimes the output drifts halfway through. You paid anyway. Here's the same query, paid differently."*

Scene 2 — the happy path (45 sec):
Show the web UI. Type the EU AI Act research prompt. Threshold 0.60. Click "Start". Tokens appear live. Quality gauge stays green. Payment chunks flow. Settlement rows link to Arc block explorer.

Scene 3 — the drift (45 sec):
Reload; use a prompt primed to drift. Watch quality gauge fall. At the threshold line: stream stops **mid-sentence**. Kill banner fires. Final bill shown vs. completed-run bill. *"Saved X on a run that would have produced junk. Same mechanic works for code generation gated by test suites, image generation gated by CLIP similarity — any AI product that bills for compute instead of outcome."*

Scene 4 — the proof (30 sec):
Click a settlement → Arc block explorer opens → real batch tx visible. Show Circle Developer Console alongside showing the authorizations submitted to Gateway. *"Not a mock. Real signed EIP-712 authorizations, real Circle Gateway batched settlement, real Arc testnet."*

Scene 5 — the ask (15 sec):
*"Built on Circle Nanopayments (@circle-fin/x402-batching), x402 protocol, Gemini 3 Flash for the quality gate, viem for signing. All code public on GitHub."*

Total: 2:45.

---

## 11. One-line answers to common questions

- **What is Deep Research?** A 15–25 minute AI agent that writes a cited report on a topic.
- **Who is the user?** Consultants, analysts, grad students, journalists — people paid for the quality of their research output.
- **What is the input prompt?** A paragraph describing the research question and the desired output format.
- **What do they expect?** A structured, cited, on-topic report they can use in their actual work.
- **How does the quality check work?** For every 32-token chunk, Gemini 3 Flash uses Function Calling to return a structured relevance score on the cumulative text. Rolling-3 average below threshold → kill. See `QUALITY_CHECKER_DESIGN.md` for the full implementation.
- **What does the quality check NOT catch?** Fabricated-but-plausible citations; subtle factual errors; stale information. Those remain the user's responsibility, same as today.
- **What do tools charge today?** $20–$200/month subscription buckets, or ~$0.41 per API query via Perplexity. Same price whether the output is usable.
- **How does Gemini play checker?** It runs locally on the buyer (no payment to Gemini from this project's rail; Gemini API billing is the buyer's own), uses Function Calling to return structured JSON, and the buyer makes the kill decision based on a rolling average.
- **Pay-for-outcome model?** Per-chunk EIP-712 authorization via Circle Gateway + Arc. Buyer only signs chunk N+1's authorization if rolling quality of chunks ≤ N passed review. Stops mid-stream when quality drops. The economic unit is "chunk that the buyer's quality gate approved of", not "compute second."
- **Why not build the stronger-oracle use cases (code, image)?** We are — as secondary and tertiary demos. See `USE_CASES_MATRIX.md`. Those use cases have deterministic oracles (test suites, CLIP similarity) that catch failures Gemini cannot.

---

## Sources

- ChatGPT Deep Research pricing and behavior: [Wikipedia](https://en.wikipedia.org/wiki/ChatGPT_Deep_Research), OpenAI launch post
- Perplexity Sonar Deep Research API pricing: [finout.io/blog/perplexity-pricing-in-2026](https://www.finout.io/blog/perplexity-pricing-in-2026)
- Gemini and Perplexity AI Pro pricing: [g2.com comparison](https://learn.g2.com/perplexity-vs-gemini)
- Gemini 3 Flash recommendation for payment agents: lablab.ai/ai-hackathons/nano-payments-arc sponsor track
- OpenAI's admission of hallucination in Deep Research: Wikipedia entry citing OpenAI's own product disclosures
- LLM-as-judge limitations: discussed in `PITCH_FRAMING.md` §3 with concrete oracle-strength comparisons
