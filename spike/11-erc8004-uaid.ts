/**
 * Registers each Vouch agent in the ERC-8004 IdentityRegistry and writes the
 * identity triple back onto its ENS name.
 *
 * The three identifiers, all pointing at each other:
 *
 *   researcher.vouch.eth              what a human types        (ENSv2, Sepolia)
 *   uaid:aid:<base58>;...             what an agent routes on   (HCS-14)
 *   ERC-8004 agentId (ERC-721)        what the evidence hangs off
 *
 * The UAID is derived per HCS-14 from six canonical fields, hashed SHA-384 and
 * base58-encoded. nativeId is the ENS namehash, which is known before ERC-8004
 * registration — so there is no circular dependency and the whole identity can be
 * written in one pass.
 *
 * Run: node --env-file=.env spike/11-erc8004-uaid.ts
 */
import { readFileSync, writeFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { createPublicClient, createWalletClient, http, decodeEventLog, toHex, type Hex } from 'viem'
import { privateKeyToAccount } from 'viem/accounts'
import { sepolia } from 'viem/chains'

const RPC = process.env.SEPOLIA_RPC_URL ?? 'https://ethereum-sepolia-rpc.publicnode.com'
const DIR = 'packages/contracts/abis'
const OUT = 'deployments/sepolia.json'
const CARD_BASE = process.env.VOUCH_CARD_BASE ?? 'https://vouch-agents.vercel.app/v1/agents'

const A = JSON.parse(readFileSync(`${DIR}/_addresses.json`, 'utf8')) as {
  ensv2: Record<string, Hex>
  erc8004: Record<string, Hex>
}
const abiOf = (n: string) => JSON.parse(readFileSync(`${DIR}/${n}.json`, 'utf8'))
const identityAbi = abiOf('IdentityRegistry')
const resolverAbi = abiOf('PermissionedResolverImpl')

type Agent = {
  label: string; name: string; resolver: Hex; tokenId: string; node: Hex
  erc8004Id?: string; uaid?: string; skills?: number[]
}
type Deployment = { parentName?: string; userRegistry?: Hex; agents: Record<string, Agent> }
const state: Deployment = JSON.parse(readFileSync(OUT, 'utf8'))
const save = () => writeFileSync(OUT, JSON.stringify(state, null, 2) + '\n')

const deployer = privateKeyToAccount(process.env.DEPLOYER_PRIVATE_KEY as Hex)
const pub = createPublicClient({ chain: sepolia, transport: http(RPC) })
const wallet = createWalletClient({ account: deployer, chain: sepolia, transport: http(RPC) })

// ---------------------------------------------------------------- base58
const B58 = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz'
function base58(bytes: Buffer): string {
  let n = 0n
  for (const b of bytes) n = n * 256n + BigInt(b)
  let out = ''
  while (n > 0n) {
    out = B58[Number(n % 58n)] + out
    n /= 58n
  }
  for (const b of bytes) {
    if (b !== 0) break
    out = '1' + out
  }
  return out
}

/**
 * HCS-14 AID: SHA-384 over the canonical six fields, base58-encoded.
 * Normalisation matters — lowercase registry/protocol, trim, sort skills
 * numerically and object keys lexicographically — or two nodes derive
 * different ids for the same agent.
 */
function deriveUaid(a: { name: string; version: string; nativeId: string; skills: number[] }) {
  const canonical = {
    name: a.name.trim(),
    nativeId: a.nativeId.trim(),
    protocol: 'x402',
    registry: 'vouch',
    skills: [...a.skills].sort((x, y) => x - y),
    version: a.version.trim(),
  }
  const json = JSON.stringify(canonical, Object.keys(canonical).sort())
  const hash = createHash('sha384').update(json, 'utf8').digest()
  const aid = base58(hash)
  return {
    uaid: `uaid:aid:${aid};uid=0;registry=vouch;proto=x402;nativeId=${canonical.nativeId}`,
    canonical: json,
  }
}

// Distinct skill sets so the agents are not clones — the subgraph and the
// marketplace demo both need them to look like different businesses.
const SKILLS: Record<string, number[]> = {
  researcher: [1, 4, 7],
  pricefeed: [2, 5],
  trader: [3, 5, 9],
  summarizer: [1, 8],
  analyst: [1, 4, 6, 7],
  advisor: [2, 4, 6, 8],
}

const ok = (m: string) => console.log(`  ok    ${m}`)
const link = (h: Hex) => console.log(`        https://sepolia.etherscan.io/tx/${h}`)

console.log('\n=== ERC-8004 registration + HCS-14 UAID ===\n')
console.log(`  IdentityRegistry ${A.erc8004.IdentityRegistry}\n`)

for (const [label, agent] of Object.entries(state.agents)) {
  console.log(`--- ${agent.name} ---`)
  const skills = SKILLS[label] ?? [1]
  agent.skills = skills

  // ---- 1. ERC-8004 identity (ERC-721) ----
  if (agent.erc8004Id) {
    ok(`already registered, agentId ${agent.erc8004Id}`)
  } else {
    const tokenURI = `${CARD_BASE}/${agent.name}/card.json`
    const metadata = [
      { key: 'ens', value: toHex(agent.name) },
      { key: 'node', value: agent.node },
    ]
    const { request } = await pub.simulateContract({
      account: deployer,
      address: A.erc8004.IdentityRegistry,
      abi: identityAbi,
      functionName: 'register',
      args: [tokenURI, metadata],
    })
    const h = await wallet.writeContract(request)
    link(h)
    const receipt = await pub.waitForTransactionReceipt({ hash: h })
    for (const log of receipt.logs) {
      try {
        const ev = decodeEventLog({ abi: identityAbi, ...log }) as {
          eventName: string; args: Record<string, unknown>
        }
        if (ev.eventName === 'Registered') agent.erc8004Id = String(ev.args.agentId)
      } catch { /* not ours */ }
    }
    if (!agent.erc8004Id) throw new Error('Registered event not found')
    save()
    ok(`agentId ${agent.erc8004Id}`)
  }

  // ---- 2. HCS-14 UAID ----
  const { uaid, canonical } = deriveUaid({
    name: agent.name,
    version: '1',
    // the ENS namehash is this agent's native identifier in our system
    nativeId: `eip155:11155111:${agent.node}`,
    skills,
  })
  agent.uaid = uaid
  save()
  console.log(`        canonical ${canonical}`)
  ok(`uaid ${uaid.slice(0, 72)}...`)

  // ---- 3. write the triple onto the name ----
  // DEPLOYER holds root ROLE_SET_TEXT on this resolver, so it may write any key.
  // That is correct and is not a hole in the model: the registrar is root, the
  // AGENT is not — which is exactly what demo moment A demonstrates.
  // Also mirror the UAID into ERC-8004 metadata so the SUBGRAPH indexes it.
  // The ENS text record is the canonical home, but the subgraph reads ERC-8004
  // events, so without this the uaid field comes back null in queries.
  const existingUaid = (await pub.readContract({
    address: A.erc8004.IdentityRegistry, abi: identityAbi,
    functionName: 'getMetadata', args: [BigInt(agent.erc8004Id!), 'uaid'],
  })) as Hex
  if (existingUaid !== toHex(uaid)) {
    const { request } = await pub.simulateContract({
      account: deployer, address: A.erc8004.IdentityRegistry, abi: identityAbi,
      functionName: 'setMetadata', args: [BigInt(agent.erc8004Id!), 'uaid', toHex(uaid)],
    })
    const h = await wallet.writeContract(request)
    link(h)
    await pub.waitForTransactionReceipt({ hash: h })
    ok('uaid mirrored into ERC-8004 metadata (indexable)')
  } else {
    ok('uaid already in ERC-8004 metadata')
  }

  const records: [string, string][] = [
    ['agent:uaid', uaid],
    ['agent:erc8004', agent.erc8004Id!],
    ['agent:skills', JSON.stringify(skills)],
  ]
  for (const [key, value] of records) {
    const current = (await pub.readContract({
      address: agent.resolver, abi: resolverAbi, functionName: 'text', args: [agent.node, key],
    })) as string
    if (current === value) {
      ok(`${key} already set`)
      continue
    }
    const { request } = await pub.simulateContract({
      account: deployer, address: agent.resolver, abi: resolverAbi,
      functionName: 'setText', args: [agent.node, key, value],
    })
    const h = await wallet.writeContract(request)
    link(h)
    await pub.waitForTransactionReceipt({ hash: h })
    ok(`${key} written`)
  }
  console.log()
}

// ---------------------------------------------------------------- summary
console.log('=== identity triple ===\n')
for (const a of Object.values(state.agents)) {
  console.log(`  ${a.name}`)
  console.log(`    ens      ${a.name}`)
  console.log(`    erc8004  ${a.erc8004Id}`)
  console.log(`    uaid     ${a.uaid}`)
  console.log(`    resolver ${a.resolver}\n`)
}
console.log(`  saved -> ${OUT}\n`)
