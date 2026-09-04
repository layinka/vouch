/**
 * Day-1 gate — prove the Subgraph Studio API key authenticates against the gateway.
 *
 * The Graph track disqualifies "mocked, local-only, or static datasets", so this key
 * is load-bearing: every score Vouch serves must be traceable to a live query made
 * with it. Run this before building the indexer so a bad key fails now, not on day 4.
 *
 * Also prints the Sepolia deploy target, since that is where our subgraph goes.
 *
 * Run: node --env-file=.env spike/05-check-graph.ts
 */
const KEY = process.env.SUBGRAPH_API_KEY
const GATEWAY = process.env.GRAPH_GATEWAY_URL ?? 'https://gateway.thegraph.com/api'

// A published, always-indexed subgraph used purely as an auth canary.
const CANARY = process.env.GRAPH_CANARY_SUBGRAPH ?? '5zvR82QoaXYFyDEKLZ9t6v9adgnptxYpKpSbxtgVENFV'

if (!KEY) {
  console.error('\n  FAIL  SUBGRAPH_API_KEY is not set in .env.')
  console.error('        Get one free at https://thegraph.com/studio (connect wallet -> API Keys).\n')
  process.exit(1)
}

console.log('\n=== Vouch day-1 gate: Subgraph Studio API key ===\n')
console.log(`  key          ${KEY.slice(0, 6)}...${KEY.slice(-4)}  (${KEY.length} chars)`)

type MetaResponse = {
  data?: { _meta?: { block?: { number?: number }; deployment?: string; hasIndexingErrors?: boolean } }
  errors?: { message: string }[]
}

const res = await fetch(`${GATEWAY}/${KEY}/subgraphs/id/${CANARY}`, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ query: '{ _meta { block { number } deployment hasIndexingErrors } }' }),
})

if (!res.ok) {
  console.error(`\n  FAIL  gateway returned HTTP ${res.status}`)
  console.error(`        ${(await res.text()).slice(0, 300)}`)
  console.error('\n        401/403 => bad or revoked key. 402 => quota/spend limit hit.\n')
  process.exit(1)
}

const body = (await res.json()) as MetaResponse
if (body.errors?.length) {
  console.error(`\n  FAIL  ${body.errors.map((e) => e.message).join('; ')}\n`)
  process.exit(1)
}

const meta = body.data?._meta
console.log(`  ok           gateway authenticated`)
console.log(`  ok           live query returned block ${meta?.block?.number}`)
console.log(`               deployment ${meta?.deployment}`)
console.log(`               indexing errors: ${meta?.hasIndexingErrors}`)

console.log('\n  --- where OUR subgraph goes ---')
console.log('  network      sepolia            (eip155:11155111)')
console.log('  services     subgraphs, firehose, substreams')
console.log('  deploy       https://api.studio.thegraph.com/deploy')
console.log('  query        https://gateway.thegraph.com/api/<KEY>/subgraphs/id/<SUBGRAPH_ID>')

console.log('\n  !!  Studio dev endpoint is capped at 3,000 queries/day.')
console.log('      ONLY the indexer worker may query it, on a poll interval.')
console.log('      Never query the subgraph from an HTTP handler or the Angular app.\n')
console.log('  GATE PASSED\n')
