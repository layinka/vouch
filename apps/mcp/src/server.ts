/**
 * Vouch MCP server — reputation for AI agents, in any agent host.
 *
 * This is TOOLING, not an app: it makes Vouch's on-chain evidence usable from
 * Claude, Cursor, or anything else that speaks MCP, without those hosts knowing
 * anything about ENS, ERC-8004, The Graph or Hedera.
 *
 * Four tools:
 *   vouch_lookup              identity + score + verdict for one agent
 *   vouch_compare             rank several candidates against a mandate
 *   vouch_verify_permissions  who may write which record, and what reverts
 *   vouch_history             full attestation history  [x402-PAID]
 *
 * vouch_history pays for itself. When the resource server answers 402, the tool
 * settles in USDC on Hedera through Blocky402 and retries — so an MCP tool call
 * transacts autonomously, with no API key anywhere in the chain.
 *
 * stdio:  node --env-file=.env apps/mcp/src/server.ts
 * http:   node --env-file=.env apps/mcp/src/server.ts --http [--port 3010]
 */
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { z } from 'zod'
import { wrapFetchWithPayment, x402Client, decodePaymentResponseHeader } from '@x402/fetch'
import { ExactHederaScheme } from '@x402/hedera/exact/client'
import { createClientHederaSigner } from '@x402/hedera'
import { PrivateKey } from '@hiero-ledger/sdk'
import type { Network } from '@x402/core/types'

const API = process.env.VOUCH_API_URL ?? 'http://localhost:3000'
const NETWORK = (process.env.X402_NETWORK ?? 'hedera:testnet') as Network
const USDC = process.env.X402_ASSET ?? '0.0.429274'

// ---------------------------------------------------------------- paying fetch
// Only built when Hedera credentials exist, so the free tools still work in a
// host that has no wallet configured.
const buyerId = process.env.HEDERA_BUYER_ACCOUNT_ID ?? process.env.HEDERA_ACCOUNT_ID
const buyerKey = process.env.HEDERA_BUYER_PRIVATE_KEY ?? process.env.HEDERA_PRIVATE_KEY

const payingFetch = (() => {
  if (!buyerId || !buyerKey) return null
  const signer = createClientHederaSigner(buyerId, PrivateKey.fromStringECDSA(buyerKey), { network: NETWORK })
  const client = new x402Client()
    .register(NETWORK, new ExactHederaScheme(signer))
    // The spend mandate travels with the tool. A prompt-injected agent cannot
    // talk this client into paying an unexpected asset or blowing the cap.
    .setSpendControls({
      maxAmountPerPayment: '$0.10',
      allowedAssets: [
        { network: NETWORK, asset: USDC, maxAmountPerPayment: '50000' },
        { network: NETWORK, asset: '0.0.0', maxAmountPerPayment: '5000000' },
      ],
    })
  return wrapFetchWithPayment(fetch, client)
})()

const get = async (path: string) => {
  const res = await fetch(`${API}${path}`)
  if (!res.ok) throw new Error(`${res.status} ${await res.text()}`)
  return res.json() as Promise<Record<string, unknown>>
}

const text = (s: string) => ({ content: [{ type: 'text' as const, text: s }] })

const verdictLine = (v: string, score: number) => {
  const mark = v === 'trusted' ? 'TRUSTED' : v === 'caution' ? 'CAUTION' : 'AVOID'
  return `${mark} (${score}/1000)`
}

// ---------------------------------------------------------------- server
const server = new McpServer({ name: 'vouch', version: '0.1.0' })

server.registerTool(
  'vouch_lookup',
  {
    title: 'Look up an AI agent',
    description:
      'Identity and trust score for an AI agent registered with Vouch. The score is derived ' +
      'from on-chain evidence (settled jobs, counterparty feedback, disputes) indexed from ' +
      'Ethereum, NOT from anything the agent says about itself. Costs $0.001 in USDC on Hedera.',
    inputSchema: { name: z.string().describe('ENS name, e.g. researcher.vouch.eth') },
  },
  async ({ name }) => {
    const claims = await get(`/v1/agents/${encodeURIComponent(name)}`)

    if (!payingFetch) {
      return text(
        `${name}\n\nIdentity (free):\n${JSON.stringify(claims.identity, null, 2)}\n\n` +
          'No Hedera credentials configured, so the paid score was not fetched. ' +
          'Set HEDERA_BUYER_ACCOUNT_ID and HEDERA_BUYER_PRIVATE_KEY to enable it.',
      )
    }

    const res = await payingFetch(`${API}/v1/agents/${encodeURIComponent(name)}/score`)
    if (!res.ok) return text(`Could not buy the score for ${name}: HTTP ${res.status}`)
    const s = (await res.json()) as {
      score: number; verdict: string
      components: Record<string, number>
      evidence: Record<string, number | string>
      published: { anchorTx?: string; ensTx?: string }
    }
    const header = res.headers.get('payment-response')
    const settlement = header ? decodePaymentResponseHeader(header) : null

    const id = claims.identity as Record<string, string>
    return text(
      [
        `${name} — ${verdictLine(s.verdict, s.score)}`,
        '',
        'Evidence (indexed from Ethereum Sepolia, not self-reported):',
        `  jobs                  ${s.evidence.totalJobs}`,
        `  disputed              ${s.evidence.disputedJobs}`,
        `  failed                ${s.evidence.failedJobs}`,
        `  distinct counterparties ${s.evidence.uniqueCounterparties}`,
        `  dispute rate          ${(Number(s.evidence.disputeRateBps) / 100).toFixed(1)}%`,
        '',
        'Score components (they sum to the score):',
        ...Object.entries(s.components).map(([k, v]) => `  ${k.padEnd(12)} ${v}`),
        '',
        'Identity:',
        `  ERC-8004  ${id.erc8004Id}`,
        `  UAID      ${id.uaid}`,
        `  resolver  ${id.resolver}`,
        '',
        settlement?.transaction
          ? `Paid $0.001 USDC on Hedera. Settlement: ${settlement.transaction}`
          : 'Paid via x402 on Hedera.',
        s.published?.ensTx ? `Score published on-chain: ${s.published.ensTx}` : '',
      ].join('\n'),
    )
  },
)

server.registerTool(
  'vouch_compare',
  {
    title: 'Compare AI agents',
    description:
      'Rank candidate agents by trust score and apply a hiring mandate. Use this before ' +
      'delegating paid work to another agent. Buys one reputation lookup per candidate.',
    inputSchema: {
      names: z.array(z.string()).min(2).describe('ENS names to compare'),
      minScore: z.number().optional().describe('reject below this score (0-1000)'),
      maxDisputeRateBps: z.number().optional().describe('reject above this dispute rate, in basis points'),
    },
  },
  async ({ names, minScore = 600, maxDisputeRateBps = 2000 }) => {
    if (!payingFetch) return text('Hedera credentials required to buy reputation lookups.')

    const rows: string[] = []
    const eligible: { name: string; score: number }[] = []

    for (const name of names) {
      const res = await payingFetch(`${API}/v1/agents/${encodeURIComponent(name)}/score`)
      if (!res.ok) { rows.push(`  ${name.padEnd(24)} lookup failed (HTTP ${res.status})`); continue }
      const s = (await res.json()) as {
        score: number; verdict: string; evidence: { disputeRateBps: number; uniqueCounterparties: number }
      }
      const reasons: string[] = []
      if (s.score < minScore) reasons.push(`score ${s.score} < ${minScore}`)
      if (s.evidence.disputeRateBps > maxDisputeRateBps) {
        reasons.push(`disputes ${(s.evidence.disputeRateBps / 100).toFixed(1)}% > ${maxDisputeRateBps / 100}%`)
      }
      if (reasons.length) {
        rows.push(`  REJECT  ${name.padEnd(24)} ${reasons.join('; ')}`)
      } else {
        rows.push(`  PASS    ${name.padEnd(24)} ${verdictLine(s.verdict, s.score)}`)
        eligible.push({ name, score: s.score })
      }
    }

    eligible.sort((a, b) => b.score - a.score)
    return text(
      [
        `Mandate: score >= ${minScore}, dispute rate <= ${maxDisputeRateBps / 100}%`,
        '',
        ...rows,
        '',
        eligible.length
          ? `Recommended: ${eligible[0]!.name} (${eligible[0]!.score})`
          : 'No candidate met the mandate. Do not delegate.',
        '',
        `Paid $${(names.length * 0.001).toFixed(3)} USDC on Hedera for ${names.length} lookups.`,
      ].join('\n'),
    )
  },
)

server.registerTool(
  'vouch_verify_permissions',
  {
    title: 'Verify who can write an agent record',
    description:
      'Show which key is authorised to write each ENS text record for an agent, and what ' +
      'happens when the agent tries to write a record it does not control. Free.',
    inputSchema: { name: z.string() },
  },
  async ({ name }) => {
    const p = (await get(`/v1/agents/${encodeURIComponent(name)}/permissions`)) as {
      resolver: string
      records: { key: string; writer: string; canAgentWrite: boolean }[]
      enforcedBy: string
      revertsWith: string
    }
    return text(
      [
        `${name} — record permissions`,
        `resolver ${p.resolver}`,
        '',
        ...p.records.map(
          (r) => `  ${r.canAgentWrite ? 'agent  CAN write ' : 'agent  CANNOT write'}  ${r.key.padEnd(20)} (owner: ${r.writer})`,
        ),
        '',
        `Enforced by: ${p.enforcedBy}`,
        `Unauthorised writes revert with: ${p.revertsWith}`,
        '',
        'The agent controls what it claims. It cannot write what it has done.',
      ].join('\n'),
    )
  },
)

server.registerTool(
  'vouch_history',
  {
    title: 'Full attestation history for an agent',
    description:
      'Every job outcome recorded against an agent, with the counterparty that reported it ' +
      'and the Ethereum transaction. Costs $0.005 in USDC on Hedera.',
    inputSchema: { name: z.string(), limit: z.number().optional() },
  },
  async ({ name, limit = 25 }) => {
    if (!payingFetch) return text('Hedera credentials required to buy history.')
    const res = await payingFetch(`${API}/v1/agents/${encodeURIComponent(name)}/history`)
    if (!res.ok) return text(`Could not buy history: HTTP ${res.status}`)
    const h = (await res.json()) as {
      attestations: { attestor: string; outcome: string; value: string; timestamp: number; txHash: string; disputeReason?: string }[]
    }
    const rows = h.attestations.slice(0, limit).map((a) => {
      const when = new Date(a.timestamp * 1000).toISOString().slice(0, 16).replace('T', ' ')
      const eth = (Number(BigInt(a.value) / 10n ** 15n) / 1000).toFixed(3)
      return `  ${when}  ${a.outcome.padEnd(9)} ${eth.padStart(7)} ETH  by ${a.attestor.slice(0, 10)}…` +
        (a.disputeReason ? `\n      "${a.disputeReason}"` : '')
    })
    return text([`${name} — ${h.attestations.length} attestations`, '', ...rows,
                 '', 'Paid $0.005 USDC on Hedera.'].join('\n'))
  },
)

// ---------------------------------------------------------------- transports
if (process.argv.includes('--http')) {
  const { StreamableHTTPServerTransport } = await import(
    '@modelcontextprotocol/sdk/server/streamableHttp.js'
  )
  const express = (await import('express')).default
  const port = Number(process.env.MCP_PORT ?? 3010)
  const app = express()
  app.use(express.json())
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined })
  await server.connect(transport)
  app.all('/mcp', (req, res) => void transport.handleRequest(req, res, req.body))
  app.listen(port, () => console.error(`vouch MCP (http) on :${port}/mcp — API ${API}`))
} else {
  await server.connect(new StdioServerTransport())
  console.error(`vouch MCP (stdio) ready — API ${API}, payments ${payingFetch ? 'enabled' : 'disabled'}`)
}
