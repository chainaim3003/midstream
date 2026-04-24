# PROJECT_CONTEXT.md — agentic_economy_refined

> **Per user Rule 6**: This file is authoritative for this project. Read before doing anything else here.

> **2026-04-22 revision note**: the architecture description below was written
> for v1. It has been refined — see `IMPLEMENTATION_REVISION.md` and the current
> `DESIGN.md` / `STRUCTURE.md` for the corrected, buildable version. The
> **verified facts** section below is still authoritative; only the
> "one SSE stream with mid-stream 402 pauses" assumption in v1 has been replaced
> with "one HTTP request per chunk." Business pitch, hackathon requirements,
> and every cited fact remain unchanged.

## What this project is

A working reference implementation for the **Agentic Economy on Arc** hackathon (Circle + Arc, April 20–26 2026) that demonstrates **buyer-controlled, per-chunk-paid streaming LLM inference with real-time quality-based mid-stream cutoff**, using the official Circle Gateway Nanopayments SDK and the x402 protocol.

The core thesis: with gas-free sub-cent USDC settlement on Arc, the buyer can unilaterally stop paying the moment the seller's output falls below a quality threshold, and the seller stops generating. The buyer pays only for the acceptable prefix. This is not possible with today's rails; per-call gas or payment processor fees erode margin long before you get to per-token billing.

## Why this project exists

The sibling project `../agentic_economy/` was a prior attempt. **It is mocked** (see `REFINEMENT_ANALYSIS.md`). Key issues:

1. Written in Python — Circle's Nanopayments SDK is **Node.js / TypeScript only** (`@circle-fin/x402-batching` + `@x402/evm`). The sibling project cannot integrate with real Circle infrastructure.
2. EIP-712 domain is wrong — uses `"USD Coin"` v2 (standard USDC direct transfer domain); Gateway batched nanopayments require `"GatewayWalletBatched"` v1 with the Gateway Wallet contract as `verifyingContract`.
3. x402 HTTP header format is wrong — uses `Bearer amount=...` key-value; real spec uses `PAYMENT-REQUIRED` / `PAYMENT-SIGNATURE` / `PAYMENT-RESPONSE` with base64-encoded JSON payloads.
4. `ArcTestnet` and `CircleNanopayments` classes store everything in Python dicts; no RPC calls, no API calls. "97+ on-chain transactions" in the submission are a local simulator.
5. EIP-3009 signer uses `encode_defunct` (EIP-191 personal_sign) on a human-readable text blob, not EIP-712 typed data. Would be rejected by the USDC contract.

## Official sources (ground truth — always read these)

| Source | URL |
|---|---|
| Hackathon overview | https://community.arc.network/public/events/agentic-economy-on-arc-hackathon-xoayqenc6j |
| Hackathon registration + tracks | https://lablab.ai/ai-hackathons/nano-payments-arc |
| Circle Nanopayments overview | https://developers.circle.com/gateway/nanopayments |
| x402 concept | https://developers.circle.com/gateway/nanopayments/concepts/x402 |
| Batched settlement | https://developers.circle.com/gateway/nanopayments/concepts/batched-settlement |
| x402 buyer how-to | https://developers.circle.com/gateway/nanopayments/howtos/x402-buyer |
| x402 seller how-to | https://developers.circle.com/gateway/nanopayments/howtos/x402-seller |
| EIP-3009 signing | https://developers.circle.com/gateway/nanopayments/howtos/eip-3009-signing |
| Circle Faucet | https://faucet.circle.com/ (Arc testnet: 20 USDC / 2 hours / address) |
| x402 protocol spec | https://x402.org/ and https://docs.x402.org/ |
| x402 reference impl | https://github.com/coinbase/x402 |
| Circle blog on Nanopayments launch | https://www.circle.com/blog/circle-nanopayments-launches-on-testnet-as-the-core-primitive-for-agentic-economic-activity |
| Reference project (AgentBazaar) | https://github.com/janneh2000/AgentBazaar |
| Arc docs | https://docs.arc.network/ |

## Verified facts (checked against official docs)

- **Arc testnet chain ID**: `5042002`
- **Arc testnet RPC**: `https://rpc.arc.testnet.circle.com` (per sibling project; not re-verified against docs.arc.network)
- **Gateway EIP-712 domain for nanopayments**:
  ```
  { name: "GatewayWalletBatched", version: "1", chainId: 5042002,
    verifyingContract: <GatewayWallet address from 402 response .extra.verifyingContract> }
  ```
- **TransferWithAuthorization struct** (EIP-3009):
  ```
  from (address), to (address), value (uint256),
  validAfter (uint256), validBefore (uint256), nonce (bytes32)
  ```
- **`validBefore` must be ≥ 3 days in the future** — Gateway rejects shorter validity so batch inclusion has headroom
- **x402 protocol headers** (all uppercase):
  - `PAYMENT-REQUIRED` (server→client, payment challenge)
  - `PAYMENT-SIGNATURE` (client→server, base64-encoded JSON payload)
  - `PAYMENT-RESPONSE` (server→client, confirmation)
- **SDK stack**:
  - Server: `@x402/express` or `@x402/core` + `@circle-fin/x402-batching/server` (provides `BatchFacilitatorClient`, `GatewayEvmScheme`)
  - Client: `@x402/core` + `@circle-fin/x402-batching/client` (provides `CompositeEvmScheme`, `BatchEvmScheme`, `GatewayClient`)
  - Signing: `viem` (`privateKeyToAccount` + `signTypedData`)
- **Deposit finality on Arc Testnet**: ~0.5 sec (fastest of all Gateway-supported chains)
- **Hackathon mandatory requirements**:
  - Real per-action pricing ≤ $0.01
  - ≥ 50 on-chain transactions demonstrated
  - Margin explanation (why this fails with traditional gas)
  - Detailed Circle product feedback ($500 USDC side-prize pool)
  - Public GitHub repo
  - Working demo URL
  - Transaction flow video
- **Hackathon prize pool**: $10,000
- **Hackathon tracks** (verified from search snippets; lablab.ai main page returns 403 to bots):
  - Per-API Monetization Engine
  - Agent-to-Agent Payment Loop ("Build a system where two or more agents autonomously trigger and settle payments")
  - Digital product / service with X402 revenue model (token-gated access, rev-splits, instant payouts)
  - Usage-Based Compute Billing (supporting)

## Open items (not verified)

- The `verifyingContract` address for `GatewayWalletBatched` on Arc testnet — retrieve at runtime from the 402 response's `accepts[i].extra.verifyingContract`, or via SDK `getVerifyingContract()`. **Do not hard-code.**
- Whether docs.x402.org has moved since the Circle blog linked to it — check live.
- Full current list of hackathon tracks — lablab.ai main page returns 403 to bots; user should copy-paste if working on track selection.
- Circle's exact batch-settlement cadence (how long between a signed authorization being accepted and its batch tx appearing on Arc). Affects dashboard polling cadence and demo video timing. Ask in Circle Discord before recording the video.

## How to use this project

See `README.md`. Two-sided local system: run the seller (Express + Circle Gateway facilitator) and the web-server (imports the buyer library, bridges to the browser). Plus a Vite-served React UI. See `STRUCTURE.md` for the full runtime topology.
