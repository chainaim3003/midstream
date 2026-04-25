# Midstream

> **Pay for outcomes, not tokens.** Quality-gated streaming LLM inference with mid-session cutoff, settled on Arc via Circle Gateway Nanopayments.

Built for the [Agentic Economy on Arc](https://lablab.ai/ai-hackathons/nano-payments-arc) hackathon (Circle + Arc, April 2026).

---

## The idea in one paragraph

Today, every AI product bills you for compute whether the output is usable or not. Chat subscriptions, per-request APIs, and compute-per-second pricing all commit you before the model has proven anything. Midstream flips this: the seller streams output in 32-token chunks priced at $0.0005 USDC each. Between chunks, the buyer's local quality oracle scores the cumulative output. If the rolling score drops below threshold — topic drift, broken compilation, off-prompt image — the buyer stops signing payment authorizations. The seller, getting no signature, stops generating. Mid-sentence. The buyer pays only for the prefix that passed quality.

This architecture is only economically viable on a rail with sub-cent per-unit cost. Stripe's $0.30 minimum makes it impossible. Ethereum L1 gas makes it impossible. Circle Nanopayments on Arc — gas-free, batched, ~0.5s finality — is the first rail where it works.

## What's in this repo

| Path | Role |
|---|---|
| `server/seller.ts` | Express app with Circle Gateway middleware. Mounts paid per-chunk routes. |
| `server/routes/text-chunk.ts` | POST /chunk/text — Anthropic call, max_tokens=32, assistant-prefill continuation |
| `server/routes/code-chunk.ts` | POST /chunk/code — same pattern with code-generation system prompt |
| `client/buyer.ts` | Library class `Buyer.runSession()` — per-chunk pay, assess, kill-gate loop |
| `client/quality/text-monitor.ts` | Gemini 2.5 Flash judge (Function Calling, forced structured output) |
| `client/quality/code-monitor.ts` | Deterministic oracle: `tsc --strict` + `node --test` in a temp dir |
| `client/kill-gate.ts` | Rolling-3 average + warmup + catastrophic-single-chunk rule |
| `shared/session-bus.ts` | Session-scoped typed event bus with replay; see its header for why |
| `scripts/generate-wallets.ts` | Create buyer + seller wallets, write to `.env.local` |
| `scripts/deposit-to-gateway.ts` | One SDK call: `GatewayClient.deposit(amount)` |
| `scripts/check-balances.ts` | Print wallet USDC and Gateway balance for both parties |
| `scripts/run-demo.ts` | Run 4 sessions end-to-end, log every settled tx |
| `scripts/verify-onchain.ts` | Count unique settlements, prove ≥50 txs requirement |
| `docs/` | Design docs, viability audit, margin analysis, Circle feedback |

## Quick start

```bash
# 1. Install (Node 20+)
npm install

# 2. Create env file
cp .env.example .env.local

# 3. Generate buyer + seller wallets (writes to .env.local)
npm run generate-wallets

# 4. Fund the buyer at https://faucet.circle.com/ (Arc Testnet)
#    Paste the BUYER_ADDRESS printed in step 3.

# 5. Fill in .env.local with:
#    ANTHROPIC_API_KEY   — https://console.anthropic.com/
#    GEMINI_API_KEY      — https://aistudio.google.com/apikey

# 6. Deposit USDC into Gateway (one-time)
npm run deposit 5

# 7. Terminal A — start the seller
npm run seller

# 8. Terminal B — run the demo
npm run demo

# 9. After the demo, verify settlements
npm run verify-onchain
```

Every settled tx prints a link to `testnet.arcscan.app`. Screenshot the deposit and at least one batch settlement for the submission video.

## How it works

### One chunk = one HTTP request

Each `POST /chunk/text` is its own paid request. The server is stateless; the buyer sends cumulative text-so-far on every request and the server continues Claude's generation from it via assistant-prefill. This means:

- no long-lived SSE stream with mid-stream 402 pauses (an over-engineered path we abandoned)
- any concurrent buyer can hit the same seller
- the Circle Gateway middleware handles the full x402 flow (402 → signature verify → settle → PAYMENT-RESPONSE) per request

### Pay-per-chunk, kill-per-chunk

After each chunk lands, the buyer runs a `QualityMonitor.assess()` over the cumulative output. Three monitors exist:

- **Text** (Gemini 2.5 Flash, Function Calling) — scores relevance, on-topic-ness, drift, citation plausibility. Probabilistic.
- **Code** (tsc + node --test) — deterministic. Score 1.0 if compiles and tests pass, 0.3 if compiles but tests fail, 0.0 if tsc fails. The compiler is the judge; no gaming possible.
- **Image** (planned, Option C) — CLIP softmax. Semi-deterministic.

The kill gate applies three rules in order: (1) 2-chunk warmup where the gate cannot fire, (2) rolling-3-average below threshold, (3) single catastrophic chunk (score ≤ 0.1) after warmup. See `docs/QUALITY_CHECKER_DESIGN.md`.

### Why it's not a refund system

Once a chunk's authorization is signed and the text has been delivered, that $0.0005 is committed — Circle Gateway batches it, it settles. The buyer cannot retroactively un-pay. What they can do is *stop authorizing the next chunk*. So Midstream is a **spending bound**, not a correctness guarantee. It caps the buyer's loss on obviously-bad output; it doesn't refund losses on subtly-bad output. This is discussed honestly in `docs/PITCH_FRAMING.md`.

## Verified facts about the stack

- **Chain:** Arc Testnet, chain ID 5042002
- **USDC:** `0x3600000000000000000000000000000000000000` (native gas token on Arc)
- **Gateway Wallet:** `0x0077777d7EBA4688BDeF3E311b846F25870A19B9`
- **SDK versions (pinned):**
  - `@circle-fin/x402-batching@2.1.0`
  - `@x402/core@2.10.0`
  - `@x402/evm@2.10.0`
  - `viem@2.48.1`
- **Node:** ≥ 20 (20.18+ recommended for `--experimental-strip-types`)

## Hackathon requirements addressed

| Requirement | Where |
|---|---|
| Per-action price ≤ $0.01 | `.env.local` default $0.0005; enforced in `shared/config.ts` |
| ≥ 50 on-chain transactions | Three measurements (see `submission/SUBMISSION.md` §2): 213 paid actions (Circle UUIDs), 59+ direct Arc txs at buyer EOA, 7 batch settlements. Generated by `npm run produce-evidence` + `npm run verify-onchain`. |
| Margin explanation | `docs/MARGIN_ANALYSIS.md` |
| Circle product feedback | `docs/CIRCLE_FEEDBACK.md` (eligible for the $500 USDC incentive) |
| Working demo | `npm run seller` + `npm run web` (dashboard at :3001 with live inference harness) |
| Transaction flow video | see `SUBMISSION.md` when ready |

## License

MIT — see `LICENSE`.

## Acknowledgments

- **Circle & Arc team** — Nanopayments SDK, Arc testnet, rapid docs, on-site support
- **[AgentSwarm](https://github.com/0xCaptain888/agentswarm)** — reference code that verified the SDK pattern works on Arc; our middleware/client shapes are modelled on theirs
- **[AgentBazaar](https://github.com/janneh2000/AgentBazaar)** — reference for the x402 wire-format details (headers, base64 payloads)
- **Coinbase / x402 spec** — the underlying HTTP payment protocol
