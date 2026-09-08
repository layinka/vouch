/**
 * DEMO MOMENT B — a buyer agent hires a seller, with no human in the loop.
 *
 * The buyer:
 *   1. discovers candidates from the free directory (names only, no scores)
 *   2. pays $0.001 in USDC on Hedera for each reputation lookup, via x402
 *   3. refuses anyone whose evidence fails its mandate
 *   4. hires the best remaining candidate
 *
 * Nothing here is scripted. The scores come from the Vouch API, which reads
 * Postgres, which the indexer filled from a Graph subgraph over real Sepolia
 * attestations. Change the evidence on-chain and this program changes its mind.
 *
 * Run: node --env-file=.env apps/agents/src/marketplace.ts
 */
import { wrapFetchWithPayment, x402Client, decodePaymentResponseHeader } from '@x402/fetch'
import { ExactHederaScheme } from '@x402/hedera/exact/client'
import { createClientHederaSigner } from '@x402/hedera'
import { PrivateKey } from '@hiero-ledger/sdk'
import type { Network } from '@x402/core/types'

const BASE = process.env.VOUCH_API_URL ?? 'http://localhost:3000'
const NETWORK = (process.env.X402_NETWORK ?? 'hedera:testnet') as Network
const ASSET = process.env.X402_ASSET ?? '0.0.429274'

/** The buyer's mandate. A hijacked agent cannot spend outside these bounds. */
const MANDATE = {
  minScore: 600,
  maxDisputeRateBps: 2000, // 20%
  minCounterparties: 3,
  maxPerLookup: '50000', // 0.05 USDC
}

const buyerId = process.env.HEDERA_BUYER_ACCOUNT_ID ?? process.env.HEDERA_ACCOUNT_ID!
const buyerKey = process.env.HEDERA_BUYER_PRIVATE_KEY ?? process.env.HEDERA_PRIVATE_KEY!

const signer = createClientHederaSigner(buyerId, PrivateKey.fromStringECDSA(buyerKey), { network: NETWORK })
const client = new x402Client()
  .register(NETWORK, new ExactHederaScheme(signer))
  .setSpendControls({
    maxAmountPerPayment: '$0.50',
    allowedAssets: [
      { network: NETWORK, asset: '0.0.429274', maxAmountPerPayment: MANDATE.maxPerLookup },
      { network: NETWORK, asset: '0.0.0', maxAmountPerPayment: '5000000' },
    ],
  })
const pay = wrapFetchWithPayment(fetch, client)

type ScoreResponse = {
  name: string; score: number; verdict: string
  components: Record<string, number>
  evidence: {
    totalJobs: number; disputedJobs: number; failedJobs: number
    uniqueCounterparties: number; disputeRateBps: number
  }
}

const money = (units: string) =>
  ASSET === '0.0.0' ? `${Number(units) / 1e8} HBAR` : `$${(Number(units) / 1e6).toFixed(4)}`

let spent = 0
const line = (s = '') => console.log(s)

line('\n══════════════════════════════════════════════════════════════')
line('  BUYER AGENT  ' + buyerId)
line('  mandate: score >= ' + MANDATE.minScore + ', disputes <= ' +
     MANDATE.maxDisputeRateBps / 100 + '%, >= ' + MANDATE.minCounterparties + ' counterparties')
line('══════════════════════════════════════════════════════════════\n')

// ---- 1. discovery: free, and deliberately score-free ----
line('▸ discovering candidates (free directory)')
const dir = (await (await fetch(`${BASE}/v1/agents`)).json()) as {
  agents: { name: string; verdict: string; totalJobs: number }[]
}
const candidates = dir.agents.filter((a) => a.name)
for (const c of candidates) line(`    found  ${c.name}`)
line(`  the directory does not expose scores. that is the product.\n`)

// ---- 2. pay for evidence on each ----
const assessed: { name: string; data: ScoreResponse; tx?: string }[] = []

for (const c of candidates) {
  process.stdout.write(`▸ ${c.name.padEnd(24)} paying for evidence ... `)
  const res = await pay(`${BASE}/v1/agents/${c.name}/score`)
  if (!res.ok) { line(`HTTP ${res.status}`); continue }

  const data = (await res.json()) as ScoreResponse
  const header = res.headers.get('payment-response')
  const settlement = header ? decodePaymentResponseHeader(header) : null
  spent += Number(ASSET === '0.0.0' ? '100000' : '1000')

  line(`paid ${money(ASSET === '0.0.0' ? '100000' : '1000')}`)
  if (settlement?.transaction) {
    const scan = settlement.transaction.replace('@', '-').replace(/\.(\d{9})$/, '-$1')
    line(`    settled  https://hashscan.io/testnet/transaction/${scan}`)
  }
  line(`    score    ${data.score}  (${data.verdict})`)
  line(`    evidence ${data.evidence.totalJobs} jobs · ${data.evidence.disputedJobs} disputed · ` +
       `${data.evidence.failedJobs} failed · ${data.evidence.uniqueCounterparties} counterparties · ` +
       `${(data.evidence.disputeRateBps / 100).toFixed(1)}% dispute rate`)
  assessed.push({ name: c.name, data, tx: settlement?.transaction })
  line()
}

// ---- 3. apply the mandate ----
line('▸ applying mandate\n')
const passed: typeof assessed = []
for (const a of assessed) {
  const reasons: string[] = []
  if (a.data.score < MANDATE.minScore) reasons.push(`score ${a.data.score} < ${MANDATE.minScore}`)
  if (a.data.evidence.disputeRateBps > MANDATE.maxDisputeRateBps) {
    reasons.push(`dispute rate ${(a.data.evidence.disputeRateBps / 100).toFixed(1)}% > ${MANDATE.maxDisputeRateBps / 100}%`)
  }
  if (a.data.evidence.uniqueCounterparties < MANDATE.minCounterparties) {
    reasons.push(`only ${a.data.evidence.uniqueCounterparties} counterparties`)
  }
  if (reasons.length) line(`    ✗ REFUSE  ${a.name.padEnd(24)} ${reasons.join('; ')}`)
  else { line(`    ✓ ELIGIBLE ${a.name.padEnd(23)} score ${a.data.score}`); passed.push(a) }
}

// ---- 4. hire ----
line()
if (!passed.length) {
  line('▸ no candidate met the mandate. hiring nobody.\n')
  process.exit(0)
}
passed.sort((x, y) => y.data.score - x.data.score)
const hired = passed[0]!

line('══════════════════════════════════════════════════════════════')
line(`  HIRED  ${hired.name}`)
line(`  score  ${hired.data.score} (${hired.data.verdict})`)
line(`  spent  ${money(String(spent))} across ${assessed.length} reputation lookups`)
line(`  decided with no human in the loop`)
line('══════════════════════════════════════════════════════════════\n')
