/**
 * Generates the three Sepolia keypairs Vouch needs, writes them straight to .env,
 * and prints ONLY the addresses so private keys never end up in a terminal
 * transcript, a screen recording, or a pasted log.
 *
 * The three roles are not bureaucracy — the separation IS the ENS submission:
 *
 *   DEPLOYER  owns the parent name and deploys everything. Holds the registry.
 *   SCORER    the ONLY key on earth permitted to write agent:score. Nothing else.
 *   AGENT     an agent's own operational key. May write agent:endpoint.
 *             Its attempt to write agent:score MUST revert on-chain — that
 *             reverted transaction is demo moment A.
 *
 * If the three keys were one key, there would be no product.
 *
 * Idempotent: refuses to overwrite keys already present in .env.
 *
 * Run: node --env-file-if-exists=.env spike/06-gen-sepolia-keys.ts
 */
import { readFileSync, writeFileSync, existsSync } from 'node:fs'
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts'
import { createPublicClient, http, formatEther } from 'viem'
import { sepolia } from 'viem/chains'

const ENV_PATH = '.env'
const RPC = process.env.SEPOLIA_RPC_URL ?? 'https://ethereum-sepolia-rpc.publicnode.com'

const ROLES = [
  {
    env: 'DEPLOYER_PRIVATE_KEY',
    addrEnv: 'DEPLOYER_ADDRESS',
    name: 'DEPLOYER',
    fund: '~0.3 ETH',
    why: 'registers the parent name, deploys UserRegistry proxy, VouchRegistrar, resolvers, 2 contracts',
  },
  {
    env: 'SCORER_PRIVATE_KEY',
    addrEnv: 'SCORER_ADDRESS',
    name: 'SCORER',
    fund: '~0.05 ETH',
    why: 'one setText per score update; the indexer writes agent:score continuously during the demo',
  },
  {
    env: 'AGENT_PRIVATE_KEY',
    addrEnv: 'AGENT_ADDRESS',
    name: 'AGENT',
    fund: '~0.02 ETH',
    why: 'writes agent:endpoint, then attempts agent:score — a reverted tx still burns gas',
  },
] as const

let env = existsSync(ENV_PATH) ? readFileSync(ENV_PATH, 'utf8') : ''
const has = (k: string) => new RegExp(`^${k}=.+`, 'm').test(env)

console.log('\n=== Generate Sepolia keys ===\n')

const generated: { name: string; address: string; fund: string; why: string }[] = []
let appended = ''

for (const role of ROLES) {
  if (has(role.env)) {
    const m = env.match(new RegExp(`^${role.addrEnv}=(.+)$`, 'm'))
    console.log(`  skip  ${role.name.padEnd(9)} already in .env${m ? ` (${m[1]!.trim()})` : ''}`)
    if (m) generated.push({ name: role.name, address: m[1]!.trim(), fund: role.fund, why: role.why })
    continue
  }
  const pk = generatePrivateKey()
  const account = privateKeyToAccount(pk)
  appended += `${role.addrEnv}=${account.address}\n${role.env}=${pk}\n`
  generated.push({ name: role.name, address: account.address, fund: role.fund, why: role.why })
  console.log(`  new   ${role.name.padEnd(9)} ${account.address}`)
}

if (appended) {
  env = env.replace(/\s*$/, '\n')
  env += `\n# ---- Sepolia keys, generated ${new Date().toISOString().slice(0, 10)} ----\n`
  env += '# Throwaway testnet keys. Never reuse for anything holding real value.\n'
  env += appended
  writeFileSync(ENV_PATH, env)
  console.log(`\n  ok    wrote ${appended.split('\n').length - 1} lines to .env (gitignored)`)
} else {
  console.log('\n  ok    nothing to generate')
}

// ---- balances + funding instructions ----
const client = createPublicClient({ chain: sepolia, transport: http(RPC) })

console.log('\n  ================= FUND THESE THREE =================\n')
let total = 0n
for (const g of generated) {
  let bal = 0n
  try {
    bal = await client.getBalance({ address: g.address as `0x${string}` })
  } catch {
    /* RPC hiccup; show 0 */
  }
  total += bal
  const status = bal > 0n ? `${formatEther(bal)} ETH` : 'EMPTY'
  console.log(`  ${g.name.padEnd(9)} ${g.address}`)
  console.log(`  ${''.padEnd(9)} need ${g.fund.padEnd(10)} have ${status}`)
  console.log(`  ${''.padEnd(9)} ${g.why}\n`)
}

console.log(`  total held: ${formatEther(total)} ETH\n`)
console.log('  Faucets (most give 0.05-0.5 ETH/day and want a mainnet-active address):')
console.log('    https://cloud.google.com/application/web3/faucet/ethereum/sepolia')
console.log('    https://www.alchemy.com/faucets/ethereum-sepolia')
console.log('    https://sepolia-faucet.pk910.de/           (PoW, no account, slow but unlimited)')
console.log('\n  Rate-limited? Fund DEPLOYER only, then spread it:')
console.log('    node --env-file=.env spike/06b-fund-roles.ts\n')
console.log('  Re-run this script any time to re-check balances.\n')
