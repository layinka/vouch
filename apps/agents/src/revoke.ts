/**
 * DEMO MOMENT C, tail — the owner revokes an agent's identity.
 *
 * A score can fall. Revocation is the harder stop: the human owner calls
 * unregister() on our ENSv2 subname registry and the name ceases to exist.
 * Resolution fails, the subgraph marks the registration inactive, and the agent
 * has no identity to present.
 *
 * This is what a name being a CREDENTIAL rather than property actually buys you,
 * and it is only possible because the registrar kept ROLE_UNREGISTER.
 *
 * Run: node --env-file=.env apps/agents/src/revoke.ts <agentLabel> [--confirm]
 */
import { readFileSync } from 'node:fs'
import { createPublicClient, createWalletClient, http, type Hex, type Abi } from 'viem'
import { privateKeyToAccount } from 'viem/accounts'
import { sepolia } from 'viem/chains'

const RPC = process.env.SEPOLIA_RPC_URL ?? 'https://ethereum-sepolia-rpc.publicnode.com'
const LABEL = process.argv[2]
const CONFIRM = process.argv.includes('--confirm')

if (!LABEL) {
  console.error('\n  usage: revoke.ts <agentLabel> [--confirm]\n')
  process.exit(1)
}

const dep = JSON.parse(readFileSync('deployments/sepolia.json', 'utf8')) as {
  userRegistry: Hex
  agents: Record<string, { name: string; tokenId: string; resolver: Hex; node: Hex }>
}
const registryAbi = JSON.parse(readFileSync('packages/contracts/abis/UserRegistryImpl.json', 'utf8')) as Abi
const resolverAbi = JSON.parse(readFileSync('packages/contracts/abis/PermissionedResolverImpl.json', 'utf8')) as Abi

const agent = dep.agents[LABEL]
if (!agent) throw new Error(`unknown agent "${LABEL}"`)

const owner = privateKeyToAccount(process.env.DEPLOYER_PRIVATE_KEY as Hex)
const pub = createPublicClient({ chain: sepolia, transport: http(RPC) })
const wallet = createWalletClient({ account: owner, chain: sepolia, transport: http(RPC) })

const tokenId = BigInt(agent.tokenId)

console.log(`\n=== Revoke ${agent.name} ===\n`)

// ---- before ----
const before = {
  owner: await pub.readContract({
    address: dep.userRegistry, abi: registryAbi, functionName: 'getOwner', args: [tokenId],
  }).catch(() => null),
  subregistry: await pub.readContract({
    address: dep.userRegistry, abi: registryAbi, functionName: 'getSubregistry', args: [LABEL],
  }).catch(() => null),
  resolver: await pub.readContract({
    address: dep.userRegistry, abi: registryAbi, functionName: 'getResolver', args: [LABEL],
  }).catch(() => null),
  score: await pub.readContract({
    address: agent.resolver, abi: resolverAbi, functionName: 'text', args: [agent.node, 'agent:score'],
  }).catch(() => null),
}

console.log('  BEFORE')
console.log(`    owner       ${before.owner}`)
console.log(`    resolver    ${before.resolver}`)
console.log(`    agent:score ${before.score}`)

if (!CONFIRM) {
  console.log('\n  dry run. re-run with --confirm to actually revoke.\n')
  process.exit(0)
}

// ---- revoke ----
console.log('\n  ..    owner calls unregister()')
const { request } = await pub.simulateContract({
  account: owner, address: dep.userRegistry, abi: registryAbi,
  functionName: 'unregister', args: [tokenId],
})
const hash = await wallet.writeContract(request)
console.log(`        https://sepolia.etherscan.io/tx/${hash}`)
await pub.waitForTransactionReceipt({ hash })
console.log('  ok    revoked')

// ---- after ----
const after = {
  resolver: await pub.readContract({
    address: dep.userRegistry, abi: registryAbi, functionName: 'getResolver', args: [LABEL],
  }).catch(() => 'REVERTED'),
  owner: await pub.readContract({
    address: dep.userRegistry, abi: registryAbi, functionName: 'getOwner', args: [tokenId],
  }).catch(() => 'REVERTED'),
}

console.log('\n  AFTER')
console.log(`    owner       ${after.owner}`)
console.log(`    resolver    ${after.resolver}`)

const gone =
  after.resolver === 'REVERTED' ||
  after.resolver === '0x0000000000000000000000000000000000000000' ||
  after.owner === '0x0000000000000000000000000000000000000000'

console.log(`\n  ${gone ? 'GATE PASSED — the name no longer resolves.' : 'name still resolves; check ROLE_UNREGISTER'}`)
console.log(`\n  Note: the PermissionedResolver still holds the old records, but the`)
console.log(`  registry no longer points at it, so ${agent.name} resolves to nothing.\n`)
