/**
 * The Vouch API.
 *
 * The route split is the product thesis, not a paywall:
 *
 *   FREE   what the agent CLAIMS  — self-asserted, worth exactly what you paid
 *   PAID   what the agent has DONE — derived from indexed on-chain evidence
 *
 * Paid routes are x402-gated on Hedera, settled through Blocky402. Every paid
 * lookup is written to an HCS topic behind the response.
 *
 * Run: pnpm api
 */
import express from 'express'
import { desc, eq, sql } from 'drizzle-orm'
import { paymentMiddleware } from '@x402/express'
import { HTTPFacilitatorClient, x402ResourceServer } from '@x402/core/server'
import { ExactHederaScheme } from '@x402/hedera/exact/server'
import type { Network } from '@x402/core/types'
import { db, schema } from './db/client.ts'
import { audit, readAudit, hashscanTopic } from './hedera/hcs.ts'

const PORT = Number(process.env.PORT ?? 3000)
const NETWORK = (process.env.X402_NETWORK ?? 'hedera:testnet') as Network
const ASSET = process.env.X402_ASSET ?? '0.0.429274'
const PAY_TO = process.env.X402_PAY_TO ?? process.env.HEDERA_ACCOUNT_ID!
const FACILITATOR = process.env.X402_FACILITATOR_URL ?? 'https://api.testnet.blocky402.com'
const PRICE_SCORE = process.env.X402_PRICE_SCORE ?? (ASSET === '0.0.0' ? '100000' : '1000')
const PRICE_HISTORY = process.env.X402_PRICE_HISTORY ?? (ASSET === '0.0.0' ? '500000' : '5000')

const app = express()
app.use(express.json())
app.use((_req, res, next) => {
  res.setHeader('access-control-allow-origin', '*')
  res.setHeader('access-control-allow-headers', 'content-type, payment, x-payment')
  res.setHeader('access-control-expose-headers', 'payment-response, payment-required')
  next()
})

// ---------------------------------------------------------------- helpers
const byName = (name: string) =>
  db.select().from(schema.agents).where(eq(schema.agents.ensName, name)).limit(1)

const facilitator = new HTTPFacilitatorClient({ url: FACILITATOR, timeoutMs: 30_000 })

/**
 * Settlement completes after the handler has responded, so the handler can never
 * know who paid. onAfterSettle can: it fires with the settled payer and the
 * Hedera transaction id. Writing the audit record HERE rather than in the
 * handler means the trail records what actually settled, not what we hoped would.
 */
const resourceServer = new x402ResourceServer(facilitator)
  .register(NETWORK, new ExactHederaScheme())
  .onAfterSettle(async (ctx) => {
    const c = ctx as unknown as {
      result?: { success?: boolean; payer?: string; transaction?: string }
      // the hook context calls this `requirements`, not `paymentRequirements`
      requirements?: { resource?: string; amount?: string; asset?: string }
      paymentPayload?: { resource?: { url?: string } }
    }
    if (!c.result?.success) return

    const url = c.requirements?.resource ?? c.paymentPayload?.resource?.url ?? ''
    const m = /\/v1\/agents\/([^/]+)\/(score|history)/.exec(url)
    const agentName = m ? decodeURIComponent(m[1]!) : 'unknown'

    const [a] = agentName === 'unknown' ? [] : await byName(agentName)

    audit({
      t: 'lookup',
      agent: agentName,
      score: a?.score ?? 0,
      payer: c.result.payer ?? 'unknown',
      amount: c.requirements?.amount ?? PRICE_SCORE,
      asset: c.requirements?.asset ?? ASSET,
      tx: c.result.transaction,
    })

    await db.insert(schema.lookups).values({
      id: `${Date.now()}-${agentName}`,
      agentId: a?.erc8004Id, agentName,
      payerAccount: c.result.payer ?? 'unknown',
      asset: c.requirements?.asset ?? ASSET,
      amount: c.requirements?.amount ?? PRICE_SCORE,
      hederaTxId: c.result.transaction,
      scoreServed: a?.score,
    }).catch((e: Error) => console.error('[lookup log]', e.message))
  })

const ROUTES = {
  'GET /v1/agents/*/score': {
    accepts: [{ scheme: 'exact' as const, network: NETWORK, payTo: PAY_TO,
                price: { asset: ASSET, amount: PRICE_SCORE }, maxTimeoutSeconds: 180 }],
    description: 'Vouch trust score for an AI agent, derived from indexed on-chain evidence.',
    serviceName: 'Vouch',
    unpaidResponseBody: () => ({
      contentType: 'application/json',
      body: { error: 'payment_required',
              hint: 'Claims are free. Evidence costs $0.001. Pay with x402 on Hedera.' },
    }),
  },
  'GET /v1/agents/*/history': {
    accepts: [{ scheme: 'exact' as const, network: NETWORK, payTo: PAY_TO,
                price: { asset: ASSET, amount: PRICE_HISTORY }, maxTimeoutSeconds: 180 }],
    description: 'Full attestation history for an AI agent.',
    serviceName: 'Vouch',
  },
}

app.use(paymentMiddleware(ROUTES, resourceServer))

// ---------------------------------------------------------------- FREE
app.get('/health', async (_req, res) => {
  const [row] = await db.select({ n: sql<number>`count(*)::int` }).from(schema.agents)
  res.json({ ok: true, agents: row?.n ?? 0, network: NETWORK, asset: ASSET, payTo: PAY_TO,
             auditTopic: hashscanTopic() })
})

/** Directory. Free, so agents can discover each other before deciding to pay. */
app.get('/v1/agents', async (_req, res) => {
  const rows = await db.select().from(schema.agents).orderBy(desc(schema.agents.score))
  res.json({
    agents: rows.map((a) => ({
      name: a.ensName, erc8004Id: a.erc8004Id, uaid: a.uaid,
      verdict: a.verdict, totalJobs: a.totalJobs,
      // deliberately NOT the score — that is the paid product
    })),
  })
})

/** What the agent says about itself. */
app.get('/v1/agents/:name', async (req, res) => {
  const [a] = await byName(req.params.name)
  if (!a) return res.status(404).json({ error: 'unknown_agent' })
  res.json({
    name: a.ensName,
    identity: { erc8004Id: a.erc8004Id, uaid: a.uaid, node: a.node, resolver: a.resolver },
    claims: { endpoint: `https://${a.ensName}/x402` },
    note: 'Self-asserted. The agent writes these. Buy /score for what it has actually done.',
  })
})

/** Who may write which record. This is the ENS story, queryable. */
app.get('/v1/agents/:name/permissions', async (req, res) => {
  const [a] = await byName(req.params.name)
  if (!a) return res.status(404).json({ error: 'unknown_agent' })
  res.json({
    name: a.ensName,
    resolver: a.resolver,
    records: [
      { key: 'agent:endpoint', writer: 'agent', canAgentWrite: true },
      { key: 'agent:capabilities', writer: 'agent', canAgentWrite: true },
      { key: 'agent:price', writer: 'agent', canAgentWrite: true },
      { key: 'agent:score', writer: 'scorer', canAgentWrite: false },
      { key: 'agent:disputes', writer: 'scorer', canAgentWrite: false },
      { key: 'agent:volume', writer: 'scorer', canAgentWrite: false },
    ],
    enforcedBy: 'ENSv2 Enhanced Access Control, per text key, on the PermissionedResolver',
    revertsWith: 'EACUnauthorizedAccountRoles',
  })
})

app.get('/v1/audit', async (_req, res) => {
  res.json({ topic: hashscanTopic(), entries: await readAudit(40) })
})

// ---------------------------------------------------------------- PAID
app.get('/v1/agents/:name/score', async (req, res) => {
  const [a] = await byName(req.params.name)
  if (!a) return res.status(404).json({ error: 'unknown_agent' })

  const payload = {
    name: a.ensName,
    score: a.score,
    verdict: a.verdict,
    components: a.components,
    evidence: {
      totalJobs: a.totalJobs, okJobs: a.okJobs,
      disputedJobs: a.disputedJobs, failedJobs: a.failedJobs,
      uniqueCounterparties: a.uniqueCounterparties,
      disputeRateBps: a.disputeRateBps,
      settledValueWei: a.settledValue,
    },
    published: { anchorTx: a.anchorTx, ensTx: a.ensTx },
    computedAt: a.computedAt,
  }
  // The audit record is written by the onAfterSettle hook above, once the
  // payment has actually settled and we know who paid.
  res.json(payload)
})

app.get('/v1/agents/:name/history', async (req, res) => {
  const [a] = await byName(req.params.name)
  if (!a) return res.status(404).json({ error: 'unknown_agent' })
  const rows = await db.select().from(schema.attestations)
    .where(eq(schema.attestations.agentId, a.erc8004Id))
    .orderBy(desc(schema.attestations.timestamp)).limit(100)
  res.json({
    name: a.ensName,
    attestations: rows.map((r) => ({
      attestor: r.attestor, outcome: r.outcome, value: r.value,
      timestamp: r.timestamp, txHash: r.txHash, disputeReason: r.disputeReason,
    })),
  })
})

app.listen(PORT, () => {
  console.log(`\n  Vouch API on :${PORT}`)
  console.log(`  network ${NETWORK} · asset ${ASSET} · payTo ${PAY_TO}`)
  console.log(`  audit   ${hashscanTopic() ?? '(no HEDERA_TOPIC_ID)'}\n`)
  console.log(`  free  GET /v1/agents`)
  console.log(`  free  GET /v1/agents/:name`)
  console.log(`  free  GET /v1/agents/:name/permissions`)
  console.log(`  PAID  GET /v1/agents/:name/score`)
  console.log(`  PAID  GET /v1/agents/:name/history\n`)
})
