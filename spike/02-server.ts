/**
 * Day-0 gate 3/4 — a LIVE x402-gated service on Hedera testnet.
 *
 * This is the Hedera track's hard requirement: "Host a live x402-gated service on
 * Hedera testnet or mainnet, settled through the Blocky402 facilitator."
 *
 * Two routes, and the split between them is the product thesis:
 *   GET /v1/agents/:name          FREE  — what the agent CLAIMS about itself
 *   GET /v1/agents/:name/score    PAID  — what the agent has actually DONE
 *
 * Run: pnpm spike:server
 */
import express from 'express'
import { paymentMiddlewareFromConfig } from '@x402/express'
import { HTTPFacilitatorClient } from '@x402/core/server'
import { ExactHederaScheme } from '@x402/hedera/exact/server'
import type { Network } from '@x402/core/types'

const PORT = Number(process.env.PORT ?? 3000)
const NETWORK = (process.env.X402_NETWORK ?? 'hedera:testnet') as Network
const ASSET = process.env.X402_ASSET ?? '0.0.429274' // USDC testnet, 6dp; '0.0.0' = HBAR
const PAY_TO = process.env.X402_PAY_TO ?? process.env.HEDERA_ACCOUNT_ID
const FACILITATOR = process.env.X402_FACILITATOR_URL ?? 'https://api.testnet.blocky402.com'

if (!PAY_TO) {
  console.error('\n  FAIL  X402_PAY_TO (or HEDERA_ACCOUNT_ID) must be set.\n')
  process.exit(1)
}

// Amounts are in the asset's SMALLEST unit.
// USDC = 6 decimals, so "1000" = $0.001. HBAR = tinybars, 1e8 per HBAR.
const PRICE_SCORE = process.env.X402_PRICE_SCORE ?? (ASSET === '0.0.0' ? '100000' : '1000')

// --- stand-in data; the real thing comes from the subgraph on day 4 ---
const AGENTS: Record<string, { score: number; disputes: number; volume: string; jobs: number }> = {
  'researcher.vouch.eth': { score: 812, disputes: 2, volume: '14200.00', jobs: 96 },
  'pricefeed.vouch.eth': { score: 640, disputes: 11, volume: '3100.00', jobs: 88 },
  'trader.vouch.eth': { score: 208, disputes: 40, volume: '900.00', jobs: 100 },
}

const app = express()
app.use(express.json())

const facilitator = new HTTPFacilitatorClient({ url: FACILITATOR, timeoutMs: 30_000 })

app.use(
  paymentMiddlewareFromConfig(
    {
      'GET /v1/agents/*/score': {
        accepts: [
          {
            scheme: 'exact',
            network: NETWORK,
            payTo: PAY_TO,
            price: { asset: ASSET, amount: PRICE_SCORE },
            maxTimeoutSeconds: 180,
          },
        ],
        description: 'Vouch trust score for an AI agent, derived from on-chain evidence.',
        serviceName: 'Vouch',
        mimeType: 'application/json',
        // What a non-paying caller sees — a teaser, not a wall.
        unpaidResponseBody: () => ({
          contentType: 'application/json',
          body: {
            error: 'payment_required',
            hint: 'Claims are free. Evidence costs $0.001. Pay with x402 on Hedera.',
          },
        }),
      },
    },
    facilitator,
    [{ network: NETWORK, server: new ExactHederaScheme() }],
  ),
)

// ---- FREE: the agent's own claims ----
app.get('/v1/agents/:name', (req, res) => {
  const a = AGENTS[req.params.name]
  if (!a) return res.status(404).json({ error: 'unknown_agent' })
  res.json({
    name: req.params.name,
    claims: { endpoint: `https://${req.params.name}/x402`, capabilities: ['research', 'summarize'] },
    note: 'These are self-asserted. The agent writes them. Buy /score for evidence.',
  })
})

// ---- PAID: the evidence ----
app.get('/v1/agents/:name/score', (req, res) => {
  const a = AGENTS[req.params.name]
  if (!a) return res.status(404).json({ error: 'unknown_agent' })
  const disputeRate = a.disputes / a.jobs
  res.json({
    name: req.params.name,
    score: a.score,
    verdict: a.score >= 700 ? 'trusted' : a.score >= 400 ? 'caution' : 'avoid',
    evidence: {
      settledVolumeUsd: a.volume,
      jobs: a.jobs,
      disputes: a.disputes,
      disputeRateBps: Math.round(disputeRate * 10_000),
    },
    servedAt: new Date().toISOString(),
  })
})

app.get('/health', (_req, res) => res.json({ ok: true, network: NETWORK, asset: ASSET, payTo: PAY_TO }))

app.listen(PORT, () => {
  console.log('\n=== Vouch day-0 gate 3/4: x402-gated service is LIVE ===\n')
  console.log(`  network      ${NETWORK}`)
  console.log(`  asset        ${ASSET}${ASSET === '0.0.0' ? '  (HBAR, tinybars)' : '  (USDC, 6dp)'}`)
  console.log(`  payTo        ${PAY_TO}`)
  console.log(`  price        ${PRICE_SCORE} (smallest units)`)
  console.log(`  facilitator  ${FACILITATOR}`)
  console.log(`\n  free   GET  http://localhost:${PORT}/v1/agents/researcher.vouch.eth`)
  console.log(`  PAID   GET  http://localhost:${PORT}/v1/agents/researcher.vouch.eth/score`)
  console.log(`\n  Try the 402:  curl -i http://localhost:${PORT}/v1/agents/researcher.vouch.eth/score`)
  console.log(`  Then pay:     pnpm spike:client\n`)
})
