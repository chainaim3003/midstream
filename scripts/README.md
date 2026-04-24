# scripts/

One-shot CLI utilities. Every script reads from `.env.local`. No script takes
secrets on the command line.

## Gate 1 — first real on-chain tx

This is the critical first gate. If the three commands below succeed and you
see a deposit transaction on `https://testnet.arcscan.app`, then the whole
Circle-Gateway-on-Arc stack is working for your wallet and the rest of the
build has no systemic unknowns.

```bash
# 1. Install deps (once)
cd agentic_economy_refined
npm install

# 2. Create .env.local from the template
cp .env.example .env.local

# 3. Generate buyer and seller wallets
npm run generate-wallets
# → writes BUYER_/SELLER_ PRIVATE_KEY + ADDRESS into .env.local
# → prints the public addresses only

# 4. Fund the buyer address at https://faucet.circle.com/ (Arc testnet; 20 USDC / 2h)

# 5. Fill in API keys in .env.local:
#      CIRCLE_API_KEY     (for later steps; not needed for deposit)
#      ANTHROPIC_API_KEY  (seller-side, for later)
#      GEMINI_API_KEY     (buyer-side, for later)

# 6. Verify the faucet funded the buyer
npm run check-balances
# → should show BUYER: 20 USDC (or whatever the faucet gave)

# 7. Deposit 5 USDC into the buyer's Gateway balance
npm run deposit 5
# → prints approve tx hash and deposit tx hash
# → waits for both to confirm (~0.5s each on Arc testnet)
# → prints explorer URLs you can paste into SUBMISSION.md
```

If step 7 succeeds, take a screenshot of the deposit tx on
`testnet.arcscan.app` — that's the primary evidence for gate 1 passing.

## All scripts

| Script | Purpose | When |
|---|---|---|
| `generate-wallets.ts` | Create fresh buyer + seller EVM keypairs in `.env.local` | Once, or with `--force` to regenerate |
| `deposit-to-gateway.ts` | USDC approve + Gateway deposit on Arc | Once per demo session (or as needed) |
| `check-balances.ts` | Print wallet USDC balances | Between faucet funding and deposit; any time for sanity |
| `verify-onchain.ts` | Read `logs/*.json`, assert ≥50 real settlements on Arc | Before submission, to prove the 50-tx requirement |
| `run-demo.ts` | Run 3 full sessions for the video (written later) | Day of video recording |

## Known-for-sure vs. verify-against-working-project

- `generate-wallets.ts`: 100% standard viem. No unknowns.
- `check-balances.ts`: 100% standard ERC-20 + viem. No unknowns.
- `deposit-to-gateway.ts`: USDC approve is standard ERC-20 (known). The
  Gateway Wallet deposit function signature is assumed to be
  `deposit(address token, uint256 amount)` which is the common shape, but
  the ABI block in the script is isolated — if your other tested project
  uses a different signature, update only that ABI block and the
  `writeContract` call. Everything else is independent.
- `verify-onchain.ts`: 100% standard viem `getTransactionReceipt`. No unknowns.
