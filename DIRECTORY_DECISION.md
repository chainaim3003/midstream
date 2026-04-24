# Directory Decision

**Date:** 2026-04-21
**Decision:** `agentic_economy_refined/` is the submission codebase. `agentic_economy/` is archived as-is.
**Status:** Final.

---

## The question

Three folders exist:

| Path | What's in it |
|---|---|
| `../agentic_economy/` | Original Python project. Mocked blockchain layer, wrong EIP-712 domain, wrong x402 header format. Does not produce real on-chain transactions. |
| `../agentic_economy/refinement/` | Planning documents written during the audit (strategy, use-case explainer, margin analysis, Circle feedback draft, dashboard prototype HTML, starter TypeScript files). |
| `./` (`agentic_economy_refined/`) | TypeScript scaffolding with correct SDK references (`@circle-fin/x402-batching`, `@x402/express`, `viem`), correct `GatewayWalletBatched` EIP-712 domain, correct streaming-SSE-with-cutoff architecture. Empty `server/` and `client/` folders awaiting implementation. |

The question: where does new code go, and what happens to the other two folders?

---

## The answer

**All new code goes in `agentic_economy_refined/`.** This is the submission.

**`agentic_economy/` is not modified.** It stays as-is, including `agentic_economy/refinement/` (the planning docs in that subfolder have been copied into `agentic_economy_refined/docs/`). The original Python project is left intact as evidence of the development journey.

**`agentic_economy_refined/docs/`** now contains the planning artifacts (use case, margin analysis, Circle feedback) that started life in `agentic_economy/refinement/`.

---

## Why

### 1. Language and SDK mismatch is non-negotiable

Circle's Nanopayments SDK (`@circle-fin/x402-batching`) is TypeScript-only. The reference implementation ([circlefin/arc-nanopayments](https://github.com/circlefin/arc-nanopayments)) is Next.js. The `@x402/express` server middleware and `viem` signing libraries are all Node.js. There is no Python equivalent of the batching facilitator.

`agentic_economy/` is Python. Converting it is a rewrite, not a patch. Rewriting into the same folder creates a mixed-language codebase that confuses contributors and submission reviewers.

### 2. `agentic_economy_refined/` is already correctly scaffolded

The existing scaffolding in this directory includes, verified against Circle's own docs:

| File | Status |
|---|---|
| `PROJECT_CONTEXT.md` | Lists verified facts (Arc chain 5042002, Gateway domain, EIP-3009 typehash, 3-day validBefore constraint, correct SDK class names) with source URLs |
| `DESIGN.md` | Streaming-SSE architecture with mid-stream cutoff, economic argument, UI requirements |
| `REFINEMENT_ANALYSIS.md` | Five specific technical issues in the Python project, each cited against an official Circle docs page |
| `.env.example` | Env vars for `BUYER_PRIVATE_KEY`, `SELLER_ADDRESS`, `ANTHROPIC_API_KEY`, `GEMINI_API_KEY`, chunk tuning knobs |
| `package.json` | Correct deps: `@circle-fin/x402-batching`, `@x402/core`, `@x402/evm`, `@x402/express`, `viem`, `@anthropic-ai/sdk`, `@google/genai`, `express`, `dotenv`, `tsx`, `typescript` |
| `tsconfig.json` | ES2022, ESNext module, bundler resolution, strict mode |

Starting from here is days of work ahead of starting from scratch or converting the Python project.

### 3. Keeping `agentic_economy/` untouched is worth $500

The hackathon has a **$500 USDC Product Feedback Incentive** for the most detailed and helpful feedback ([lablab.ai/ai-hackathons/nano-payments-arc](https://lablab.ai/ai-hackathons/nano-payments-arc)). Our Circle feedback ([docs/CIRCLE_FEEDBACK.md](./docs/CIRCLE_FEEDBACK.md) §3.8) cites the Python parity gap as a concrete pain point *"the language gap was the single biggest reason our earlier Python prototype (`../../agentic_economy/`) was unsalvageable"*.

Keeping the Python project in the repo lets a judge who wants to verify that story actually open the old files and see the exact wrong `encode_defunct` call, the wrong `"USD Coin"` EIP-712 domain, and the in-memory Python dicts masquerading as on-chain storage. That concreteness is what wins the feedback prize.

### 4. Clean git history for the submission

GitHub renders one primary README. `agentic_economy_refined/README.md` is the one judges see. A reviewer cloning the repo and running `npm install && npm run demo` should hit the TypeScript project, not get lost in Python archaeology.

---

## What needs to happen (execution plan)

### Already done

- ✅ `agentic_economy_refined/` exists with correct scaffolding
- ✅ `agentic_economy_refined/docs/` created
- ✅ `docs/USE_CASE_EXPLAINED.md` written (adapted for the streaming architecture)
- ✅ `docs/MARGIN_ANALYSIS.md` written
- ✅ `docs/CIRCLE_FEEDBACK.md` written

### Still to do

- [ ] `STRUCTURE.md` — full tree of what goes where (this decision companion)
- [ ] `UI_SPEC.md` — detailed UI panel description
- [ ] `server/seller.ts` — Express seller with SSE stream and x402 middleware
- [ ] `client/buyer.ts` — Node buyer that signs, streams, evaluates, kills
- [ ] `web/` — browser dashboard that subscribes to buyer/seller events and renders live
- [ ] `scripts/generate-wallets.ts` — produces `.env.local` buyer + seller keypairs
- [ ] `scripts/deposit-to-gateway.ts` — one-time buyer deposit to Gateway Wallet on Arc
- [ ] `scripts/verify-onchain.ts` — queries Arc RPC to prove ≥ 50 on-chain transactions
- [ ] `scripts/run-demo.ts` — end-to-end demo runner (multiple sessions, some killed)
- [ ] `agent/research-agent.mts` — LangChain Deep Agents wrapper (optional, for the "autonomous buyer" angle)
- [ ] `README.md` — how to run (copy existing, edit)
- [ ] `SUBMISSION.md` — hackathon submission form content

### What NOT to do

- ❌ Don't copy code from `../agentic_economy/`. Its blockchain layer is wrong; copying it would reintroduce the issues.
- ❌ Don't modify files in `../agentic_economy/`. Leave it as archival evidence for the feedback story.
- ❌ Don't delete `../agentic_economy/refinement/`. The dashboard HTML prototype there is useful reference; if you want to consolidate further later, fine, but not right now.
- ❌ Don't rename this folder. GitHub Pages, Vercel deploy paths, README links all point at `agentic_economy_refined/`.

---

## One-line summary for the team

> The TS project at `agentic_economy_refined/` is the build. The Python project at `agentic_economy/` is evidence. The planning docs are now in `agentic_economy_refined/docs/`.
