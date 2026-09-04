/**
 * Day-1/2 gate — mint an agent identity and PROVE the permission split.
 *
 * This is demo moment A, the beat the whole ENS submission rests on:
 *
 *   the agent controls what it CLAIMS.  it cannot touch what it has DONE.
 *
 * Sequence:
 *   1. deploy a PermissionedResolver proxy for this agent (VerifiableFactory)
 *   2. register <agent>.vouch.eth in OUR registry, deliberately WITHOUT
 *      ROLE_CAN_TRANSFER_ADMIN, so the identity is non-transferable
 *   3. authorize the AGENT key for agent:endpoint + agent:capabilities ONLY
 *   4. authorize the SCORER key for agent:score + agent:disputes + agent:volume ONLY
 *   5. AGENT writes agent:endpoint   -> SUCCEEDS
 *   6. AGENT writes agent:score      -> MUST REVERT (EACUnauthorizedAccountRoles)
 *   7. SCORER writes agent:score     -> SUCCEEDS
 *
 * Step 6 failing is the pass condition. If it succeeds, the product does not exist.
 *
 * Run: node --env-file=.env spike/10-agent-identity.ts [agentLabel]
 */
import { readFileSync, writeFileSync, existsSync } from 'node:fs'
import {
  createPublicClient, createWalletClient, http, encodeFunctionData, namehash,
  toHex, decodeEventLog, zeroAddress, type Hex,
} from 'viem'
import { packetToBytes } from 'viem/ens'
import { privateKeyToAccount } from 'viem/accounts'
import { sepolia } from 'viem/chains'

const RPC = process.env.SEPOLIA_RPC_URL ?? 'https://ethereum-sepolia-rpc.publicnode.com'
const DIR = 'packages/contracts/abis'
const OUT = 'deployments/sepolia.json'
const AGENT_LABEL = process.argv[2] ?? 'researcher'

// ---- PermissionedResolver roles (docs.ens.domains/ensv2/permissioned-resolver) ----
const R_SET_ADDR = 1n << 0n
const R_SET_TEXT = 1n << 4n
const R_SET_ALIAS = 1n << 28n
const R_CLEAR = 1n << 32n
const R_UPGRADE = 1n << 124n
const admin = (r: bigint) => r << 128n
const RESOLVER_ROOT = (() => {
  const all = R_SET_ADDR | R_SET_TEXT | R_SET_ALIAS | R_CLEAR | R_UPGRADE
  return all | admin(all)
})()

// ---- Registry roles ----
const REG_ROLE_SET_SUBREGISTRY = 1n << 20n
const REG_ROLE_SET_RESOLVER = 1n << 24n
// NOTE: ROLE_CAN_TRANSFER_ADMIN = (1 << 28) << 128 is DELIBERATELY OMITTED.
// Withholding it is what makes the identity non-transferable — there is no
// separate soulbound flag in ENSv2, you simply never grant the transfer role.
const AGENT_OWNER_ROLES = (() => {
  const base = REG_ROLE_SET_RESOLVER | REG_ROLE_SET_SUBREGISTRY
  return base | admin(base)
})()

// Records the AGENT may write (its claims) vs the SCORER (the evidence).
const AGENT_KEYS = ['agent:endpoint', 'agent:capabilities', 'agent:price'] as const
const SCORER_KEYS = ['agent:score', 'agent:disputes', 'agent:volume'] as const

const A = JSON.parse(readFileSync(`${DIR}/_addresses.json`, 'utf8')) as { ensv2: Record<string, Hex> }
const abiOf = (n: string) => JSON.parse(readFileSync(`${DIR}/${n}.json`, 'utf8'))
const resolverAbi = abiOf('PermissionedResolverImpl')
const registryAbi = abiOf('UserRegistryImpl')

type Agent = { label: string; name: string; resolver: Hex; tokenId: string; node: Hex }
type Deployment = { parentName?: string; userRegistry?: Hex; agents?: Record<string, Agent> }
if (!existsSync(OUT)) throw new Error('deployments/sepolia.json missing — run spike/09-deploy-parent.ts first')
const state: Deployment = JSON.parse(readFileSync(OUT, 'utf8'))
if (!state.userRegistry || !state.parentName) throw new Error('parent not deployed yet')
const save = () => writeFileSync(OUT, JSON.stringify(state, null, 2) + '\n')
state.agents ??= {}

const pub = createPublicClient({ chain: sepolia, transport: http(RPC) })
const w = (k: string) =>
  createWalletClient({ account: privateKeyToAccount(process.env[k] as Hex), chain: sepolia, transport: http(RPC) })

const deployer = privateKeyToAccount(process.env.DEPLOYER_PRIVATE_KEY as Hex)
const scorer = privateKeyToAccount(process.env.SCORER_PRIVATE_KEY as Hex)
const agent = privateKeyToAccount(process.env.AGENT_PRIVATE_KEY as Hex)
const wDeployer = w('DEPLOYER_PRIVATE_KEY')
const wScorer = w('SCORER_PRIVATE_KEY')
const wAgent = w('AGENT_PRIVATE_KEY')

const FULL = `${AGENT_LABEL}.${state.parentName}`
const node = namehash(FULL)
const dnsName = toHex(packetToBytes(FULL))

const ok = (m: string) => console.log(`  ok    ${m}`)
const step = (m: string) => console.log(`\n  ..    ${m}`)
const link = (h: Hex) => console.log(`        https://sepolia.etherscan.io/tx/${h}`)

console.log('\n=== Vouch: mint agent identity + prove the permission split ===\n')
console.log(`  name      ${FULL}`)
console.log(`  node      ${node}`)
console.log(`  dnsName   ${dnsName}`)
console.log(`  registry  ${state.userRegistry}`)
console.log(`  DEPLOYER  ${deployer.address}`)
console.log(`  SCORER    ${scorer.address}`)
console.log(`  AGENT     ${agent.address}`)

const send = async (client: ReturnType<typeof w>, req: unknown, label: string) => {
  const h = await client.writeContract(req as never)
  link(h)
  const r = await pub.waitForTransactionReceipt({ hash: h })
  ok(`${label} (${r.status})`)
  return h
}

let rec = state.agents[AGENT_LABEL]

// ------------------------------------------------------- 1. resolver proxy
if (rec?.resolver) {
  ok(`resolver already deployed: ${rec.resolver}`)
} else {
  step('deploying a PermissionedResolver proxy for this agent')
  const initData = encodeFunctionData({
    abi: resolverAbi,
    functionName: 'initialize',
    args: [deployer.address, RESOLVER_ROOT, []],
  })
  const { request } = await pub.simulateContract({
    account: deployer,
    address: A.ensv2.VerifiableFactory,
    abi: abiOf('VerifiableFactory'),
    functionName: 'deployProxy',
    args: [A.ensv2.PermissionedResolverImpl, BigInt(Date.now()), initData],
  })
  const h = await wDeployer.writeContract(request)
  link(h)
  const receipt = await pub.waitForTransactionReceipt({ hash: h })
  let resolver: Hex | undefined
  for (const log of receipt.logs) {
    try {
      const ev = decodeEventLog({ abi: abiOf('VerifiableFactory'), ...log }) as {
        eventName: string; args: Record<string, unknown>
      }
      if (ev.eventName === 'ProxyDeployed') resolver = ev.args.proxyAddress as Hex
    } catch { /* not ours */ }
  }
  if (!resolver) throw new Error('ProxyDeployed not found')
  rec = { label: AGENT_LABEL, name: FULL, resolver, tokenId: '', node }
  state.agents[AGENT_LABEL] = rec
  save()
  ok(`resolver ${resolver}`)
}

// ------------------------------------------------------- 2. register subname
if (rec!.tokenId) {
  ok(`${FULL} already registered (tokenId ${rec!.tokenId})`)
} else {
  step(`registering ${FULL} — non-transferable, 1 year expiry`)
  const expiry = BigInt(Math.floor(Date.now() / 1000) + 31_536_000)
  const { request } = await pub.simulateContract({
    account: deployer,
    address: state.userRegistry,
    abi: registryAbi,
    functionName: 'register',
    args: [AGENT_LABEL, deployer.address, zeroAddress, rec!.resolver, AGENT_OWNER_ROLES, expiry],
  })
  const h = await wDeployer.writeContract(request)
  link(h)
  const receipt = await pub.waitForTransactionReceipt({ hash: h })
  for (const log of receipt.logs) {
    try {
      const ev = decodeEventLog({ abi: registryAbi, ...log }) as {
        eventName: string; args: Record<string, unknown>
      }
      if (ev.eventName === 'LabelRegistered') rec!.tokenId = String(ev.args.tokenId)
    } catch { /* not ours */ }
  }
  save()
  ok(`registered, tokenId ${rec!.tokenId}`)
  ok('ROLE_CAN_TRANSFER_ADMIN withheld -> non-transferable')
}

// ------------------------------------------------------- 3+4. the split
step('granting per-record permissions (this is the product)')
for (const k of AGENT_KEYS) {
  const { request } = await pub.simulateContract({
    account: deployer, address: rec!.resolver, abi: resolverAbi,
    functionName: 'authorizeTextRoles', args: [dnsName, k, agent.address, true],
  })
  await send(wDeployer, request, `AGENT  may write ${k}`)
}
for (const k of SCORER_KEYS) {
  const { request } = await pub.simulateContract({
    account: deployer, address: rec!.resolver, abi: resolverAbi,
    functionName: 'authorizeTextRoles', args: [dnsName, k, scorer.address, true],
  })
  await send(wDeployer, request, `SCORER may write ${k}`)
}

// ------------------------------------------------------- 5. agent writes its claim
step('AGENT writes agent:endpoint (its own claim) — expect SUCCESS')
{
  const { request } = await pub.simulateContract({
    account: agent, address: rec!.resolver, abi: resolverAbi,
    functionName: 'setText', args: [node, 'agent:endpoint', 'https://researcher.vouch.eth/x402'],
  })
  await send(wAgent, request, 'agent:endpoint written by AGENT')
}

// ------------------------------------------------------- 6. THE MOMENT
step('AGENT attempts agent:score (the evidence) — MUST REVERT')
let reverted = false
let revertMsg = ''
try {
  await pub.simulateContract({
    account: agent, address: rec!.resolver, abi: resolverAbi,
    functionName: 'setText', args: [node, 'agent:score', '999'],
  })
  console.log('\n  *** GATE FAILED: the agent was allowed to write its own score. ***')
  console.log('  *** Vouch has no product unless this reverts. ***\n')
} catch (err) {
  reverted = true
  const m = (err as Error).message
  revertMsg = m.split('\n').find((l) => l.includes('EACUnauthorized') || l.includes('reverted')) ?? m.split('\n')[0]!
  ok('REVERTED — the agent cannot write its own score')
  console.log(`        ${revertMsg.trim()}`)
  if (m.includes('EACUnauthorizedAccountRoles')) ok('error is EACUnauthorizedAccountRoles, exactly as designed')
}

// ------------------------------------------------------- 7. scorer writes it
step('SCORER writes agent:score — expect SUCCESS')
{
  const { request } = await pub.simulateContract({
    account: scorer, address: rec!.resolver, abi: resolverAbi,
    functionName: 'setText', args: [node, 'agent:score', '812'],
  })
  await send(wScorer, request, 'agent:score written by SCORER')
}

// ------------------------------------------------------- verify reads
step('reading records back from the resolver')
for (const k of [...AGENT_KEYS.slice(0, 1), ...SCORER_KEYS.slice(0, 1)]) {
  const v = await pub.readContract({ address: rec!.resolver, abi: resolverAbi, functionName: 'text', args: [node, k] })
  console.log(`        ${k.padEnd(20)} = ${JSON.stringify(v)}`)
}

console.log(`\n  ${reverted ? 'GATE PASSED — demo moment A is real and on-chain.' : 'GATE FAILED'}`)
console.log(`\n  resolver  https://sepolia.etherscan.io/address/${rec!.resolver}`)
console.log(`  name      ${FULL}\n`)
