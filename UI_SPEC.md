# UI Specification

The browser dashboard at `http://localhost:5173` (or deployed on Vercel).
Single page. Three-column layout. Designed so a judge watching a 3-minute demo video understands what is economically new within the first 30 seconds.

**Inspired by** [AgentBazaar](https://github.com/janneh2000/AgentBazaar) (live settlement feed, Arc explorer links) and [agentswarm](https://github.com/0xCaptain888/agentswarm) (live agent decision-making), but built around the novel demonstrable moment these references do not have: **the stream halting mid-sentence when quality drops.**

---

## Design principles

1. **Three things must be undeniable on screen at the 30-second mark:** tokens streaming live, quality gauge visibly sitting above threshold, settlement rows appearing in real time with clickable Arc explorer links.
2. **The kill must be visually dramatic.** When the quality rolling average crosses the threshold, the stream cuts mid-sentence, a red banner appears with the specific reason, and the cost meter freezes. Judges should gasp audibly.
3. **Nothing is fake.** Every number on screen traces to either a real SSE event from the buyer/seller or a real Arc RPC response. No simulated counters. No "pretend tx hashes."
4. **Arc block explorer is first-class.** Settlement rows aren't just text; they're links that open `testnet.arcscan.app/tx/<hash>` and an embedded iframe at the bottom shows the most recent batch tx confirming in real time.

---

## Layout overview

```
┌──────────────────────────────────────────────────────────────────────────────┐
│  HEADER                                                                      │
│  Quality-Gated Streaming Research · Agentic Economy on Arc          ● LIVE   │
│  Seller http://localhost:3000 · Buyer :3001 · Arc chain 5042002              │
├─────────────────┬─────────────────────────────────┬──────────────────────────┤
│                 │                                 │                          │
│   LEFT COL      │        MIDDLE COL               │       RIGHT COL          │
│   (control      │        (the star —              │       (settlement        │
│    + gauges)    │         live token stream)      │        + explorer)       │
│                 │                                 │                          │
│   25% width     │        45% width                │       30% width          │
│                 │                                 │                          │
├─────────────────┴─────────────────────────────────┴──────────────────────────┤
│  ARC EXPLORER EMBED (bottom strip, 30% of viewport height)                   │
│  iframe of testnet.arcscan.app showing latest batch settlement tx            │
└──────────────────────────────────────────────────────────────────────────────┘
```

---

## Column 1 — Control panel and gauges (left, 25% width)

### Panel A: Prompt form

```
┌──────────────────────────────────────────┐
│ ① RESEARCH QUERY                         │
├──────────────────────────────────────────┤
│                                          │
│ ┌──────────────────────────────────────┐ │
│ │ Research the impact of the EU AI Act │ │
│ │ on open-source model distribution... │ │
│ └──────────────────────────────────────┘ │
│                                          │
│  Budget:        [$0.50      ▼]           │
│  Threshold:     [0.75       ▼]           │
│  Chunk size:    [32 tokens  ▼]           │
│  Max tokens:    [1000       ▼]           │
│                                          │
│  [ ▶ Start stream ]  [ ✕ Abort ]  [ ↺ ] │
│                                          │
└──────────────────────────────────────────┘
```

**Behavior:**
- Prompt is a textarea, 3 lines visible, scrollable.
- Budget dropdown: $0.10 / $0.50 / $1.00 — maps to BudgetMeter ceiling.
- Threshold dropdown: 0.50 / 0.65 / 0.75 / 0.85 — the quality floor below which buyer stops signing.
- Chunk size / Max tokens: reads from `.env.local` defaults, user can override.
- **Start stream** → POST to buyer's `/run` endpoint → dashboard subscribes to buyer's SSE feed.
- **Abort** → POST to buyer's `/kill` endpoint → buyer immediately stops signing → seller times out.
- **Reset** → clears dashboard state for a fresh run.

### Panel B: Session status

```
┌──────────────────────────────────────────┐
│ ② SESSION STATUS                         │
├──────────────────────────────────────────┤
│  Status:            ● streaming          │
│  Gateway balance:   $4.987500            │
│  Spent this session:$0.006500            │
│  Remaining budget:  $0.493500            │
│  Chunks signed:     13                   │
│  Chunks remaining:  18 of 31 (max)       │
│                                          │
│  Budget used   [██████░░░░░░░░░░░]       │
└──────────────────────────────────────────┘
```

**Data sources:**
- `Gateway balance` — polled from `client/buyer.ts` which calls `GatewayClient.getBalance()` against Circle's API. Real number.
- `Spent this session` — accumulated from confirmed `PAYMENT-RESPONSE` events.
- `Status` badge — `idle | planning | streaming | killed | complete`.

### Panel C: Quality gauge

```
┌──────────────────────────────────────────┐
│ ③ QUALITY MONITOR (Gemini 3 Flash)       │
├──────────────────────────────────────────┤
│  Rolling average (last 3 chunks):  0.82  │
│                                          │
│  [░░░░░░░░████████████████│░░░░░░]       │
│  0                  threshold ▲    100   │
│                       0.75              │
│                                          │
│  Last chunk's verdict:                   │
│    relevance_score:     88               │
│    on_topic:            true             │
│    citation_plausible:  true             │
│    drift_detected:      false            │
│    reasoning:                            │
│      "Directly references Article 53     │
│       of Regulation 2024/1689; on-topic" │
└──────────────────────────────────────────┘
```

**Behavior:**
- Bar animates in real time as each chunk's quality score lands.
- **Green** when rolling avg ≥ threshold + 0.1
- **Yellow** when within 0.1 of threshold
- **Red** when below threshold (kill imminent)
- The four-field verdict below shows the most recent Gemini 3 Flash Function-Call output verbatim — judges can see the AI is doing structured reasoning, not a heuristic.

---

## Column 2 — Live token stream (middle, 45% width, the visual star)

### Panel D: Streaming output

```
┌────────────────────────────────────────────────────────────────┐
│ ④ LIVE RESEARCH BRIEF (streamed from Claude via seller)       │
├────────────────────────────────────────────────────────────────┤
│                                                                │
│  ▓▓ The European Union AI Act (Regulation 2024/1689) ▓▓       │
│  ▓▓ establishes a tiered risk-based framework for     ▓▓      │
│  ▓▓ AI systems. Article 53 specifically addresses      ▓▓     │
│  ▓▓ general-purpose AI (GPAI) models, with             ▓▓     │
│  ▒▒ exemptions for those released under a free and     ▒▒     │
│  ▒▒ open-source license provided they do not present   ▒▒     │
│  ▒▒ systemic risk. The systemic-risk threshold is set  ▒▒     │
│  ░░ at 10^25 FLOPs of cumulative compute used in       ░░     │
│  ░░ training, per the Commission's implementing acts.  ░░     │
│  ██ Notable stakeholders including Meta and Hugging    ██     │
│  ██ Face have pointed to the practical burden of the   ██     │
│  ██ medieval European guild system, which dates back   ██     │
│  ██ to the eleventh century, when merchant▂            ██     │
│                                           ^                    │
│                                           stream cut here     │
│                                                                │
│  ─────────────────────────────────────────────────────────    │
│  ⛔ STREAM ABORTED · Quality 0.44 < threshold 0.75             │
│  ─────────────────────────────────────────────────────────    │
│                                                                │
└────────────────────────────────────────────────────────────────┘
```

**Behavior:**
- Tokens appear character-by-character as they arrive from the SSE stream (true streaming, not batched).
- **Color-coding is by chunk, not by token.** Each 32-token chunk inherits a color based on its Gemini quality score:
  - ▓▓ green-tinted background for chunks with score ≥ 0.8
  - ▒▒ yellow-tinted for 0.6–0.8
  - ░░ light-red-tinted for 0.4–0.6
  - ██ deep-red-tinted for < 0.4
- When the buyer decides to kill, the seller's SSE emits `event: aborted` and the stream **literally stops mid-word**. The dashboard freezes the last half-rendered word with a caret indicator (`▂`).
- A full-width red banner appears immediately with the kill reason: quality score vs threshold, which chunk triggered it.
- The text remains scrollable and selectable — judges can read exactly what was paid for and what wasn't.

### Panel E: Session summary (appears after run ends)

```
┌────────────────────────────────────────────────────────────────┐
│ ⑤ SESSION RECEIPT                                              │
├────────────────────────────────────────────────────────────────┤
│  Prompt:        "Impact of EU AI Act on open-source..."        │
│  Outcome:       killed at chunk 13 of 31                       │
│  Duration:      14.2 seconds                                   │
│  Tokens served: 416 of 1000 planned                            │
│                                                                │
│  Spent:         $0.006500  (13 chunks × $0.0005)               │
│  Would have been: $0.015500 (31 chunks × $0.0005)              │
│  SAVED:         $0.009000  (58% of full-run cost)              │
│                                                                │
│  Signed authorizations: 13                                     │
│  Arc batch settlements: 4                                      │
│  All txs verified on chain: ✓                                  │
│                                                                │
│  [ ⬇ Download research brief ] [ 🔗 Share session URL ]        │
└────────────────────────────────────────────────────────────────┘
```

**Data sources:**
- `Signed authorizations` — count of rows from the buyer's event log.
- `Arc batch settlements` — count of unique `batch_tx_hash` values observed from `PAYMENT-RESPONSE` headers.
- `All txs verified on chain` — set true by `useArcExplorer.ts` hook, which calls Arc RPC `getTransactionReceipt()` on each batch hash and checks `status === 'success'`.

---

## Column 3 — Off-chain chunks + on-chain settlement (right, 30% width)

### Panel F: Signed authorization feed (off-chain chunking)

```
┌──────────────────────────────────────────┐
│ ⑥ OFF-CHAIN CHUNK AUTHORIZATIONS         │
├──────────────────────────────────────────┤
│  Chunk #13 · $0.0005              killed │
│  nonce: 0xa1f2...b3c4                    │
│  sig:   0x8d9e...0f01                    │
│  status: NOT SIGNED · quality 0.28       │
│  ───────────────────────────────────────│
│  Chunk #12 · $0.0005           ✔ signed │
│  nonce: 0xc5e6...2d9a                    │
│  sig:   0x1a2b...3c4d                    │
│  status: OFF-CHAIN confirmed             │
│  ───────────────────────────────────────│
│  Chunk #11 · $0.0005           ✔ signed │
│  nonce: 0x7f80...5e6f                    │
│  sig:   0xaabb...ccdd                    │
│  status: OFF-CHAIN confirmed             │
│  [... more rows ...]                     │
└──────────────────────────────────────────┘
```

**Behavior:**
- Each chunk is a row that appears as soon as the buyer issues the signature.
- Real EIP-712 signatures (truncated with ellipsis for display). Click to expand and see the full signature + full `TransferWithAuthorization` struct fields.
- `status` progresses: `pending` (buyer deciding) → `signed` (buyer sent) → `verified` (seller confirmed via facilitator) → `batched` (Circle included in a batch) → `on-chain` (Arc tx confirmed).

### Panel G: Arc batch settlement feed (on-chain settlement)

```
┌──────────────────────────────────────────┐
│ ⑦ ON-CHAIN ARC BATCH SETTLEMENTS         │
├──────────────────────────────────────────┤
│  ▼ Batch #4 · Arc block 847293           │
│  tx: 0xbeef...dead      $0.0020          │
│  4 authorizations · 7 seconds ago        │
│  [ 🔗 View on testnet.arcscan.app ↗ ]    │
│  ────────────────────────────────────    │
│  ▼ Batch #3 · Arc block 847281           │
│  tx: 0xcafe...beef      $0.0015          │
│  3 authorizations · 12 seconds ago       │
│  [ 🔗 View on testnet.arcscan.app ↗ ]    │
│  ────────────────────────────────────    │
│  [... more batches ...]                  │
└──────────────────────────────────────────┘
```

**Data sources:**
- `Batch N` rows come from observed `PAYMENT-RESPONSE` headers that include Circle's `batch_id`.
- `Arc block` and `tx` come from polling Arc RPC `getTransaction(tx_hash)`.
- The link opens `https://testnet.arcscan.app/tx/<hash>` in a new tab.

**This panel is the proof.** A judge watching the video can pause, click any row, and see a real Arc testnet block explorer page confirming the exact tx.

---

## Bottom strip — Arc explorer embed

```
┌──────────────────────────────────────────────────────────────────────────────┐
│  ⑧ ARC BLOCK EXPLORER · LATEST BATCH                                          │
│  ┌────────────────────────────────────────────────────────────────────────┐ │
│  │                                                                        │ │
│  │   iframe: https://testnet.arcscan.app/tx/0xbeef...dead                 │ │
│  │                                                                        │ │
│  │   Shows: tx hash, block, status (success), from/to, value,             │ │
│  │   logs emitted, internal transfers to seller addresses                 │ │
│  │                                                                        │ │
│  └────────────────────────────────────────────────────────────────────────┘ │
└──────────────────────────────────────────────────────────────────────────────┘
```

**Behavior:**
- `useArcExplorer.ts` hook watches the most recent batch tx hash.
- iframe src updates whenever a new batch lands.
- If `testnet.arcscan.app` disallows iframe embedding (X-Frame-Options), fall back to a full-screen modal with an "Open in new tab" button. Either way, the tx is one click away.

---

## Kill moment — the choreographed UX

This is the most important 5 seconds of the demo. Here's the second-by-second:

| t (sec) | Event | Visual |
|---|---|---|
| 0.0 | Chunk 12 arrives, quality 0.72 | Gauge bar ticks down, yellow |
| 0.3 | Chunk 12's verdict lands from Gemini | Panel C updates with reasoning text |
| 1.5 | Chunk 13 arrives, quality 0.28 | Gauge bar plunges, turns red |
| 1.6 | Rolling avg = 0.44, below threshold 0.75 | Panel C bar flashes red twice |
| 1.7 | Buyer emits `event: kill-decision` | Panel F top row marks "NOT SIGNED" |
| 1.8 | Seller times out waiting for PAYMENT-SIGNATURE | Panel D stream stops mid-word |
| 2.0 | Seller emits `event: aborted reason: payment-timeout` | Full-width red banner slides down over Panel D |
| 2.3 | Panel E session receipt fades in | Savings number counts up with easing |
| 5.0 | First on-chain batch settles on Arc | Panel G row appears, Panel ⑧ iframe updates |

This entire sequence happens automatically from the moment the 13th chunk's quality score lands. The dashboard does not need to be scripted — it's reading events from the buyer and seller SSE feeds. Record this once, the video writes itself.

---

## What differentiates this from AgentBazaar / agentswarm

| Dimension | AgentBazaar | agentswarm | This project |
|---|---|---|---|
| Live settlement feed | ✓ | ✓ | ✓ |
| Arc explorer links | ✓ | partial | ✓ |
| Multiple agent types | ✓ (specialist agents) | ✓ (swarm) | one (focused on pay-for-outcome) |
| **Mid-stream cutoff visible** | ✗ | ✗ | **✓ (the differentiator)** |
| **Quality score per chunk shown** | ✗ | ✗ | **✓** |
| **Gemini Function-Call output rendered verbatim** | ✗ | ✗ | **✓** |
| **Before/after savings calculation** | ✗ | ✗ | **✓** |
| Economic argument visible on-screen | partial | partial | ✓ |

AgentBazaar's "coin-flights between agents" is cool but atomic — each agent call is a single payment. The novelty of our project is that **one research session is 31 chunks**, each a separate signed authorization, and **the buyer can stop at any chunk boundary**. No existing dashboard has shown this. Ours will.

---

## What judges see in the 2:45 video

Scene 1 (0:00–0:30): land on the UI, show the full layout. Panel A (prompt), Panel F (settlement feed, empty), Panel ⑧ (empty iframe).

Scene 2 (0:30–1:15): type the prompt, click Start. Tokens appear in Panel D. Panel C gauge stays green. Panel F rows appear with signed authorizations. Panel G shows first batch. Panel ⑧ iframe updates to show the Arc explorer view of the batch tx — **the visible real blockchain confirmation.**

Scene 3 (1:15–2:00): reload, use a drifting prompt or same prompt with lower threshold to force kill. Watch the quality gauge fall. Stream stops mid-word. Red banner. Panel E receipt with savings number.

Scene 4 (2:00–2:30): click a row in Panel G → `testnet.arcscan.app` opens in a new tab with the real batch tx. Then switch to the Circle Developer Console in another tab, show the authorization-submitted events. Two sources of truth; one tx links them. **Mandatory video requirement satisfied.**

Scene 5 (2:30–2:45): recap. Point at Panel E savings number. "Paid-for-outcome. Not paid-for-compute. Only Nanopayments on Arc makes it possible."

---

## Implementation notes for the team

- **Use Server-Sent Events, not WebSockets.** Simpler, one-way, reconnect-for-free. Both the seller (Express) and buyer (Express or bare Node HTTP) expose `/events` endpoints.
- **Separate the buyer/seller processes from the web UI.** The web UI is a subscriber. This lets the same buyer/seller run headlessly for the `run-demo.ts` script without the UI.
- **Do NOT put business logic in React.** All quality evaluation, kill decisions, signing, and budget math live in `client/buyer.ts`. The UI just reflects state.
- **Polling cadence:** Arc RPC for batch confirmation at 2s interval. Gateway balance at 5s. Everything else is push via SSE.
- **Accessibility:** the dashboard should work at 1280×720 for screen recording. Test at that resolution before the demo video shoot.
- **Dark theme only.** The demo video will be watched on phones, laptops, and projectors. Dark contrasts best.
