# Circle Product Feedback

**Hackathon-mandatory deliverable.** Eligible for the $500 USDC Product Feedback Incentive ([lablab.ai/ai-hackathons/nano-payments-arc](https://lablab.ai/ai-hackathons/nano-payments-arc)).

**Team:** [YOUR TEAM NAME]
**Project:** Quality-Gated Streaming Inference (Pay-Per-Chunk with Mid-Stream Cutoff)
**Track:** Per-API Monetization Engine (primary) + Agent-to-Agent Payment Loop (secondary)
**Circle products used:** Arc, USDC, Circle Nanopayments, Circle Gateway

---

## 1. Which Circle products we used and why

| Product | Why we chose it |
|---|---|
| **Arc testnet** (chain 5042002) | USDC as the native gas token removes two-token balancing. Sub-second finality (~0.5s deposit confirmation per Circle docs) made our streaming UX feel instant. |
| **USDC on Arc** | Dollar-denominated pricing lets us publish "$0.0005/chunk" without hedging for token volatility. Users understand it immediately. |
| **Circle Nanopayments** (`@circle-fin/x402-batching`) | Without it, per-chunk streaming pricing at $0.0005 does not exist as a product category. Any other rail has fees 100×+ larger than the payment. |
| **Circle Gateway** | One-time deposit → unified balance → every subsequent chunk is a signed EIP-712 authorization, zero gas per chunk. `GatewayWalletBatched` EIP-712 domain with `verifyingContract` pulled from the 402 response at runtime (never hardcoded). |
| **`@x402/express` + `@x402/evm`** | Clean x402 HTTP layer with the three headers (`PAYMENT-REQUIRED`, `PAYMENT-SIGNATURE`, `PAYMENT-RESPONSE`). Seller wraps its chunk endpoint with `paymentMiddleware()` from the SDK. |

We did not use Circle Bridge Kit or CCTP in the MVP — buyer and seller both on Arc testnet. Cross-chain payouts are a natural v2.

---

## 2. What worked well

1. **`@circle-fin/x402-batching` + `@x402/express` integration.** Seller code is three or four SDK calls around our Anthropic per-chunk route. Adding a payment layer did not require restructuring the application flow.
2. **`GatewayEvmScheme` on the server, `CompositeEvmScheme` / `BatchEvmScheme` on the client** — the SDK handles domain construction, signature verification, and settlement submission. We never hand-wrote typed-data signing from scratch.
3. **`viem` for EIP-712 signing.** `privateKeyToAccount(pk).signTypedData({domain, types, primaryType, message})` with the `GatewayWalletBatched` domain fetched from the 402 response was immediately correct on the first try against the real Gateway.
4. **Arc block explorer ([testnet.arcscan.app](https://testnet.arcscan.app)).** Fast, searchable, direct tx links. Demo videos practically record themselves.
5. **Official reference sample** ([circlefin/arc-nanopayments](https://github.com/circlefin/arc-nanopayments)). A full working Next.js + LangChain + Supabase implementation with a seller dashboard was the fastest on-ramp our team has experienced at a hackathon.
6. **Gateway's non-custodial 7-day withdrawal.** Lets us pitch enterprise buyers with "Circle cannot rug you" rather than hedged trust-us language.
7. **`onSettleFailure` lifecycle hook.** The coinbase/x402 lifecycle hooks let us handle the rare case where content was delivered but settlement failed — critical for our per-chunk architecture where delivering-without-paid is a real edge case.

---

## 3. Pain points and improvement requests

### 3.1 True streaming: a built-in `upto` / deferred scheme

Our product's core UX is **mid-stream cutoff** — the buyer stops signing when quality drops and the seller halts. With the `exact` scheme we have to sign one authorization per 32-token chunk. That's ~31 signing round-trips per 1000-token session, each adding latency.

A shipping `upto` (or `deferred`, per Circle's issue [#447](https://github.com/coinbase/x402/issues/447) terminology) scheme — buyer signs once for a ceiling, seller streams, settlement is `min(consumed, ceiling)` — would reduce latency 10–20× and make streaming feel native. The deep-research use case Circle's own proposal cites needs this.

### 3.2 Express middleware buffers the response

The Express `@x402/express` middleware buffers the entire response until settlement completes, then sends. For a 32-token chunk that's invisible (~1–2s), but we designed around it assuming we couldn't use `res.write()` token-by-token. The [deepwiki documentation for server-side integration](https://deepwiki.com/coinbase/x402/6-facilitator-services) confirms this is the intended behavior. **Request:** a streaming-compatible mode where PAYMENT-RESPONSE is sent as a trailing header or via a settlement promise that doesn't block the response body. Would let true SSE-within-paid-request work cleanly.

### 3.3 3-day `validBefore` minimum is awkward for streaming

Gateway batching requires each authorization have `validBefore` ≥ 3 days in the future for batch-inclusion headroom. Our sessions last seconds. We sign with a 3+ day validity even though settlement happens in minutes. It works, but feels wrong — many users will set shorter validity and be rejected with a confusing error. **Request:** clarify this in the SDK error message (something like *"Gateway batch scheme requires validBefore ≥ 3 days to allow batch inclusion. Set validBefore to at least now + 3 * 24 * 3600."*).

### 3.4 `verifyingContract` discovery

Pulling `verifyingContract` from `response.accepts[i].extra.verifyingContract` at runtime is correct but undocumented beyond one example in the EIP-3009 signing how-to. **Request:** an SDK helper `getVerifyingContractForChain(chainId)` or a first-class field on the `accepted` response rather than inside `extra`.

### 3.5 Observable batch settlement

Our dashboard wants to show "off-chain confirmed → batching → on-chain tx X on Arc." The first two states are visible from our own code; the third we currently have to poll for by watching Arc RPC for transfers involving the seller's Gateway balance. **Request:**
- `GET /v1/nanopayments/authorizations/{nonce}` returning `{status, off_chain_confirmed_at, on_chain_batch_tx_hash, on_chain_batch_at, arc_block}`.
- Webhook on batch-settlement keyed by authorization nonce or seller address.
- A published SLA on batch cadence (how many seconds between accept and on-chain visibility) so sellers can size risk.

This would let dashboards push-update the "settled on Arc" state instead of polling.

### 3.6 Tool-schema pack for LLM frameworks

We used Gemini 3 Flash with Function Calling for the quality judge. Wiring Gemini `functionDeclarations` to call Gateway endpoints (balance, deposit, etc.) meant hand-writing tool schemas. **Request:** a published `@circle-fin/agent-tools` package with ready-made tool schemas for Gemini Function Calling, Anthropic tool_use, OpenAI function calling. Would save every hackathon team an afternoon.

### 3.7 Testnet faucet capacity for demos

The 20-USDC-per-2-hour Arc testnet faucet is correct for solo developers. For a 50+ transaction demo with dev cycles it burns fast. **Request:** a hackathon-tier allowance verified via registration email, or a one-time 100-USDC grant per registered team.

### 3.8 Circle Developer Console ↔ Arc Explorer linking

The video requirement asks us to show "a transaction via Circle Developer Console + verify on Arc Block Explorer." In practice the Console shows API-level events (authorization received, batch submitted); the specific Arc tx is one hop away. **Request:** every settled event in the Console gets a direct "View on Arc Explorer" link (testnet + mainnet) pointing to the batch tx that included this authorization.

### 3.9 Python parity

`@circle-fin/x402-batching` is TypeScript-only. The `coinbase/x402` Python client works for signing, but the batching facilitator does not. **Request:** `pip install circle-x402-batching` with the same `GatewayClient` interface, or a public roadmap note that TS-only is intentional. ML/agent teams default to Python; the language gap was the single biggest reason our earlier Python prototype ([../../agentic_economy/](../../agentic_economy/)) was unsalvageable.

### 3.10 A2A / AP2 example

Circle is [publicly collaborating with Google on A2A and AP2](https://www.circle.com/blog/enabling-machine-to-machine-micropayments-with-gateway-and-usdc). The hackathon is co-sponsored by Google. Yet the official `arc-nanopayments` sample does not show an A2A-compatible agent. **Request:** a `circlefin/arc-a2a-example` repo demonstrating Nanopayments embedded in an A2A agent exchange.

### 3.11 Oracle-agnostic payment primitives — a request, not a complaint

This one is forward-looking. Our architecture's core insight is that **the buyer's quality oracle is an arbitrary function**, and the same x402 + Gateway plumbing works for any oracle:

- Text: LLM-as-judge (probabilistic) — our primary demo
- Code: compiler + test suite (deterministic) — planned secondary demo
- Images: CLIP similarity (semi-deterministic)
- Voice: ASR confidence + intent classifier
- Browser: DOM-diff after action
- Video: CLIP on extracted frames

For each, the payment layer is identical — one EIP-712 authorization per paid unit, batched on-chain via Gateway. The oracle is where the use-case knowledge lives.

**Requests:**
- A reference project demonstrating the same seller/buyer plumbing with multiple oracle types (even two: one probabilistic, one deterministic).
- Documentation encouraging the "buyer-side oracle" pattern. Today's Circle blog posts lean heavily on "pay per API call"; the broader primitive is "pay per unit, gated by a buyer-defined quality function."
- A clear statement that the Gateway batched scheme makes no assumption about the nature of the thing being paid for. This helps teams trust that the pattern generalizes.

This is the most exciting thing about Nanopayments to us as developers: it's not just cheap payments, it's a *pricing primitive* that makes new billing models possible. Reference code + docs that highlight this would accelerate adoption.

---

## 4. Nice-to-haves

- **`session_id` metadata** accepted on authorizations and groupable in the Developer Console, so sellers see per-customer revenue.
- **Gateway-enforced session cap** so a misconfigured agent can't blow through the buyer's deposit unexpectedly.
- **Chain-agnostic seller-address field** in 402 responses, so the seller doesn't commit to a receive-chain when Gateway's crosschain balance could route.
- **Idempotent authorization semantics via `X-Payment-Identifier`** extension ([deepwiki/coinbase/x402 §8.3](https://deepwiki.com/coinbase/x402/8.3-payment-identifier-extension)) first-class in the Gateway batched scheme — essential for per-chunk retry safety.

---

## 5. What we'd build next

Our MVP is text streaming (deep research). We have scaffolded hooks for two additional oracle types:

- **Pay-per-function code generation** with a compiler-and-test-suite oracle. The cumulative code is written to a tmpfile; `tsc --noEmit --strict` and `node --test` determine the chunk's quality score deterministically. Seller streams TypeScript one function at a time. Buyer stops signing when code breaks compilation. **This is the strongest architectural story** because the oracle cannot be gamed — the judge is the compiler. See `QUALITY_CHECKER_DESIGN.md` §2.
- **Pay-per-image batch generation** with a CLIP-similarity oracle. Seller generates one image per chunk via Gemini/Flux; buyer's local CLIP model scores prompt-image alignment. Kill when the batch drifts off-prompt.

Further out:
- **AI video generation** (Sora-class): pay-per-frame-rendered with kill on first visibly broken frame. Same SDK; shorter stream; higher per-unit price.
- **Streaming voice agents**: pay-per-second with kill on ASR-confidence drop or intent mismatch.
- **Browser agents**: pay-per-action with DOM-diff oracle (did the expected UI state change?).

See `USE_CASES_MATRIX.md` for the feasibility evaluation of all seven categories and which ones we could ship within hackathon time.

---

*Thanks to the Arc + Circle team, and on-site mentors Blessing Adesiji, Corey Cooper, Evelina Kaluzhner, and Neha Komma. The fact that we went from `git clone` to real on-chain settled chunks in under two days is Circle's accomplishment, not ours.*
