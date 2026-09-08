/**
 * DEMO MOMENT C — the loop closes.
 *
 * A counterparty files a dispute against an agent that already has a good score.
 * Nothing else is touched. Then:
 *
 *   dispute on Sepolia -> subgraph reindexes -> indexer recomputes
 *   -> scorer writes the LOWER score to the agent's ENS record
 *   -> the buyer agent now refuses it
 *
 * The point on camera is that nobody edited a database. Evidence changed, and
 * everything downstream followed on its own.
 *
 * Run: node --env-file=.env apps/agents/src/dispute.ts [agentLabel] [count]
 */
import { readFileSync } from 'node:fs'
import { createPublicClient, createWalletClient, http, keccak256, encodePacked, toHex, type Hex, type Abi } from 'viem'
import { privateKeyToAccount } from 'viem/accounts'
import { sepolia } from 'viem/chains'

const RPC = process.env.SEPOLIA_RPC_URL ?? 'https://ethereum-sepolia-rpc.publicnode.com'
const LABEL = process.argv[2] ?? 'researcher'
const COUNT = Number(process.argv[3] ?? 4)

const dep = JSON.parse(readFileSync('deployments/sepolia.json', 'utf8')) as {
  vouchAttestations: Hex
  agents: Record<string, { name: string; erc8004Id?: string }>
}
const abi = JSON.parse(readFileSync('packages/contracts/abis/VouchAttestations.json', 'utf8')) as Abi

const agent = dep.agents[LABEL]
if (!agent?.erc8004Id) throw new Error(`unknown agent "${LABEL}"`)
const agentId = BigInt(agent.erc8004Id)

const deployerKey = process.env.DEPLOYER_PRIVATE_KEY as Hex
const pub = createPublicClient({ chain: sepolia, transport: http(RPC) })

/** Same derivation as the seeder, so we dispute jobs that actually exist. */
const counterparties = Array.from({ length: 5 }, (_, i) =>
  privateKeyToAccount(
    keccak256(encodePacked(['bytes32', 'string', 'uint8'], [deployerKey, 'vouch-counterparty', i])),
  ),
)

const REASONS = [
  'deliverable did not match the agreed spec',
  'response was truncated and never completed',
  'returned stale data outside the agreed window',
  'failed to respond within the paid SLA',
]

console.log(`\n=== Filing disputes against ${agent.name} ===\n`)

// Find Ok attestations we are entitled to dispute: only the original attestor
// may escalate their own attestation, so we have to match job to rater.
const candidates: { cpIndex: number; jobIndex: number; jobRef: Hex }[] = []
for (let jobIndex = 0; jobIndex < 20 && candidates.length < COUNT; jobIndex++) {
  const jobRef = keccak256(toHex(`${LABEL}:job:${jobIndex}`))
  for (let cpIndex = 0; cpIndex < counterparties.length; cpIndex++) {
    const [found, outcome] = (await pub.readContract({
      address: dep.vouchAttestations, abi,
      functionName: 'outcomeOf',
      args: [agentId, counterparties[cpIndex]!.address, jobRef],
    })) as [boolean, number]
    if (found && outcome === 0) {
      candidates.push({ cpIndex, jobIndex, jobRef })
      break
    }
  }
}

if (!candidates.length) {
  console.log('  no disputable Ok attestations left for this agent.\n')
  process.exit(0)
}

for (const [n, c] of candidates.entries()) {
  const cp = counterparties[c.cpIndex]!
  const reason = REASONS[n % REASONS.length]!
  const wallet = createWalletClient({ account: cp, chain: sepolia, transport: http(RPC) })

  const { request } = await pub.simulateContract({
    account: cp, address: dep.vouchAttestations, abi,
    functionName: 'dispute', args: [agentId, c.jobRef, reason],
  })
  const hash = await wallet.writeContract(request)
  await pub.waitForTransactionReceipt({ hash })
  console.log(`  disputed job ${c.jobIndex} by cp${c.cpIndex}`)
  console.log(`    "${reason}"`)
  console.log(`    https://sepolia.etherscan.io/tx/${hash}`)
}

console.log(`\n  ${candidates.length} disputes filed on Sepolia.`)
console.log('  Nothing else was touched. Now watch the rest happen by itself:\n')
console.log('    1. the subgraph reindexes           (~30s)')
console.log('    2. pnpm indexer:once                 recomputes and republishes')
console.log('    3. the score drops on the ENS record and in the UI')
console.log('    4. pnpm demo:marketplace             the buyer now refuses it\n')
