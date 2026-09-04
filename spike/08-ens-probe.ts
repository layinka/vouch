/**
 * Probes the live ENSv2 Sepolia registrar so we know EXACTLY how to register the
 * parent name before spending gas.
 *
 * Registration is commit-reveal and priced in an ERC-20 `paymentToken`, not ETH:
 *   makeCommitment(...) -> commit(hash) -> wait MIN_COMMITMENT_AGE -> register(...)
 *
 * So the questions that decide day 1 are: which tokens does the price oracle accept,
 * is our label free, and what does it cost.
 *
 * Run: node --env-file=.env spike/08-ens-probe.ts [label]
 */
import { readFileSync } from 'node:fs'
import { createPublicClient, http, formatUnits, parseAbi, zeroAddress } from 'viem'
import { sepolia } from 'viem/chains'

const RPC = process.env.SEPOLIA_RPC_URL ?? 'https://ethereum-sepolia-rpc.publicnode.com'
const LABEL = process.argv[2] ?? process.env.VOUCH_PARENT_LABEL ?? 'vouch'
const DIR = 'packages/contracts/abis'

const A = JSON.parse(readFileSync(`${DIR}/_addresses.json`, 'utf8')) as {
  ensv2: Record<string, `0x${string}`>
}
const abi = (n: string) => JSON.parse(readFileSync(`${DIR}/${n}.json`, 'utf8'))

const client = createPublicClient({ chain: sepolia, transport: http(RPC) })
const registrar = { address: A.ensv2.ETHRegistrar, abi: abi('ETHRegistrar') } as const
const oracle = { address: A.ensv2.StandardRentPriceOracle, abi: abi('StandardRentPriceOracle') } as const

console.log('\n=== ENSv2 Sepolia registrar probe ===\n')
console.log(`  label under test: "${LABEL}"`)
console.log(`  registrar        ${registrar.address}`)
console.log(`  price oracle     ${oracle.address}\n`)

const read = async (c: typeof registrar | typeof oracle, functionName: string, args: unknown[] = []) => {
  try {
    return await client.readContract({ ...c, functionName, args } as never)
  } catch (err) {
    return `ERR: ${(err as Error).message.split('\n')[0]}`
  }
}

// ---- commit-reveal timing ----
console.log('  --- commit/reveal parameters ---')
for (const k of ['MIN_COMMITMENT_AGE', 'MAX_COMMITMENT_AGE', 'MIN_REGISTER_DURATION', 'GRACE_PERIOD']) {
  const v = await read(registrar, k)
  console.log(`  ${k.padEnd(24)} ${v}${typeof v === 'bigint' ? ` s (${Number(v) / 60} min)` : ''}`)
}
console.log(`  ${'ETH_REGISTRY'.padEnd(24)} ${await read(registrar, 'ETH_REGISTRY')}`)
console.log(`  ${'BENEFICIARY'.padEnd(24)} ${await read(registrar, 'BENEFICIARY')}`)

// ---- availability ----
console.log('\n  --- availability ---')
console.log(`  isAvailable("${LABEL}")     ${await read(registrar, 'isAvailable', [LABEL])}`)
console.log(`  oracle.isValid("${LABEL}")  ${await read(oracle, 'isValid', [LABEL])}`)

// ---- which ERC-20s can pay? ----
console.log('\n  --- accepted payment tokens (from PaymentTokenUpdated logs) ---')
// Public RPCs cap eth_getLogs at 50k blocks, so walk backwards in chunks.
// ENSv2 is a recent beta, so its events are near the head.
const PAYMENT_TOKEN_EVENT = parseAbi([
  'event PaymentTokenUpdated(address indexed paymentToken, uint128 numer, uint128 denom)',
])[0]

const head = await client.getBlockNumber()
const CHUNK = 45_000n
const MAX_LOOKBACK = 1_500_000n
const collected: `0x${string}`[] = []

for (let to = head; to > (head > MAX_LOOKBACK ? head - MAX_LOOKBACK : 0n); to -= CHUNK) {
  const from = to > CHUNK ? to - CHUNK : 0n
  try {
    const chunk = await client.getLogs({
      address: oracle.address,
      event: PAYMENT_TOKEN_EVENT,
      fromBlock: from,
      toBlock: to,
    })
    for (const l of chunk) {
      const t = (l.args as { paymentToken?: `0x${string}` }).paymentToken
      if (t) collected.push(t)
    }
    if (chunk.length) {
      console.log(`  found ${chunk.length} PaymentTokenUpdated event(s) in blocks ${from}-${to}`)
      break // configured at deploy time; the first hit walking back is enough
    }
  } catch {
    /* chunk failed; keep walking */
  }
}

// Also probe well-known Sepolia tokens directly, in case the events predate our window.
const PROBE: `0x${string}`[] = [
  zeroAddress as `0x${string}`,
  '0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238', // Circle USDC on Sepolia
  '0xfFf9976782d46CC05630D1f6eBAb18b2324d6B14', // WETH on Sepolia
]

const tokens = [...new Set([...collected, ...PROBE])] as `0x${string}`[]

if (!tokens.length) console.log('  (no PaymentTokenUpdated events found)')

const erc20 = parseAbi([
  'function symbol() view returns (string)',
  'function decimals() view returns (uint8)',
  'function balanceOf(address) view returns (uint256)',
])

const candidates: { token: `0x${string}`; symbol: string; decimals: number }[] = []

for (const t of tokens) {
  const accepted = await read(oracle, 'isPaymentToken', [t])
  if (accepted !== true) {
    console.log(`  ${t}  isPaymentToken=${accepted}`)
    continue
  }
  let symbol = 'ETH (native)'
  let decimals = 18
  if (t !== zeroAddress) {
    try {
      symbol = (await client.readContract({ address: t, abi: erc20, functionName: 'symbol' })) as string
      decimals = (await client.readContract({ address: t, abi: erc20, functionName: 'decimals' })) as number
    } catch {
      symbol = '(unknown ERC-20)'
    }
  }
  candidates.push({ token: t, symbol, decimals })
  console.log(`  ACCEPTED  ${t}  ${symbol} (${decimals}dp)`)
}

// ---- price for one year in each accepted token ----
const ONE_YEAR = 31_536_000n
console.log(`\n  --- getRegisterPrice("${LABEL}", 1 year, token) ---`)
for (const c of candidates) {
  const p = await read(registrar, 'getRegisterPrice', [LABEL, ONE_YEAR, c.token])
  if (Array.isArray(p)) {
    const [base, premium] = p as [bigint, bigint]
    console.log(
      `  ${c.symbol.padEnd(16)} base ${formatUnits(base, c.decimals)}  premium ${formatUnits(premium, c.decimals)}  total ${formatUnits(base + premium, c.decimals)}`,
    )
    const deployer = process.env.DEPLOYER_ADDRESS as `0x${string}` | undefined
    if (deployer && c.token !== zeroAddress) {
      try {
        const bal = (await client.readContract({
          address: c.token,
          abi: erc20,
          functionName: 'balanceOf',
          args: [deployer],
        })) as bigint
        console.log(`  ${''.padEnd(16)} deployer holds ${formatUnits(bal, c.decimals)} ${c.symbol}`)
      } catch {
        /* ignore */
      }
    }
  } else {
    console.log(`  ${c.symbol.padEnd(16)} ${p}`)
  }
}
console.log()
