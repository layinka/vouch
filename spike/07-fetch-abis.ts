/**
 * Fetches verified ABIs for every ENSv2 and ERC-8004 contract from Sourcify.
 *
 * Why Sourcify: there is no npm package for the ENSv2 contracts (they are a Sepolia
 * beta), Etherscan's API now needs a key, and GitHub rate-limits unauthenticated
 * requests. Sourcify is free, keyless, and serves the verified source, so these ABIs
 * are exactly what is deployed at the addresses in abis/_addresses.json.
 *
 * Writes packages/contracts/abis/<Name>.json and prints the functions Vouch needs,
 * so we never have to guess a signature.
 *
 * Run: node spike/07-fetch-abis.ts
 */
import { readFileSync, writeFileSync } from 'node:fs'

const SOURCIFY = 'https://sourcify.dev/server/v2/contract'
const BLOCKSCOUT = 'https://eth-sepolia.blockscout.com/api/v2/smart-contracts'
const DIR = 'packages/contracts/abis'

type AbiItem = {
  type: string
  name?: string
  inputs?: { name: string; type: string }[]
  outputs?: { name: string; type: string }[]
  stateMutability?: string
}

const manifest = JSON.parse(readFileSync(`${DIR}/_addresses.json`, 'utf8')) as {
  chainId: number
  [group: string]: Record<string, string> | number
}

// The calls Vouch actually makes. If one of these is missing after the fetch,
// the plan is wrong and we find out now rather than on day 2.
const NEEDED: Record<string, string[]> = {
  VerifiableFactory: ['deployProxy'],
  ETHRegistry: ['register', 'grantRootRoles', 'setSubregistry', 'getSubregistry', 'getResolver'],
  UserRegistryImpl: ['register', 'grantRootRoles', 'setSubregistry', 'getState', 'renew'],
  PermissionedResolverImpl: [
    'setText', 'text', 'setAddr', 'addr',
    'authorizeTextRoles', 'authorizeNameRoles', 'authorizeAddrRoles',
    'setAlias', 'initialize', 'multicall',
  ],
  ETHRegistrar: ['register', 'available', 'rentPrice'],
  IdentityRegistry: ['register', 'newAgent', 'ownerOf', 'tokenURI'],
  ReputationRegistry: ['giveFeedback', 'acceptFeedback'],
}

const sig = (f: AbiItem) =>
  `${f.name}(${(f.inputs ?? []).map((i) => `${i.type}${i.name ? ' ' + i.name : ''}`).join(', ')})` +
  ((f.outputs ?? []).length ? ` -> (${f.outputs!.map((o) => o.type).join(', ')})` : '') +
  (f.stateMutability && f.stateMutability !== 'nonpayable' ? `  [${f.stateMutability}]` : '')

/** Sourcify v2: free, keyless, serves verified source. Preferred. */
async function fromSourcify(address: string): Promise<(AbiItem[] & { __src?: string }) | null> {
  try {
    const res = await fetch(`${SOURCIFY}/${manifest.chainId}/${address}?fields=abi`)
    if (!res.ok) return null
    const body = (await res.json()) as { abi?: AbiItem[] }
    if (!body.abi?.length) return null
    const out = body.abi as AbiItem[] & { __src?: string }
    out.__src = 'sourcify'
    return out
  } catch {
    return null
  }
}

/** Blockscout Sepolia: also free and keyless, and covers contracts Sourcify lacks. */
async function fromBlockscout(address: string): Promise<(AbiItem[] & { __src?: string }) | null> {
  try {
    const res = await fetch(`${BLOCKSCOUT}/${address}`)
    if (!res.ok) return null
    const body = (await res.json()) as { abi?: AbiItem[] }
    if (!body.abi?.length) return null
    const out = body.abi as AbiItem[] & { __src?: string }
    out.__src = 'blockscout'
    return out
  } catch {
    return null
  }
}

console.log('\n=== Fetch verified ABIs (Sourcify, falling back to Blockscout) ===\n')

const results: Record<string, AbiItem[] & { __src?: string }> = {}

for (const [group, entries] of Object.entries(manifest)) {
  if (typeof entries !== 'object') continue
  for (const [name, address] of Object.entries(entries)) {
    const abi = await fromSourcify(address) ?? await fromBlockscout(address)
    if (!abi?.length) {
      console.log(`  MISS  ${name.padEnd(26)} not verified on Sourcify or Blockscout`)
      continue
    }
    results[name] = abi
    writeFileSync(`${DIR}/${name}.json`, JSON.stringify(abi, null, 2) + '\n')
    const fns = abi.filter((f) => f.type === 'function').length
    const evs = abi.filter((f) => f.type === 'event').length
    console.log(
      `  ok    ${name.padEnd(26)} ${String(fns).padStart(3)} fns, ${String(evs).padStart(2)} events` +
        `  [${group}/${abi.__src}]`,
    )
  }
}

// ---- verify the functions the plan depends on actually exist ----
console.log('\n=== Signatures Vouch depends on ===')
let missing = 0
for (const [contract, wanted] of Object.entries(NEEDED)) {
  const abi = results[contract]
  if (!abi) {
    console.log(`\n  ${contract}: ABI NOT FETCHED`)
    missing += wanted.length
    continue
  }
  console.log(`\n  ${contract}`)
  for (const fnName of wanted) {
    const matches = abi.filter((f) => f.type === 'function' && f.name === fnName)
    if (!matches.length) {
      console.log(`    ??  ${fnName}  — NOT FOUND`)
      missing++
      continue
    }
    for (const m of matches) console.log(`    ok  ${sig(m)}`)
  }
}

console.log(`\n  ${missing === 0 ? 'All expected functions present.' : `${missing} expected function(s) missing — plan needs adjusting.`}\n`)
