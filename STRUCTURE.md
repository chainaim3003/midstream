# Project Structure (v2)

**Revised 2026-04-22.** Supersedes `docs/archive/STRUCTURE.original.md`.
Main change: buyer is a library, not a process. Added `web-server/`. See
`IMPLEMENTATION_REVISION.md` change 6.

Every file has a single responsibility. Every file has a reason to exist.
No hardcoded addresses. No mocks. No fallbacks.

**Status legend:**
- ✅ exists and correct
- 📝 to be written
- 🔒 do not modify (authoritative reference)
- 🗄 archived (do not build against)

---

## Tree

```
agentic_economy_refined/
│
├── PROJECT_CONTEXT.md              🔒  Authoritative (per user Rule 6)
├── DIRECTORY_DECISION.md           ✅  Why this folder is the submission
├── REFINEMENT_ANALYSIS.md          🔒  Audit of the Python predecessor
├── IMPLEMENTATION_REVISION.md      ✅  What changed from v1 and why
├── DESIGN.md                       ✅  Current architecture (v2)
├── STRUCTURE.md                    ✅  This file
├── UI_SPEC.md                      ✅  UI panels + kill choreography
│
├── README.md                       📝  Clone, configure, run
├── SUBMISSION.md                   📝  Hackathon submission form content
├── LICENSE                         📝  Apache-2.0
│
├── package.json                    ✅  Deps correct; add "web-server" script
├── tsconfig.json                   ✅
├── .env.example                    ✅  Expanded with all required env vars
├── .env.local                      🔒  (gitignored) your secrets
├── .gitignore                      📝  node_modules, .env.local, logs/, dist/
│
├── docs/
│   ├── USE_CASE_EXPLAINED.md       ✅  Plain-English walkthrough
│   ├── MARGIN_ANALYSIS.md          ✅  Hackathon-mandatory
│   ├── CIRCLE_FEEDBACK.md          ✅  $500 bonus deliverable
│   ├── PITCH_SCRIPT.md             📝  2:45 video script (optional)
│   ├── TRANSACTION_EVIDENCE.md     📝  Post-demo: list of explorer URLs
│   └── archive/
│       ├── README.md               ✅  Why archive exists
│       ├── DESIGN.original.md      🗄  Superseded by /DESIGN.md
│       └── STRUCTURE.original.md   🗄  Superseded by /STRUCTURE.md
│
├── shared/                         # types and config used by every package
│   ├── config.ts                   ✅  Zod env loader; validates at startup
│   ├── events.ts                   ✅  SSE event types (buyer + seller)
│   ├── payment.ts                  📝  EIP-3009 TypedData builder + types
│   └── chunker.ts                  📝  Token counting helper (tokenizer wrap)
│
├── server/                         # the paid LLM seller (Express :3000)
│   ├── seller.ts                   📝  Express app entry
│   ├── routes/
│   │   └── chunk.ts                📝  POST /chunk — the paywalled endpoint
│   ├── x402/
│   │   ├── middleware.ts           📝  @x402/express config with gateway-batched-evm
│   │   └── facilitator.ts          📝  BatchFacilitatorClient wiring
│   ├── sessions.ts                 📝  Map<sessionId, SellerSession> + reaper
│   ├── llm/
│   │   └── anthropic-chunk.ts      📝  One chunk = one Anthropic stream, max_tokens 32
│   └── events.ts                   📝  Optional SSE broadcast of seller-side events
│
├── client/                         # the buyer — library, not process
│   ├── index.ts                    📝  Exports { Buyer, SessionResult, ... }
│   ├── buyer.ts                    📝  class Buyer { runSession(opts, emit) }
│   ├── signer.ts                   📝  viem EIP-712 signer against GatewayWalletBatched
│   ├── gateway-client.ts           📝  Circle Gateway API wrapper (balance, deposit)
│   ├── quality-monitor.ts          📝  Gemini 3 Flash + Function Calling
│   ├── kill-gate.ts                📝  Rolling-avg decision logic
│   ├── gateway-watcher.ts          📝  Polls Arc RPC for batch tx confirmation
│   └── events.ts                   📝  EventEmitter wrapper matching shared/events
│
├── web-server/                     # NEW — bridges browser ↔ client library
│   ├── index.ts                    📝  Express :3001
│   ├── routes/
│   │   ├── session.ts              📝  POST /api/session + GET /api/session/:id/events
│   │   └── arc.ts                  📝  GET /arc/tx/:hash — proxies Arc RPC (dodges CORS)
│   └── session-manager.ts          📝  In-memory session registry
│
├── web/                            # browser dashboard (Vite + React + Tailwind)
│   ├── package.json                📝
│   ├── vite.config.ts              📝  Proxies /api and /arc to :3001
│   ├── tailwind.config.ts          📝
│   ├── index.html                  📝
│   └── src/
│       ├── main.tsx                📝
│       ├── App.tsx                 📝
│       ├── pages/
│       │   ├── DemoPage.tsx        📝  The star — the 3-column dashboard
│       │   └── LandingPage.tsx     📝  Optional marketing page
│       ├── components/
│       │   ├── PromptForm.tsx      📝  ①
│       │   ├── SessionStatus.tsx   📝  ②
│       │   ├── QualityGauge.tsx    📝  ③
│       │   ├── TokenStream.tsx     📝  ④
│       │   ├── SessionReceipt.tsx  📝  ⑤
│       │   ├── AuthorizationFeed.tsx 📝 ⑥
│       │   ├── BatchSettlementFeed.tsx 📝 ⑦
│       │   ├── LatestBatchCard.tsx 📝  ⑧ (replaces iframe; renders tx details)
│       │   └── KillBanner.tsx      📝  Overlay on ④
│       ├── hooks/
│       │   ├── useSessionEvents.ts 📝  EventSource on /api/session/:id/events
│       │   └── useArcTx.ts         📝  Calls /arc/tx/:hash (server-proxied)
│       └── lib/
│           ├── api.ts              📝  fetch wrappers
│           └── format.ts           📝  $ formatting, address truncation
│
├── scripts/                        # one-shot CLI tools
│   ├── generate-wallets.ts         📝  viem.generatePrivateKey() → .env.local
│   ├── deposit-to-gateway.ts       📝  One on-chain tx: USDC.approve + Gateway.deposit
│   ├── check-balances.ts           📝  Prints wallet USDC + Gateway balance
│   ├── run-demo.ts                 📝  Headless: 3 sessions, NDJSON log
│   └── verify-onchain.ts           ✅  Asserts ≥ 50 real settlements on Arc
│
├── logs/                           📝  (gitignored) NDJSON per session for verify-onchain
│
└── tests/                          📝  Optional — unit tests for pure logic
    ├── kill-gate.test.ts
    ├── chunker.test.ts
    └── signer.test.ts
```

---

## What each top-level directory does

### `shared/`

Single source of truth for types and config that all three TS packages
(`server/`, `client/`, `web-server/`) import. Zero runtime dependencies on the
others.

- `config.ts` — zod-validated env loader. Exits process on missing required
  vars. Defines Arc testnet chain config. Single source of contract addresses.
- `events.ts` — every event type emitted during a session. Browser, web-server,
  and client all speak this schema.
- `payment.ts` — `TransferWithAuthorization` struct and the EIP-712 typed-data
  payload builder. Used by both signer (client) and facilitator (server) to
  agree on shape.
- `chunker.ts` — thin wrapper around `@anthropic-ai/tokenizer` for counting
  tokens and assembling prior-chunk text into Anthropic's `messages` format.

### `server/`

The LLM seller. Express process on :3000.

- **Single paywalled route:** `POST /chunk`.
- `@x402/express` paymentMiddleware handles 402/verify automatically.
- Handler uses Anthropic's streaming API with `max_tokens: 32`, pipes the text
  deltas directly to the response body via `res.write()`. Per-chunk latency
  ~1–2s. Chunk boundary = HTTP response boundary.
- Session state (text so far, tokens emitted, chunk count) in a Map, keyed by
  `sessionId`. A reaper drops idle sessions after 60s.

SDK references (verified from `PROJECT_CONTEXT.md`):
- `BatchFacilitatorClient` from `@circle-fin/x402-batching/server`
- `GatewayEvmScheme` from same
- `paymentMiddleware` from `@x402/express`
- `@anthropic-ai/sdk` — use `messages.stream()` inside the handler

### `client/`

The buyer. **Library, not process.** Imported by `web-server/` for interactive
demos and by `scripts/run-demo.ts` for headless demos.

Key class:

```ts
export class Buyer {
  constructor(opts: { privateKey: Hex; sellerBaseUrl: string; geminiApiKey: string; chain: ChainConfig });
  async runSession(session: SessionOptions, emit: (event: BuyerEvent) => void): Promise<SessionResult>;
  async abort(sessionId: string): Promise<void>;
  async getGatewayBalance(): Promise<bigint>;
}
```

Per-session flow (matches DESIGN.md §3):

1. Call `quality-monitor.assess(prompt, cumulativeText)`.
2. Call `kill-gate.shouldKill(state)`. If yes → emit kill-decision, return.
3. POST `/chunk` (no sig) → get 402.
4. `signer.sign(message, domain from 402)`.
5. POST `/chunk` with PAYMENT-SIGNATURE → get streamed text.
6. Accumulate, emit events, update state, loop.

Separately, `gateway-watcher` polls Arc RPC for batch confirmations and emits
`batch-settled` events. Runs for the session duration; stops when the Buyer
finishes.

SDK references (verified):
- `@x402/core` for client-side x402 helpers (optional — we can hand-roll the
  HTTP layer; the headers and base64 JSON are straightforward)
- `@circle-fin/x402-batching/client` for `GatewayClient` (balance queries)
- `viem` for signing + RPC
- `@google/genai` for Gemini 3 Flash Function Calling

### `web-server/`

**New.** Express on :3001 (or Vite-proxied to same-origin). Bridges the browser
to the buyer library.

- `POST /api/session` creates a `sessionId`, starts `buyer.runSession(opts, emit)`
  in an async task, and stashes the emitter's output queue against the sessionId.
  Responds with `{sessionId}`.
- `GET /api/session/:id/events` opens an SSE response and drains the event
  queue for that sessionId.
- `POST /api/session/:id/abort` calls `buyer.abort(sessionId)`.
- `GET /arc/tx/:hash` proxies a `publicClient.getTransaction()` call to Arc.
  This exists because calling the Arc RPC from the browser would either CORS-fail
  or expose RPC keys. Server-side proxy is cleaner.

No business logic; all real work is in `client/`.

### `web/`

Vite + React + Tailwind. Pure spectator UI. Subscribes to `/api/session/:id/events`
and renders the 8 panels per UI_SPEC.md.

- **No buyer/seller logic lives in React.** The UI only reflects events.
- Dark theme, 1280×720 optimized for screen recording.
- Bottom-of-screen Panel 8 renders batch tx details we queried via `/arc/tx/:hash`;
  a prominent button opens `testnet.arcscan.app/tx/:hash` in a new tab. No
  iframe (see IMPLEMENTATION_REVISION.md change 5).

### `scripts/`

| Script | Purpose |
|---|---|
| `generate-wallets.ts` | Creates buyer + seller keypairs; writes `BUYER_PRIVATE_KEY`, `BUYER_ADDRESS`, `SELLER_PRIVATE_KEY`, `SELLER_ADDRESS` to `.env.local`. |
| `deposit-to-gateway.ts` | One on-chain tx: `USDC.approve(GatewayWallet, X)` then `GatewayWallet.deposit(USDC, X)`. After this the buyer has a Gateway balance. |
| `check-balances.ts` | Prints buyer wallet USDC, buyer Gateway balance, seller wallet USDC, seller Gateway balance. Useful during dev. |
| `run-demo.ts` | Headless demo. Instantiates a Buyer, runs 3 sessions (one full, one kill, one more), writes NDJSON logs to `logs/`. |
| `verify-onchain.ts` | ✅ already written — reads `logs/*.json`, queries Arc RPC for each unique batch tx hash, asserts `status: success`. Exits non-zero if < 50. |

### `logs/`

NDJSON per session, named `session-<id>.json`. Written by both the web-server
and the `run-demo.ts` script. Consumed by `verify-onchain.ts` for the submission.

Gitignored.

---

## Runtime topology

```
Terminal 1:   npm run seller       → server/ on :3000
Terminal 2:   npm run web-server   → web-server/ on :3001 (imports client/)
Terminal 3:   npm run web          → Vite dev server on :5173 (proxies /api to :3001)

Browser:      http://localhost:5173   subscribes to :5173/api/session/<id>/events
                                      (Vite forwards to :3001)

Headless demos:
Terminal X:   npm run demo         → scripts/run-demo.ts (imports client/ directly)
```

One HTTP connection from browser to Vite dev server (SSE); one from web-server
to buyer (in-process function call, no HTTP); per-chunk HTTP from client library
to seller; Circle API calls from seller; Anthropic API calls from seller; Arc
RPC calls from client's gateway-watcher and from web-server's `/arc/tx/:hash`
proxy; Gemini API calls from client's quality-monitor.

Everything is one TypeScript repo, one `node_modules`, one `package.json`.
Web UI is a separate `web/` subdirectory with its own `package.json` to keep
Vite's deps isolated.

---

## Hackathon requirements → where each is satisfied

| Requirement | File |
|---|---|
| Per-action pricing ≤ $0.01 | `server/x402/middleware.ts` hard-codes `price: '0.0005 USDC'`; enforced structurally |
| ≥ 50 on-chain transactions | `scripts/run-demo.ts` + `scripts/verify-onchain.ts`; output pasted into SUBMISSION.md |
| Margin explanation | `docs/MARGIN_ANALYSIS.md` |
| Circle Product Feedback | `docs/CIRCLE_FEEDBACK.md` (add a note about server-side x402 middleware being request-scoped — relevant to our per-chunk design) |
| Public GitHub | This directory |
| Demo URL | Vercel deploy of `web/` + Railway/Fly deploy of `server/` and `web-server/` |
| Video: Circle Developer Console tx + Arc Block Explorer verification | `docs/PITCH_SCRIPT.md` Scene 4 |
| Track | "Primary: Per-API Monetization Engine; Secondary: x402 Digital Product" in `SUBMISSION.md` |
| Circle Nanopayments used | Seller uses `@circle-fin/x402-batching` facilitator; buyer deposits to Gateway; every chunk is a batched nanopayment |
| Gemini (Google sponsor track) | `client/quality-monitor.ts` |

---

## Hard rules (enforced by code review)

1. **No hardcoded addresses.** Every contract address comes through
   `shared/config.ts`, read from env with zod.
2. **No simulator masquerading as live.** If Circle API is down, the app
   surfaces the error. No "fall back to fake success."
3. **No fake tx hashes.** Every hash printed or stored comes from an actual
   Circle API response or Arc RPC response.
4. **No "if key not set, use mock mode".** Missing required env → exit.
5. **No silent try/catch.** All errors logged with cause + surfaced.
6. **No counters that "count" simulated events.** Every metric traces to real
   events (signed authorizations, settled batch txs).
