/**
 * Seeds realistic job history into VouchAttestations.
 *
 * The subgraph needs evidence to index and the marketplace demo needs agents that
 * genuinely differ — `trader` has to EARN its 40% dispute rate, not be handed it.
 *
 * Counterparties are derived deterministically from the deployer key
 * (keccak(deployerKey ‖ "vouch-counterparty" ‖ i)), so re-running produces the
 * same five addresses and no private keys ever need storing or committing.
 *
 * They must be separate accounts: VouchAttestations.attest() reverts when the
 * caller owns the agent's ERC-8004 token, and the deployer owns all four agents.
 * Counterparty diversity is also a scoring input, so five distinct raters is the
 * honest shape, not a shortcut.
 *
 * Idempotent — attest() reverts on a repeated (agent, attestor, jobRef), and we
 * skip anything already recorded.
 *
 * Run: node --env-file=.env spike/13-seed-attestations.ts
 */
import { readFileSync, writeFileSync } from 'node:fs'
import {
  createPublicClient, createWalletClient, http, keccak256, encodePacked,
  parseEther, formatEther, toHex, type Hex, type Abi,
} from 'viem'
import { privateKeyToAccount } from 'viem/accounts'
import { sepolia } from 'viem/chains'

const RPC = process.env.SEPOLIA_RPC_URL ?? 'https://ethereum-sepolia-rpc.publicnode.com'
const ABIS = 'packages/contracts/abis'
const OUT = 'deployments/sepolia.json'
const GAS_PER_COUNTERPARTY = parseEther('0.012')

const Outcome = { Ok: 0, Disputed: 1, Failed: 2 } as const

type Agent = { label: string; name: string; erc8004Id?: string }
type Deployment = {
  agents: Record<string, Agent>
  vouchAttestations?: Hex
  counterparties?: Hex[]
  seeded?: boolean
}
const state: Deployment = JSON.parse(readFileSync(OUT, 'utf8'))
const save = () => writeFileSync(OUT, JSON.stringify(state, null, 2) + '\n')
if (!state.vouchAttestations) throw new Error('VouchAttestations not deployed — run spike/12-deploy-vouch.ts')

const attAbi = JSON.parse(readFileSync(`${ABIS}/VouchAttestations.json`, 'utf8')) as Abi
const deployerKey = process.env.DEPLOYER_PRIVATE_KEY as Hex
const deployer = privateKeyToAccount(deployerKey)

const pub = createPublicClient({ chain: sepolia, transport: http(RPC) })
const wDeployer = createWalletClient({ account: deployer, chain: sepolia, transport: http(RPC) })

// ---- deterministic counterparties ----
const N_COUNTERPARTIES = 5
const counterparties = Array.from({ length: N_COUNTERPARTIES }, (_, i) =>
  privateKeyToAccount(keccak256(encodePacked(['bytes32', 'string', 'uint8'], [deployerKey, 'vouch-counterparty', i]))),
)
state.counterparties = counterparties.map((c) => c.address)
save()

/**
 * The histories. Designed so the marketplace demo has a real decision to make:
 * two credible candidates and one that any sane buyer refuses.
 *
 * jobs = [outcome, valueEth, counterpartyIndex]
 */
const HISTORY: Record<string, { jobs: [number, string, number][]; note: string }> = {
  researcher: {
    note: 'strong: high volume, wide counterparty spread, 2 disputes in 15',
    jobs: [
      [Outcome.Ok, '0.8', 0], [Outcome.Ok, '1.2', 1], [Outcome.Ok, '0.4', 2],
      [Outcome.Ok, '2.1', 3], [Outcome.Ok, '0.9', 4], [Outcome.Ok, '1.5', 0],
      [Outcome.Ok, '0.6', 1], [Outcome.Disputed, '0.3', 2], [Outcome.Ok, '1.1', 3],
      [Outcome.Ok, '0.7', 4], [Outcome.Ok, '1.8', 0], [Outcome.Ok, '0.5', 2],
      [Outcome.Disputed, '0.2', 3], [Outcome.Ok, '1.3', 4], [Outcome.Ok, '0.9', 1],
    ],
  },
  pricefeed: {
    note: 'middling: decent volume but a visible failure rate',
    jobs: [
      [Outcome.Ok, '0.4', 0], [Outcome.Ok, '0.3', 1], [Outcome.Disputed, '0.2', 2],
      [Outcome.Ok, '0.5', 3], [Outcome.Failed, '0.1', 4], [Outcome.Ok, '0.6', 0],
      [Outcome.Ok, '0.3', 1], [Outcome.Disputed, '0.4', 2], [Outcome.Ok, '0.2', 3],
      [Outcome.Ok, '0.5', 4],
    ],
  },
  trader: {
    note: 'the one the buyer must refuse: 4 disputes + 2 failures in 10',
    jobs: [
      [Outcome.Disputed, '1.0', 0], [Outcome.Ok, '0.5', 1], [Outcome.Disputed, '0.8', 2],
      [Outcome.Failed, '1.2', 0], [Outcome.Disputed, '0.6', 1], [Outcome.Ok, '0.4', 2],
      [Outcome.Failed, '0.9', 0], [Outcome.Disputed, '0.7', 1], [Outcome.Ok, '0.3', 2],
      [Outcome.Ok, '0.5', 0],
    ],
  },
  analyst: {
    note: 'the demo headliner: strong and clean, so it can visibly FALL on camera',
    jobs: [
      [Outcome.Ok, '1.4', 0], [Outcome.Ok, '2.2', 1], [Outcome.Ok, '0.9', 2],
      [Outcome.Ok, '1.8', 3], [Outcome.Ok, '1.1', 4], [Outcome.Ok, '2.6', 0],
      [Outcome.Ok, '0.7', 1], [Outcome.Ok, '1.5', 2], [Outcome.Ok, '1.9', 3],
      [Outcome.Ok, '1.2', 4], [Outcome.Ok, '0.8', 0], [Outcome.Ok, '2.1', 1],
      [Outcome.Ok, '1.6', 2], [Outcome.Disputed, '0.4', 3], [Outcome.Ok, '1.3', 4],
      [Outcome.Ok, '0.9', 0], [Outcome.Ok, '1.7', 2], [Outcome.Ok, '1.1', 3],
    ],
  },
  advisor: {
    note: 'replacement headliner: same strong shape, so the fall can be filmed again',
    jobs: [
      [Outcome.Ok, '1.5', 0], [Outcome.Ok, '2.3', 1], [Outcome.Ok, '1.0', 2],
      [Outcome.Ok, '1.9', 3], [Outcome.Ok, '1.2', 4], [Outcome.Ok, '2.4', 0],
      [Outcome.Ok, '0.8', 1], [Outcome.Ok, '1.6', 2], [Outcome.Ok, '2.0', 3],
      [Outcome.Ok, '1.3', 4], [Outcome.Ok, '0.9', 0], [Outcome.Ok, '2.2', 1],
      [Outcome.Ok, '1.7', 2], [Outcome.Disputed, '0.5', 3], [Outcome.Ok, '1.4', 4],
      [Outcome.Ok, '1.0', 0], [Outcome.Ok, '1.8', 2], [Outcome.Ok, '1.2', 3],
    ],
  },
  summarizer: {
    note: 'new and clean, but thin history — should score cautious, not trusted',
    jobs: [
      [Outcome.Ok, '0.2', 0], [Outcome.Ok, '0.3', 1], [Outcome.Ok, '0.1', 2],
      [Outcome.Ok, '0.2', 3],
    ],
  },
}

const ok = (m: string) => console.log(`  ok    ${m}`)

console.log('\n=== Seed attestation history ===\n')
console.log(`  VouchAttestations ${state.vouchAttestations}`)
console.log(`  counterparties    ${N_COUNTERPARTIES} (deterministic)\n`)

// ---- fund counterparties ----
for (const [i, cp] of counterparties.entries()) {
  const bal = await pub.getBalance({ address: cp.address })
  if (bal >= GAS_PER_COUNTERPARTY / 2n) {
    ok(`cp${i} ${cp.address} funded (${formatEther(bal)} ETH)`)
    continue
  }
  const hash = await wDeployer.sendTransaction({ to: cp.address, value: GAS_PER_COUNTERPARTY })
  await pub.waitForTransactionReceipt({ hash })
  ok(`cp${i} ${cp.address} funded with ${formatEther(GAS_PER_COUNTERPARTY)} ETH`)
}

// ---- attest ----
let written = 0
let skipped = 0

for (const [label, agent] of Object.entries(state.agents)) {
  const plan = HISTORY[label]
  if (!plan) continue
  const agentId = BigInt(agent.erc8004Id!)
  console.log(`\n--- ${agent.name} (agentId ${agentId}) ---`)
  console.log(`    ${plan.note}`)

  for (const [idx, [outcome, valueEth, cpIndex]] of plan.jobs.entries()) {
    const cp = counterparties[cpIndex]!
    const jobRef = keccak256(toHex(`${label}:job:${idx}`))

    const [found] = (await pub.readContract({
      address: state.vouchAttestations!, abi: attAbi,
      functionName: 'outcomeOf', args: [agentId, cp.address, jobRef],
    })) as [boolean, number]
    if (found) { skipped++; continue }

    const wallet = createWalletClient({ account: cp, chain: sepolia, transport: http(RPC) })
    const { request } = await pub.simulateContract({
      account: cp, address: state.vouchAttestations!, abi: attAbi,
      functionName: 'attest',
      args: [agentId, jobRef, outcome, parseEther(valueEth)],
    })
    const hash = await wallet.writeContract(request)
    await pub.waitForTransactionReceipt({ hash })
    written++
    const name = ['Ok', 'Disputed', 'Failed'][outcome]
    process.stdout.write(`    job ${String(idx).padStart(2)} ${name!.padEnd(8)} ${valueEth.padStart(4)} ETH  cp${cpIndex}\n`)
  }
}

// ---- prove the self-attestation guard actually bites ----
console.log('\n--- guard check: deployer owns these agents, so it must NOT be able to attest ---')
const researcher = state.agents.researcher!
try {
  await pub.simulateContract({
    account: deployer, address: state.vouchAttestations!, abi: attAbi,
    functionName: 'attest',
    args: [BigInt(researcher.erc8004Id!), keccak256(toHex('self:cheat')), Outcome.Ok, parseEther('99')],
  })
  console.log('  *** FAIL: an agent owner was allowed to rate its own agent ***')
} catch (err) {
  const m = (err as Error).message
  ok('REVERTED — owner cannot attest about its own agent')
  if (m.includes('SelfAttestationForbidden')) ok('error is SelfAttestationForbidden, as designed')
}

state.seeded = true
save()
console.log(`\n  ${written} attestations written, ${skipped} already present`)
console.log(`  contract  https://sepolia.etherscan.io/address/${state.vouchAttestations}\n`)
