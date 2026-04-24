# Project Structure

Full file layout for `agentic_economy_refined/`. Every file has a single responsibility. Every file has a reason to exist. No hardcoded addresses. No mocks. No fallbacks.

**Legend for the status column:**
- ✅ exists
- 📝 needs to be written (use existing files in `../agentic_economy/refinement/starter/` as reference skeletons where listed)
- 🔒 do not modify

---

## Top-level tree

```
agentic_economy_refined/
├── README.md                       📝  How to clone, configure, run the demo
├── SUBMISSION.md                   📝  Hackathon submission form content
├── LICENSE                         📝  Apache-2.0 (match circlefin/arc-nanopayments)
├── DIRECTORY_DECISION.md           ✅  Why this folder exists
├── STRUCTURE.md                    ✅  This file
├── UI_SPEC.md                      ✅  Detailed UI panel spec
├── PROJECT_CONTEXT.md              🔒  Authoritative project context (per user rule 6)
├── DESIGN.md                       🔒  Architecture doc (streaming-SSE with cutoff)
├── REFINEMENT_ANALYSIS.md          🔒  Audit of the Python predecessor
│
├── package.json                    🔒  SDK deps already correct
├── tsconfig.json                   🔒  TS config already correct
├── .env.example                    🔒  Env template
├── .env.local                      📝  (gitignored) — your actual secrets
├── .gitignore                      📝  Node defaults + .env.local
│
├── docs/
│   ├── USE_CASE_EXPLAINED.md       ✅  Plain-English walkthrough for judges
│   ├── MARGIN_ANALYSIS.md          ✅  Hackathon-required margin deliverable
│   ├── CIRCLE_FEEDBACK.md          ✅  Hackathon-required $500 feedback deliverable
│   ├── PITCH_SCRIPT.md             📝  2:45 video script + speaker notes (optional)
│   └── TRANSACTION_EVIDENCE.md     📝  Arc explorer URLs + screenshots from real demo runs
│
├── server/                         📝  The paywalled SSE seller
│   ├── seller.ts                   📝  Express app, /stream route with x402 + Anthropic streaming
│   ├── facilitator.ts              📝  @circle-fin/x402-batching BatchFacilitatorClient setup
│   ├── chunker.ts                  📝  Token→chunk assembly from Anthropic SSE
│   └── events.ts                   📝  SSE broadcast of seller-side events to the web UI
│
├── client/                         📝  The headless buyer
│   ├── buyer.ts                    📝  Main buyer: signs, streams, evaluates, kills
│   ├── signer.ts                   📝  viem EIP-712 signing against GatewayWalletBatched
│   ├── quality-monitor.ts          📝  Gemini 3 Flash + Function Calling judge
│   ├── budget.ts                   📝  Budget tracking + kill-gate decision
│   └── events.ts                   📝  Client-side event emitter for web UI consumption
│
├── web/                            📝  Browser dashboard (React or plain HTML+JS)
│   ├── index.html                  📝  Landing + live session view
│   ├── dashboard.tsx               📝  Main dashboard component (React via Vite)
│   ├── components/
│   │   ├── PromptForm.tsx          📝  Query + budget + threshold input
│   │   ├── TokenStream.tsx         📝  Live text panel with per-chunk coloring
│   │   ├── QualityGauge.tsx        📝  Animated rolling-score vs threshold bar
│   │   ├── BudgetMeter.tsx         📝  Spent vs budget
│   │   ├── PaymentFeed.tsx         📝  Signed-authorization cards
│   │   ├── SettlementBatches.tsx   📝  On-chain batch rows with explorer links
│   │   ├── ArcExplorerEmbed.tsx    📝  iframe of testnet.arcscan.app tx view
│   │   ├── KillBanner.tsx          📝  Dramatic "kill fired" overlay with reason
│   │   └── SessionSummary.tsx      📝  End-of-run receipt (spent vs. saved)
│   ├── hooks/
│   │   ├── useSessionStream.ts     📝  Subscribes to buyer's SSE event feed
│   │   └── useArcExplorer.ts       📝  Polls Arc RPC for batch tx confirmation
│   ├── lib/
│   │   ├── config.ts               📝  Reads public env (VITE_ARC_EXPLORER etc.)
│   │   └── format.ts               📝  USDC formatting, address truncation
│   └── vite.config.ts              📝  Vite dev server on port 5173
│
├── shared/                         📝  Types shared between client, server, web
│   ├── events.ts                   📝  SSE event type definitions
│   ├── quality.ts                  📝  QualityReport type (matches Gemini schema)
│   ├── payment.ts                  📝  PaymentAuthorization type (EIP-3009 fields)
│   └── config.ts                   📝  zod-validated env loader (fails loud, no fallbacks)
│
├── scripts/                        📝  One-shot CLI tools
│   ├── generate-wallets.ts         📝  Creates buyer + seller keypairs, writes to .env.local
│   ├── deposit-to-gateway.ts       📝  Funds buyer's Gateway balance (1 on-chain tx)
│   ├── verify-onchain.ts           📝  Queries Arc RPC, asserts ≥ 50 real settlements
│   ├── run-demo.ts                 📝  Automated 3-session demo for the video
│   └── check-balances.ts           📝  Prints buyer Gateway balance + seller balance
│
├── agent/                          📝  Optional LangChain Deep Agents wrapper
│   └── research-agent.mts          📝  LangChain agent that acts as the buyer
│
└── tests/                          📝  Unit tests for pure logic
    ├── quality-monitor.test.ts
    ├── budget.test.ts
    ├── signer.test.ts
    └── chunker.test.ts
```

---

## What each top-level directory does

### `server/` — the seller

An Express process that:
1. Accepts `POST /stream` with `{prompt, qualityThreshold, maxTokens, pricePerChunk, chunkSize}`.
2. On first call, returns `402 Payment Required` with the `PAYMENT-REQUIRED` header containing a base64-JSON payment challenge. The challenge's `extra` field carries the Gateway domain (`name: "GatewayWalletBatched"`, `version: "1"`, `chainId: 5042002`, `verifyingContract: <Gateway Wallet address on Arc>`).
3. On retry with `PAYMENT-SIGNATURE`, submits the authorization to Circle's `BatchFacilitatorClient` for verification.
4. On verification success, opens an SSE stream to the client. Calls Anthropic's Claude streaming API. Emits events: `token`, `chunk-complete`, `payment-required` (every `CHUNK_SIZE_TOKENS`), `aborted` (on payment timeout).
5. Waits `T` seconds for the next `PAYMENT-SIGNATURE`. If it arrives, continues. If not, closes the stream with `event: aborted reason: payment-timeout`.

SDK references ([docs](https://developers.circle.com/gateway/nanopayments/howtos/x402-seller)):
- `BatchFacilitatorClient` from `@circle-fin/x402-batching/server`
- `GatewayEvmScheme` (configures the seller side of the x402 scheme)
- `paymentMiddleware()` from `@x402/express`

### `client/` — the headless buyer

A Node process that:
1. Reads the prompt, threshold, and budget from CLI or its own HTTP endpoint.
2. Calls `POST /stream` on the seller.
3. On `402`, constructs an EIP-3009 `TransferWithAuthorization` message, signs it with `viem`'s `signTypedData` against the `GatewayWalletBatched` domain pulled from the 402 response's `extra`, retries with `PAYMENT-SIGNATURE`.
4. Subscribes to the SSE stream. Buffers tokens. Every chunk boundary, runs `quality-monitor.ts` on the rolling window via Gemini 3 Flash.
5. Maintains a `BudgetMeter` (tracks spend) and `KillGate` (rolling avg vs threshold).
6. When the next `payment-required` event arrives, **only signs if BudgetMeter and KillGate both agree**. Otherwise, stops. The seller times out and aborts.
7. Emits its own SSE event feed (`/events`) for the web UI to consume.

SDK references ([docs](https://developers.circle.com/gateway/nanopayments/howtos/x402-buyer)):
- `CompositeEvmScheme` or `BatchEvmScheme` from `@circle-fin/x402-batching/client`
- `GatewayClient` (checks buyer's Gateway balance)
- `viem` `privateKeyToAccount`, `signTypedData`

### `web/` — the browser dashboard

A small Vite + React app running on port 5173. Subscribes to two SSE event feeds:
- `http://localhost:3001/events` (buyer-side events: quality scores, kill decisions, budget)
- `http://localhost:3000/events` (seller-side events: tokens emitted, chunks completed, settlements)

Renders a three-column dashboard (see `UI_SPEC.md`). Exists to make the demo visible.

No backend logic lives in `web/`. It's purely a spectator UI. This separation means:
- The buyer and seller are deterministic and can run headlessly for tests.
- The demo video can be recorded at the buyer/seller stdout OR at the web dashboard; both show the same session.
- If Vercel deploy fails, `node client/buyer.ts` still produces a legitimate demo.

### `shared/` — cross-cutting types and config

Single source of truth for:
- Event schema (events emitted by seller/buyer and consumed by web UI)
- `QualityReport` type (matches the Gemini Function Calling output schema)
- `PaymentAuthorization` type (EIP-3009 fields)
- `config.ts` — zod-validated env loader; exits the process on missing required env. No fallbacks.

### `scripts/` — one-shot tools

| Script | Purpose |
|---|---|
| `generate-wallets.ts` | Produces buyer + seller keypairs using `viem.generatePrivateKey()`, writes to `.env.local`. |
| `deposit-to-gateway.ts` | One on-chain tx: `USDC.approve(GatewayWallet, X)` then `GatewayWallet.deposit(USDC, X)`. After this the buyer has a Gateway balance ready to pay chunks from. |
| `verify-onchain.ts` | Queries Arc RPC via viem's `publicClient.getTransactionReceipt()` for every batch-settlement tx hash we've observed, asserts ≥ 50 found on-chain. Exits non-zero if below. |
| `run-demo.ts` | Runs 3 sessions: one full completion, one mid-run kill, one early kill. Reaches 50+ signed authorizations. Prints Arc explorer URLs for the video. |
| `check-balances.ts` | Prints buyer Gateway balance, seller Gateway balance, buyer wallet USDC, seller wallet USDC. Useful during dev. |

### `agent/` (optional) — LangChain Deep Agents wrapper

Makes the buyer look like a classic "autonomous agent" for the Agent-to-Agent Payment Loop track. The buyer becomes a tool-using LangChain agent whose tools are the search/fetch/summarize capabilities of the seller API. Optional for MVP — the plain `client/buyer.ts` is sufficient to satisfy both tracks.

---

## How the pieces connect at runtime

```
Terminal 1:   npm run seller       → Express on :3000
Terminal 2:   npm run buyer        → Node client on :3001 (emits events)
Terminal 3:   npm run web          → Vite dev server on :5173
Browser:      http://localhost:5173 → Dashboard subscribes to :3000 and :3001 SSE
```

The buyer sends HTTP to the seller. The browser subscribes to SSE from both.
Circle API calls go from the seller's `BatchFacilitatorClient` to Circle's hosted endpoint.
Arc RPC calls go from the buyer's `viem` public client for balance checks and from `scripts/verify-onchain.ts`.

---

## Configuration is env-driven — addresses are NEVER literals

Every runtime constant comes from `.env.local` via `shared/config.ts`. Nothing about Arc, Circle, or addresses lives in source code. `config.ts` uses `zod` to validate at startup and **exits loudly** if any required value is missing or malformed. No fallback to defaults that look like they'd work.

Required env (verified from `PROJECT_CONTEXT.md`):
```
BUYER_PRIVATE_KEY          0x...
SELLER_ADDRESS             0x...
ANTHROPIC_API_KEY          sk-ant-...
GEMINI_API_KEY             ...
CHAIN=arcTestnet
PORT=3000
CHUNK_SIZE_TOKENS=32
PRICE_PER_CHUNK_USDC=0.0005
QUALITY_THRESHOLD=0.75
ROLLING_WINDOW_SIZE=3
```

The Arc chain configuration (chain ID 5042002, RPC URL, block explorer URL, Gateway Wallet contract address) lives in `shared/config.ts` as a `viem`-compatible `Chain` object keyed by `CHAIN`. The Gateway Wallet contract `verifyingContract` specifically is **pulled at runtime from the 402 response's `extra.verifyingContract`** — never hardcoded.

---

## Hackathon requirements → where each is satisfied

| Requirement (from lablab.ai) | Satisfied by |
|---|---|
| Real per-action pricing ≤ $0.01 | `PRICE_PER_CHUNK_USDC=0.0005` in `.env.example`, enforced in `server/seller.ts` |
| ≥ 50 on-chain transactions in demo | `scripts/run-demo.ts` + `scripts/verify-onchain.ts` — asserts against real Arc RPC |
| Margin explanation | `docs/MARGIN_ANALYSIS.md` |
| Circle Product Feedback field | `docs/CIRCLE_FEEDBACK.md` |
| Public GitHub repo | This directory becomes the repo |
| Working demo URL | Vercel or Railway deploy of `web/` + `server/` + `client/` |
| Video: Circle Developer Console txn + Arc Block Explorer | Covered in `docs/PITCH_SCRIPT.md` Scene 4 — record the Developer Console view showing a batch submission, then the same tx hash on `testnet.arcscan.app` |
| Track statement | "Primary: Per-API Monetization Engine. Secondary: Agent-to-Agent Payment Loop." in `SUBMISSION.md` |
| Use of Circle Nanopayments | Core architecture — seller uses `@circle-fin/x402-batching`, buyer deposits to Gateway, each chunk is a signed authorization batched by Circle to Arc |
| Use of Gemini (Google sponsor track) | `client/quality-monitor.ts` uses Gemini 3 Flash with Function Calling |

---

## Anti-patterns that are forbidden in this codebase

1. **No hardcoded addresses.** Every contract address comes through `shared/config.ts`.
2. **No simulator masquerading as live.** If the Circle API is down or the buyer can't sign, the app surfaces the error. It does not "fall back to a fake success."
3. **No fake tx hashes.** Every tx hash printed or stored comes from an actual Circle API response or Arc RPC response.
4. **No "if key not set, use mock mode."** Missing env → process exits at startup. This is explicit in `shared/config.ts`.
5. **No `try/catch` that swallows errors silently.** All errors are logged with source + cause and surfaced to the user.
6. **No metrics that "count" simulated events.** Every counter on the dashboard is a `COUNT(*)` over real rows (authorizations signed, batch txs observed on Arc).
