# Vouch

**The passport and credit bureau for AI agents.** ETHOnline 2026.

An agent gets a **name** (ENSv2 subname), **split permissions** (it can write what it
claims; it cannot write its own score), and a **reputation** derived from on-chain
evidence. Anyone can pay a fraction of a cent over x402 on Hedera to ask
*"should I trust this agent?"*

> Claims are free. Evidence costs money.

Full plan: [`../vouch-plan.md`](../vouch-plan.md)

## Day-0 spike

Four gates. Each must pass before building on top of it.

| Gate | Command | Proves |
|---|---|---|
| 1 | `pnpm spike:env` | Hedera testnet reachable, key is ECDSA, balances readable |
| 2 | `pnpm spike:assoc` | Account associated with USDC (the #1 x402-on-Hedera footgun) |
| 3 | `pnpm spike:server` | A **live x402-gated service** returning a valid 402 challenge |
| 4 | `pnpm spike:client` | A buyer agent completes a **real paid request**, settled on Hedera |

### Setup

```bash
# 1. Create a TESTNET account at https://portal.hedera.com  — choose ECDSA, not ED25519
# 2. Fill in credentials
cp .env.example .env    # then edit HEDERA_ACCOUNT_ID / HEDERA_PRIVATE_KEY / X402_PAY_TO

pnpm install
pnpm spike:env
pnpm spike:assoc

# terminal 1
pnpm spike:server
# terminal 2
pnpm spike:client
```

Gate 4 prints a HashScan link to the settled transaction. That link is the
Hedera track's qualification evidence — keep it.

### If you cannot get testnet USDC

Set `X402_ASSET=0.0.0` in `.env` to settle in **HBAR** instead. HBAR needs no token
association and the x402 Hedera scheme supports it natively. Amounts become
tinybars (1e8 per HBAR), so `X402_PRICE_SCORE=100000` is 0.001 HBAR.

## Verified facts (checked 2026-09-04)

| Thing | Value |
|---|---|
| Blocky402 testnet facilitator | `https://api.testnet.blocky402.com` — healthy |
| Supported network | `hedera:testnet`, scheme `exact`, x402Version **2** |
| Facilitator fee payer | `0.0.7162784` (auto-injected into the 402; never hard-code it) |
| USDC on Hedera testnet | `0.0.429274`, 6 decimals, symbol `USDC` |
| HBAR as an x402 asset | `0.0.0` (tinybars) |

## Stack

Node 24 (native TypeScript, no build step) · Express 5 · `@hiero-ledger/sdk` ·
`@x402/{core,express,fetch,hedera}` · Drizzle + Postgres · Angular 22 · Hardhat 3
