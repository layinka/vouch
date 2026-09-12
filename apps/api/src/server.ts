/**
 * The Vouch API.
 *
 * Exports the Express app rather than listening, so the same code runs as a
 * long-lived process locally (server.ts) and as a Vercel serverless function
 * (api/index.ts). Nothing about the app changes between the two.
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
import { ExactHederaScheme as ExactHederaClientScheme } from '@x402/hedera/exact/client'
import { createClientHederaSigner } from '@x402/hedera'
import { PrivateKey } from '@hiero-ledger/sdk'
import {
  createPublicClient, createWalletClient, http as viemHttp,
  encodeFunctionData, type Hex,
} from 'viem'
import { privateKeyToAccount } from 'viem/accounts'
import { sepolia } from 'viem/chains'

const PORT = Number(process.env.PORT ?? 3000)
const NETWORK = (process.env.X402_NETWORK ?? 'hedera:testnet') as Network
const ASSET = process.env.X402_ASSET ?? '0.0.429274'
const PAY_TO = process.env.X402_PAY_TO ?? process.env.HEDERA_ACCOUNT_ID!
const FACILITATOR = process.env.X402_FACILITATOR_URL ?? 'https://api.testnet.blocky402.com'
const PRICE_SCORE = process.env.X402_PRICE_SCORE ?? (ASSET === '0.0.0' ? '100000' : '1000')
const PRICE_HISTORY = process.env.X402_PRICE_HISTORY ?? (ASSET === '0.0.0' ? '500000' : '5000')

const app = express()
// Vercel terminates TLS at the edge, so without this Express reports http and
// the x402 payment challenge advertises an http:// resource URL.
app.set('trust proxy', true)
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
  const all = await db.select().from(schema.agents).orderBy(desc(schema.agents.score))
  // A revoked name no longer resolves on-chain, so it must not appear in the
  // directory either. Its records still exist on its resolver; nothing points
  // at them.
  const rows = all.filter((a) => !a.revoked && a.ensName)
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
  // 410 rather than 404: the name existed and was deliberately revoked by its
  // owner. The distinction matters to a caller deciding whether to retry.
  if (a.revoked) {
    return res.status(410).json({
      error: 'revoked',
      name: a.ensName,
      detail: 'The owner unregistered this name. It no longer resolves on-chain.',
    })
  }
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

/**
 * A browser has no Hedera wallet, so it cannot satisfy a 402 itself. This route
 * has the server's own buyer agent perform a REAL paid lookup against our own
 * x402-gated endpoint and hands back the score together with the settlement
 * receipt — so the page can show that money actually moved, not a mock.
 */
const buyerId = process.env.HEDERA_BUYER_ACCOUNT_ID ?? process.env.HEDERA_ACCOUNT_ID!
const buyerKey = process.env.HEDERA_BUYER_PRIVATE_KEY ?? process.env.HEDERA_PRIVATE_KEY!
/**
 * The buyer agent's signer and scheme. Held directly rather than behind a
 * paying fetch wrapper, because the browser proxy settles inline against the
 * facilitator instead of issuing an HTTP request to itself.
 */
const demoSigner = buyerId && buyerKey
  ? createClientHederaSigner(buyerId, PrivateKey.fromStringECDSA(buyerKey), { network: NETWORK })
  : null
const demoScheme = demoSigner ? new ExactHederaClientScheme(demoSigner) : null!

// ---------------------------------------------------------------- Sepolia
const SEPOLIA_RPC = process.env.SEPOLIA_RPC_URL ?? 'https://ethereum-sepolia-rpc.publicnode.com'
const sepoliaClient = createPublicClient({ chain: sepolia, transport: viemHttp(SEPOLIA_RPC) })
/**
 * Inlined rather than read from packages/contracts/abis at runtime.
 *
 * A serverless bundle only ships what the bundler can trace, and a readFileSync
 * of a JSON path is invisible to it -- this endpoint crashed in production with
 * FUNCTION_INVOCATION_FAILED until the file dependency was removed. Only two
 * entries are needed: setText to build the calldata, and the custom error so
 * viem can decode the revert by name instead of returning opaque bytes.
 */
const resolverAbi = [
  {
    type: 'function',
    name: 'setText',
    stateMutability: 'nonpayable',
    inputs: [
      { name: 'node', type: 'bytes32' },
      { name: 'key', type: 'string' },
      { name: 'value', type: 'string' },
    ],
    outputs: [],
  },
  {
    type: 'error',
    name: 'EACUnauthorizedAccountRoles',
    inputs: [
      { name: 'resource', type: 'uint256' },
      { name: 'roleBitmap', type: 'uint256' },
      { name: 'account', type: 'address' },
    ],
  },
] as const

/**
 * Attempt to write a record as a chosen key, and report exactly what the chain
 * says back.
 *
 * The agent key is DELIBERATELY not authorised for agent:score. This endpoint
 * exists so that fact can be demonstrated rather than asserted: it broadcasts a
 * real transaction, which is mined and reverts, leaving an Etherscan link
 * anyone can check. Simulating would be faster and free, but "it would have
 * reverted" is a weaker claim than "here is the transaction that did".
 */
app.post('/v1/demo/attempt-write/:name', async (req, res) => {
  const name = req.params.name
  const asKey = (req.body?.as ?? 'agent') as 'agent' | 'scorer'
  const record = (req.body?.record ?? 'agent:score') as string
  const value = String(req.body?.value ?? '999')

  const rawKey = asKey === 'scorer'
    ? process.env.SCORER_PRIVATE_KEY
    : process.env.AGENT_PRIVATE_KEY
  if (!rawKey) return res.status(503).json({ error: 'key_not_configured', as: asKey })

  try {
    const [a] = await byName(name)
    if (!a?.resolver || !a.node) return res.status(404).json({ error: 'unknown_agent' })

    const account = privateKeyToAccount(rawKey as Hex)
    const data = encodeFunctionData({
      abi: resolverAbi, functionName: 'setText',
      args: [a.node as Hex, record, value],
    })

    // Simulate first, purely to decode the custom error NAME. A raw eth_call
    // gives back opaque revert data; simulateContract decodes it against the
    // ABI, which is how we get EACUnauthorizedAccountRoles rather than
    // "reverted". The broadcast below is what actually proves it.
    let revertName: string | null = null
    let revertArgs: unknown[] | null = null
    try {
      await sepoliaClient.simulateContract({
        account, address: a.resolver as Hex, abi: resolverAbi,
        functionName: 'setText', args: [a.node as Hex, record, value],
      })
    } catch (err) {
      const walk = (err as { walk?: (fn: (e: unknown) => boolean) => unknown }).walk
      const reverted = typeof walk === 'function'
        ? walk.call(err, (e: unknown) => (e as { name?: string })?.name === 'ContractFunctionRevertedError')
        : null
      const d = (reverted as { data?: { errorName?: string; args?: unknown[] } } | null)?.data
      revertName = d?.errorName ?? null
      revertArgs = d?.args ?? null
      if (!revertName) {
        revertName = /(EAC[A-Za-z]+)/.exec((err as Error).message)?.[1] ?? 'reverted'
      }
    }

    // Broadcast regardless, so there is a real transaction to point at.
    // Skipping simulation is the point: we WANT the revert on-chain.
    const wallet = createWalletClient({ account, chain: sepolia, transport: viemHttp(SEPOLIA_RPC) })
    const hash = await wallet.sendTransaction({ to: a.resolver as Hex, data, gas: 120_000n })
    const receipt = await sepoliaClient.waitForTransactionReceipt({ hash })

    res.json({
      as: asKey,
      record,
      value,
      address: account.address,
      reverted: receipt.status === 'reverted',
      error: revertName,
      errorArgs: revertArgs?.map(String) ?? null,
      txHash: hash,
      etherscan: `https://sepolia.etherscan.io/tx/${hash}`,
      resolver: a.resolver,
      message: receipt.status === 'reverted'
        ? `The ${asKey} key is not authorised to write ${record}. The transaction reverted on-chain.`
        : `The ${asKey} key wrote ${record} successfully.`,
    })
  } catch (err) {
    res.status(500).json({ error: 'attempt_failed', message: (err as Error).message })
  }
})

/**
 * The in-browser "buy a reputation lookup" button.
 *
 * A browser has no Hedera wallet, so the server pays on its behalf with the buyer
 * agent's key. The first implementation had the server issue an HTTP request to
 * its own /score endpoint so the 402 exchange was a genuine round trip. That
 * works against a listening process and 502s in a serverless function, where a
 * self-invocation is a second cold start racing the first.
 *
 * So the exchange runs inline instead: same payment requirements, same signed
 * TransferTransaction, same facilitator verify + settle, same Hedera
 * transaction. The only thing dropped is the HTTP hop to ourselves, which was
 * never the part that made the payment real.
 */
app.post('/v1/demo/buy/:name', async (req, res) => {
  const name = req.params.name
  try {
    const [a] = await byName(name)
    if (!a) return res.status(404).json({ error: 'unknown_agent' })
    if (a.revoked) return res.status(410).json({ error: 'revoked' })
    if (!demoSigner) return res.status(503).json({ error: 'no_buyer_configured' })

    // The facilitator owns the fee payer account, so ask rather than hard-code.
    const supported = await facilitator.getSupported()
    const kind = supported.kinds.find(
      (k) => k.network === NETWORK && k.scheme === 'exact',
    )
    const feePayer = (kind?.extra as { feePayer?: string } | undefined)?.feePayer
    if (!feePayer) return res.status(503).json({ error: 'facilitator_unavailable' })

    const requirements = {
      scheme: 'exact',
      network: NETWORK,
      asset: ASSET,
      amount: PRICE_SCORE,
      payTo: PAY_TO,
      maxTimeoutSeconds: 180,
      extra: { feePayer },
    }

    const built = await demoScheme.createPaymentPayload(2, requirements as never)
    const paymentPayload = {
      x402Version: 2,
      accepted: requirements,
      payload: built.payload,
      resource: { url: `https://${req.get('host')}/v1/agents/${encodeURIComponent(name)}/score` },
    }

    const verified = await facilitator.verify(paymentPayload as never, requirements as never)
    if (!verified.isValid) {
      return res.status(402).json({ error: 'payment_invalid', reason: verified.invalidReason })
    }

    const settled = await facilitator.settle(paymentPayload as never, requirements as never)
    if (!settled.success) {
      return res.status(402).json({ error: 'settlement_failed', reason: settled.errorReason })
    }

    audit({
      t: 'lookup', agent: name, score: a.score ?? 0,
      payer: settled.payer ?? 'unknown', amount: PRICE_SCORE, asset: ASSET,
      tx: settled.transaction,
    })
    void db.insert(schema.lookups).values({
      id: `${Date.now()}-${name}`,
      agentId: a.erc8004Id, agentName: name,
      payerAccount: settled.payer ?? 'unknown',
      asset: ASSET, amount: PRICE_SCORE,
      hederaTxId: settled.transaction, scoreServed: a.score,
    }).catch((e: Error) => console.error('[lookup log]', e.message))

    const scan = settled.transaction?.replace('@', '-').replace(/\.(\d{9})$/, '-$1')
    res.json({
      name: a.ensName,
      score: a.score,
      verdict: a.verdict,
      components: a.components,
      evidence: {
        totalJobs: a.totalJobs, okJobs: a.okJobs,
        disputedJobs: a.disputedJobs, failedJobs: a.failedJobs,
        uniqueCounterparties: a.uniqueCounterparties,
        disputeRateBps: a.disputeRateBps,
      },
      published: { anchorTx: a.anchorTx, ensTx: a.ensTx },
      settlement: settled.transaction
        ? { payer: settled.payer, tx: settled.transaction,
            hashscan: `https://hashscan.io/testnet/transaction/${scan}` }
        : null,
    })
  } catch (err) {
    res.status(502).json({ error: 'payment_failed', message: (err as Error).message })
  }
})

/**
 * Server-sent events. The indexer runs in a separate process, so rather than
 * wiring IPC we watch the scores table and push when one moves. That is what
 * makes a score visibly DROP on screen after a dispute is filed.
 */
app.get('/v1/events', async (req, res) => {
  res.setHeader('content-type', 'text/event-stream')
  res.setHeader('cache-control', 'no-cache')
  res.setHeader('connection', 'keep-alive')
  res.flushHeaders?.()

  let last = new Map<string, number>()
  const send = (event: string, data: unknown) =>
    res.write(`event: ${event}
data: ${JSON.stringify(data)}

`)

  const poll = async () => {
    try {
      const rows = await db.select().from(schema.agents)
      for (const a of rows) {
        if (!a.ensName || a.score == null) continue
        const prev = last.get(a.ensName)
        if (prev !== undefined && prev !== a.score) {
          send('score', { name: a.ensName, from: prev, to: a.score, verdict: a.verdict })
        }
        last.set(a.ensName, a.score)
      }
    } catch { /* keep the stream alive */ }
  }

  await poll()
  send('ready', { at: Date.now() })
  const timer = setInterval(poll, 3000)
  const beat = setInterval(() => res.write(': keepalive\n\n'), 20_000)
  req.on('close', () => { clearInterval(timer); clearInterval(beat) })
})


/**
 * Keep-alive + reindex, for the GitHub Actions cron.
 *
 * Two jobs in one request. Vercel Hobby caps cron at once per DAY, which is
 * useless for an indexer, so the schedule lives in GitHub Actions instead and
 * calls this. Touching Postgres on every run also stops Supabase pausing the
 * project after 7 days idle -- which would otherwise take the live demo down
 * mid-judging.
 *
 * Guarded by a shared secret because it writes.
 */
app.post('/api/internal/reindex', async (req, res) => {
  const secret = process.env.INTERNAL_SECRET
  const given = req.headers['x-internal-secret']
  if (!secret || given !== secret) return res.status(401).json({ error: 'unauthorized' })

  try {
    // A read is enough to keep Supabase awake; the heavy indexer runs elsewhere
    // because a serverless invocation cannot hold a poll loop open.
    const [row] = await db.select({ n: sql<number>`count(*)::int` }).from(schema.agents)
    const [cursor] = await db.select().from(schema.cursors).where(eq(schema.cursors.name, 'subgraph')).limit(1)
    res.json({
      ok: true,
      agents: row?.n ?? 0,
      lastIndexedBlock: cursor?.position ?? null,
      lastIndexedAt: cursor?.updatedAt ?? null,
      at: new Date().toISOString(),
    })
  } catch (err) {
    res.status(500).json({ ok: false, error: (err as Error).message })
  }
})

export default app

/**
 * Serverless functions are frozen the moment a response is flushed, so a
 * fire-and-forget HCS write can simply never happen. On Vercel we hand the
 * promise to waitUntil, which keeps the invocation alive until it settles.
 * Locally there is no such constraint and the queue drains on its own.
 */
export const isServerless = Boolean(process.env.VERCEL)

// Only listen when this file is the entrypoint. Under Vercel it is imported.
if (!isServerless) {
  app.listen(PORT, () => {
    console.log(`
  Vouch API on :${PORT}`)
    console.log(`  network ${NETWORK} · asset ${ASSET} · payTo ${PAY_TO}`)
    console.log(`  audit   ${hashscanTopic() ?? '(no HEDERA_TOPIC_ID)'}
`)
    console.log(`  free  GET /v1/agents`)
    console.log(`  free  GET /v1/agents/:name`)
    console.log(`  free  GET /v1/agents/:name/permissions`)
    console.log(`  PAID  GET /v1/agents/:name/score`)
    console.log(`  PAID  GET /v1/agents/:name/history
`)
  })
}
