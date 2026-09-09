/**
 * The indexer worker.
 *
 * subgraph -> Postgres -> score -> back on-chain
 *
 * This is the ONLY process permitted to query the subgraph. Studio's dev
 * endpoint allows 3,000 queries/day, and a UI that polled it directly would
 * exhaust that during a demo. Everything the API serves is read from Postgres.
 *
 * Each pass:
 *   1. pull agents + attestations from the subgraph
 *   2. upsert into Postgres
 *   3. recompute scores
 *   4. for any score that moved more than THRESHOLD, publish it:
 *        - VouchScoreAnchor.anchor()  (time series + audit)
 *        - setText(agent:score)       (the live value, scorer key only)
 *
 * Run once:      node --env-file=.env apps/api/src/worker/indexer.ts --once
 * Run forever:   node --env-file=.env apps/api/src/worker/indexer.ts
 */
import { readFileSync } from 'node:fs'
import { eq, sql } from 'drizzle-orm'
import { createPublicClient, createWalletClient, http, keccak256, toHex, namehash, type Hex } from 'viem'
import { privateKeyToAccount } from 'viem/accounts'
import { sepolia } from 'viem/chains'
import { db, schema, pool } from '../db/client.ts'
import { computeScore, evidenceDigest, type Evidence } from '../scoring/compute.ts'

const SUBGRAPH_URL = process.env.SUBGRAPH_URL
  ?? 'https://api.studio.thegraph.com/query/1758675/vouch/v0.0.1'
const RPC = process.env.SEPOLIA_RPC_URL ?? 'https://ethereum-sepolia-rpc.publicnode.com'
const INTERVAL_MS = Number(process.env.INDEXER_INTERVAL_MS ?? 45_000)
const ONCE = process.argv.includes('--once')
const PUBLISH = !process.argv.includes('--no-publish')
/** Only publish when a score actually moved — every publish costs two transactions. */
const THRESHOLD = Number(process.env.SCORE_PUBLISH_THRESHOLD ?? 5)

const dep = JSON.parse(readFileSync('deployments/sepolia.json', 'utf8')) as {
  vouchScoreAnchor?: Hex
  agents: Record<string, { name: string; resolver: Hex; node: Hex; erc8004Id?: string }>
}
const anchorAbi = JSON.parse(readFileSync('packages/contracts/abis/VouchScoreAnchor.json', 'utf8'))
const resolverAbi = JSON.parse(readFileSync('packages/contracts/abis/PermissionedResolverImpl.json', 'utf8'))

const scorerKey = process.env.SCORER_PRIVATE_KEY as Hex | undefined
const scorer = scorerKey ? privateKeyToAccount(scorerKey) : null
const pub = createPublicClient({ chain: sepolia, transport: http(RPC) })
const wallet = scorer ? createWalletClient({ account: scorer, chain: sepolia, transport: http(RPC) }) : null

const log = (...a: unknown[]) => console.log(new Date().toISOString().slice(11, 19), ...a)

// ---------------------------------------------------------------- subgraph
type SgAgent = {
  id: string; ensName: string | null; uaid: string | null; node: string | null; owner: string
  totalJobs: number; okJobs: number; disputedJobs: number; failedJobs: number
  uniqueCounterparties: number; disputeRateBps: number; settledValue: string
}
type SgAttestation = {
  id: string; agent: { id: string }; attestor: { id: string }; jobRef: string
  outcome: 'Ok' | 'Disputed' | 'Failed'; value: string
  disputeReason: string | null; disputedAt: string | null
  timestamp: string; block: string; txHash: string
}

const QUERY = `{
  _meta { block { number } hasIndexingErrors }
  agents(first: 200, orderBy: totalJobs, orderDirection: desc) {
    id ensName uaid node owner
    totalJobs okJobs disputedJobs failedJobs
    uniqueCounterparties disputeRateBps settledValue
  }
  attestations(first: 1000, orderBy: timestamp, orderDirection: desc) {
    id agent { id } attestor { id } jobRef outcome value
    disputeReason disputedAt timestamp block txHash
  }
}`

async function fetchSubgraph() {
  const res = await fetch(SUBGRAPH_URL, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ query: QUERY }),
  })
  if (!res.ok) throw new Error(`subgraph HTTP ${res.status}`)
  const body = (await res.json()) as {
    data?: { _meta: { block: { number: number }; hasIndexingErrors: boolean }
             agents: SgAgent[]; attestations: SgAttestation[] }
    errors?: { message: string }[]
  }
  if (body.errors?.length) throw new Error(body.errors.map((e) => e.message).join('; '))
  if (!body.data) throw new Error('subgraph returned no data')
  return body.data
}

// ---------------------------------------------------------------- publish
async function publish(agentId: string, score: number, components: Record<string, number>, digest: string) {
  // --no-publish must be a true no-op: if it recorded publishedScore, the next
  // real run would think the work was already done and skip every agent.
  if (!PUBLISH || !wallet || !scorer || !dep.vouchScoreAnchor) {
    return { published: false, anchorTx: null, ensTx: null }
  }

  const evidenceRoot = keccak256(toHex(digest))
  const componentBytes = toHex(JSON.stringify(components))

  // 1. anchor on-chain: gives the subgraph a time series, not just a latest value
  const { request } = await pub.simulateContract({
    account: scorer, address: dep.vouchScoreAnchor, abi: anchorAbi,
    functionName: 'anchor', args: [BigInt(agentId), score, evidenceRoot, componentBytes],
  })
  const anchorTx = await wallet.writeContract(request)
  await pub.waitForTransactionReceipt({ hash: anchorTx })

  // 2. write the live value onto the agent's ENS name.
  //    The SCORER key is the only key on earth authorised for this record.
  const entry = Object.values(dep.agents).find((a) => a.erc8004Id === agentId)
  let ensTx: Hex | null = null
  if (entry) {
    const node = entry.node ?? (namehash(entry.name) as Hex)
    const { request: r2 } = await pub.simulateContract({
      account: scorer, address: entry.resolver, abi: resolverAbi,
      functionName: 'setText', args: [node, 'agent:score', String(score)],
    })
    ensTx = await wallet.writeContract(r2)
    await pub.waitForTransactionReceipt({ hash: ensTx })
  }
  return { published: true, anchorTx, ensTx }
}

// ---------------------------------------------------------------- one pass
async function tick() {
  const data = await fetchSubgraph()
  if (data._meta.hasIndexingErrors) log('WARN subgraph reports indexing errors')

  // --- attestations ---
  if (data.attestations.length) {
    const rows = data.attestations.map((a) => ({
      id: a.id,
      agentId: a.agent.id,
      attestor: a.attestor.id,
      jobRef: a.jobRef,
      outcome: a.outcome,
      value: a.value,
      disputeReason: a.disputeReason,
      disputedAt: a.disputedAt ? Number(a.disputedAt) : null,
      timestamp: Number(a.timestamp),
      block: Number(a.block),
      txHash: a.txHash,
    }))
    await db.insert(schema.attestations).values(rows).onConflictDoUpdate({
      target: schema.attestations.id,
      set: {
        outcome: sql`excluded.outcome`,
        disputeReason: sql`excluded.dispute_reason`,
        disputedAt: sql`excluded.disputed_at`,
      },
    })
  }

  // --- agents + scoring ---
  let published = 0
  for (const a of data.agents) {
    const firstSeen = data.attestations
      .filter((x) => x.agent.id === a.id)
      .reduce<number | undefined>((min, x) => {
        const t = Number(x.timestamp)
        return min === undefined || t < min ? t : min
      }, undefined)

    const evidence: Evidence = {
      totalJobs: a.totalJobs,
      okJobs: a.okJobs,
      disputedJobs: a.disputedJobs,
      failedJobs: a.failedJobs,
      uniqueCounterparties: a.uniqueCounterparties,
      settledValue: a.settledValue,
      firstSeen,
    }
    const { score, verdict, components } = computeScore(evidence)

    const [existing] = await db.select().from(schema.agents).where(eq(schema.agents.erc8004Id, a.id))
    const moved = !existing?.publishedScore || Math.abs(existing.publishedScore - score) >= THRESHOLD

    // The subgraph does not carry the agent's resolver on the Agent entity, but
    // the deployment manifest does -- and the UI needs it to link to Etherscan.
    const depEntry = Object.values(dep.agents).find((x) => x.erc8004Id === a.id)

    await db.insert(schema.agents).values({
      erc8004Id: a.id,
      ensName: a.ensName, uaid: a.uaid, node: a.node, owner: a.owner,
      resolver: depEntry?.resolver ?? null,
      totalJobs: a.totalJobs, okJobs: a.okJobs,
      disputedJobs: a.disputedJobs, failedJobs: a.failedJobs,
      uniqueCounterparties: a.uniqueCounterparties,
      disputeRateBps: a.disputeRateBps, settledValue: a.settledValue,
      score, verdict, components, computedAt: new Date(), updatedAt: new Date(),
    }).onConflictDoUpdate({
      target: schema.agents.erc8004Id,
      set: {
        ensName: sql`excluded.ens_name`, uaid: sql`excluded.uaid`,
        node: sql`excluded.node`, owner: sql`excluded.owner`,
        resolver: sql`excluded.resolver`,
        totalJobs: sql`excluded.total_jobs`, okJobs: sql`excluded.ok_jobs`,
        disputedJobs: sql`excluded.disputed_jobs`, failedJobs: sql`excluded.failed_jobs`,
        uniqueCounterparties: sql`excluded.unique_counterparties`,
        disputeRateBps: sql`excluded.dispute_rate_bps`,
        settledValue: sql`excluded.settled_value`,
        score: sql`excluded.score`, verdict: sql`excluded.verdict`,
        components: sql`excluded.components`,
        computedAt: sql`excluded.computed_at`, updatedAt: sql`excluded.updated_at`,
      },
    })

    if (!moved) continue

    const digest = evidenceDigest(evidence)
    try {
      const { published: didPublish, anchorTx, ensTx } = await publish(a.id, score, components, digest)
      if (!didPublish) {
        log(`  ${a.ensName ?? a.id} -> ${score} (${verdict})  [dry run, not published]`)
        continue
      }
      await db.update(schema.agents).set({
        publishedScore: score,
        anchorTx: anchorTx ?? undefined,
        ensTx: ensTx ?? undefined,
      }).where(eq(schema.agents.erc8004Id, a.id))

      await db.insert(schema.scoreHistory).values({
        id: `${a.id}-${Date.now()}`,
        agentId: a.id, score, components,
        evidenceRoot: keccak256(toHex(digest)),
        anchorTx: anchorTx ?? undefined,
        ensTx: ensTx ?? undefined,
      })
      published++
      log(`  ${a.ensName ?? a.id} -> ${score} (${verdict})${anchorTx ? ` anchored ${anchorTx.slice(0, 10)}` : ''}`)
    } catch (err) {
      log(`  publish failed for ${a.ensName ?? a.id}: ${(err as Error).message.split('\n')[0]}`)
    }
  }

  await db.insert(schema.cursors)
    .values({ name: 'subgraph', position: String(data._meta.block.number), updatedAt: new Date() })
    .onConflictDoUpdate({
      target: schema.cursors.name,
      set: { position: sql`excluded.position`, updatedAt: sql`excluded.updated_at` },
    })

  log(`block ${data._meta.block.number} · ${data.agents.length} agents · ${data.attestations.length} attestations · ${published} published`)
}

// ---------------------------------------------------------------- run
log(`indexer starting · subgraph ${SUBGRAPH_URL}`)
log(`publish=${PUBLISH} scorer=${scorer?.address ?? 'none'} threshold=${THRESHOLD}`)

try {
  await tick()
  if (!ONCE) {
    log(`polling every ${INTERVAL_MS / 1000}s`)
    for (;;) {
      await new Promise((r) => setTimeout(r, INTERVAL_MS))
      try { await tick() } catch (err) { log('tick failed:', (err as Error).message) }
    }
  }
} finally {
  if (ONCE) await pool.end()
}
