/**
 * Day-1 gate — stand up the Vouch parent name on ENSv2 Sepolia.
 *
 *   1. deploy our own UserRegistry proxy via the VerifiableFactory
 *   2. register `<label>.eth` via commit-reveal, pointing its subregistry at that proxy
 *   3. verify ETHRegistry.getSubregistry(label) resolves to us
 *
 * After this, `*.vouch.eth` is OURS to mint agent identities under, with our rules.
 *
 * Every state-changing call is simulated first, so a bad role bitmap or a stale
 * commitment fails for free instead of burning gas.
 *
 * Writes deployments/sepolia.json. Idempotent: skips whatever already exists.
 *
 * Run: node --env-file=.env spike/09-deploy-parent.ts [label]
 */
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs'
import {
  createPublicClient, createWalletClient, http, encodeFunctionData,
  parseAbi, formatUnits, zeroAddress, decodeEventLog, type Hex,
} from 'viem'
import { privateKeyToAccount } from 'viem/accounts'
import { sepolia } from 'viem/chains'

const RPC = process.env.SEPOLIA_RPC_URL ?? 'https://ethereum-sepolia-rpc.publicnode.com'
const LABEL = process.argv[2] ?? process.env.VOUCH_PARENT_LABEL ?? 'vouch'
const DIR = 'packages/contracts/abis'
const OUT = 'deployments/sepolia.json'
const USDC = '0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238' as const
const ONE_YEAR = 31_536_000n

// ---- EAC role constants (docs.ens.domains/ensv2/permissioned-registry) ----
// Each role occupies a nybble; admin variants live 128 bits higher.
const ROLE_REGISTRAR = 1n << 0n
const ROLE_UNREGISTER = 1n << 12n // needed to revoke an agent — demo moment C
const ROLE_RENEW = 1n << 16n
const ROLE_SET_SUBREGISTRY = 1n << 20n
const ROLE_SET_RESOLVER = 1n << 24n
const ROLE_SET_URI = 1n << 36n
const ROLE_UPGRADE = 1n << 124n
const admin = (r: bigint) => r << 128n

// What the deployer holds on the registry itself.
const REGISTRAR_ROLES =
  ROLE_REGISTRAR | ROLE_UNREGISTER | ROLE_RENEW | ROLE_SET_SUBREGISTRY | ROLE_SET_RESOLVER | ROLE_SET_URI | ROLE_UPGRADE
const ROOT_BITMAP = REGISTRAR_ROLES | admin(REGISTRAR_ROLES)

const A = JSON.parse(readFileSync(`${DIR}/_addresses.json`, 'utf8')) as { ensv2: Record<string, Hex> }
const abiOf = (n: string) => JSON.parse(readFileSync(`${DIR}/${n}.json`, 'utf8'))

const key = process.env.DEPLOYER_PRIVATE_KEY as Hex | undefined
if (!key) throw new Error('DEPLOYER_PRIVATE_KEY missing — run: pnpm keys:gen')
const account = privateKeyToAccount(key)

const pub = createPublicClient({ chain: sepolia, transport: http(RPC) })
const wallet = createWalletClient({ account, chain: sepolia, transport: http(RPC) })

const erc20 = parseAbi([
  'function balanceOf(address) view returns (uint256)',
  'function allowance(address,address) view returns (uint256)',
  'function approve(address,uint256) returns (bool)',
])

type Deployment = {
  label?: string
  parentName?: string
  userRegistry?: Hex
  tokenId?: string
  registerTx?: Hex
  proxyTx?: Hex
  rootBitmap?: string
}
mkdirSync('deployments', { recursive: true })
const state: Deployment = existsSync(OUT) ? JSON.parse(readFileSync(OUT, 'utf8')) : {}
const save = () => writeFileSync(OUT, JSON.stringify(state, null, 2) + '\n')

const ok = (m: string) => console.log(`  ok    ${m}`)
const step = (m: string) => console.log(`\n  ..    ${m}`)
const link = (h: Hex) => console.log(`        https://sepolia.etherscan.io/tx/${h}`)

console.log('\n=== Vouch day-1: stand up the parent name ===\n')
console.log(`  label     ${LABEL}.eth`)
console.log(`  deployer  ${account.address}`)
console.log(`  roleBitmap 0x${ROOT_BITMAP.toString(16)}`)

const ethBal = await pub.getBalance({ address: account.address })
const usdcBal = await pub.readContract({ address: USDC, abi: erc20, functionName: 'balanceOf', args: [account.address] })
console.log(`  balances  ${formatUnits(ethBal, 18)} ETH · ${formatUnits(usdcBal as bigint, 6)} USDC\n`)

// ------------------------------------------------------------------ 1. registry
if (state.userRegistry) {
  ok(`UserRegistry proxy already deployed: ${state.userRegistry}`)
} else {
  step('deploying UserRegistry proxy via VerifiableFactory')
  const initData = encodeFunctionData({
    abi: abiOf('UserRegistryImpl'),
    functionName: 'initialize',
    args: [account.address, ROOT_BITMAP],
  })
  const salt = BigInt(Date.now())

  const { request } = await pub.simulateContract({
    account,
    address: A.ensv2.VerifiableFactory,
    abi: abiOf('VerifiableFactory'),
    functionName: 'deployProxy',
    args: [A.ensv2.UserRegistryImpl, salt, initData],
  })
  const hash = await wallet.writeContract(request)
  link(hash)
  const receipt = await pub.waitForTransactionReceipt({ hash })

  for (const log of receipt.logs) {
    try {
      const ev = decodeEventLog({ abi: abiOf('VerifiableFactory'), ...log }) as { eventName: string; args: Record<string, unknown> }
      if (ev.eventName === 'ProxyDeployed') {
        state.userRegistry = (ev.args as { proxyAddress: Hex }).proxyAddress
      }
    } catch {
      /* not our event */
    }
  }
  if (!state.userRegistry) throw new Error('ProxyDeployed event not found')
  state.proxyTx = hash
  state.rootBitmap = `0x${ROOT_BITMAP.toString(16)}`
  save()
  ok(`UserRegistry proxy ${state.userRegistry}`)
}

// ------------------------------------------------------------------ 2. register
const registrar = { address: A.ensv2.ETHRegistrar, abi: abiOf('ETHRegistrar') } as const

if (state.tokenId) {
  ok(`${LABEL}.eth already registered (tokenId ${state.tokenId})`)
} else {
  const available = await pub.readContract({ ...registrar, functionName: 'isAvailable', args: [LABEL] })
  if (!available) throw new Error(`"${LABEL}" is not available`)

  const [base, premium] = (await pub.readContract({
    ...registrar,
    functionName: 'getRegisterPrice',
    args: [LABEL, ONE_YEAR, USDC],
  })) as [bigint, bigint]
  const price = base + premium
  console.log(`\n  price     ${formatUnits(price, 6)} USDC for 1 year`)
  if ((usdcBal as bigint) < price) {
    throw new Error(`Need ${formatUnits(price, 6)} USDC, have ${formatUnits(usdcBal as bigint, 6)}. faucet.circle.com -> Ethereum Sepolia`)
  }

  // secret must survive between commit and register
  const secret = `0x${Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString('hex')}` as Hex
  const referrer = `0x${'00'.repeat(32)}` as Hex

  const commitment = (await pub.readContract({
    ...registrar,
    functionName: 'makeCommitment',
    args: [LABEL, account.address, secret, state.userRegistry, zeroAddress, ONE_YEAR, referrer],
  })) as Hex
  ok(`commitment ${commitment}`)

  // allowance first — easy to forget, and register() reverts opaquely without it
  const allowance = (await pub.readContract({
    address: USDC, abi: erc20, functionName: 'allowance', args: [account.address, registrar.address],
  })) as bigint
  if (allowance < price) {
    step('approving USDC to the registrar')
    const { request } = await pub.simulateContract({
      account, address: USDC, abi: erc20, functionName: 'approve', args: [registrar.address, price * 2n],
    })
    const h = await wallet.writeContract(request)
    link(h)
    await pub.waitForTransactionReceipt({ hash: h })
    ok('approved')
  } else {
    ok('USDC allowance already sufficient')
  }

  step('commit()')
  {
    const { request } = await pub.simulateContract({ account, ...registrar, functionName: 'commit', args: [commitment] })
    const h = await wallet.writeContract(request)
    link(h)
    await pub.waitForTransactionReceipt({ hash: h })
  }

  const minAge = (await pub.readContract({ ...registrar, functionName: 'MIN_COMMITMENT_AGE' })) as bigint
  const waitMs = Number(minAge) * 1000 + 15_000
  step(`waiting ${waitMs / 1000}s for MIN_COMMITMENT_AGE (${minAge}s) to elapse`)
  await new Promise((r) => setTimeout(r, waitMs))

  step('register()')
  {
    const { request } = await pub.simulateContract({
      account, ...registrar, functionName: 'register',
      args: [LABEL, account.address, secret, state.userRegistry, zeroAddress, ONE_YEAR, USDC, referrer],
    })
    const h = await wallet.writeContract(request)
    link(h)
    const receipt = await pub.waitForTransactionReceipt({ hash: h })
    state.registerTx = h
    for (const log of receipt.logs) {
      try {
        const ev = decodeEventLog({ abi: registrar.abi, ...log }) as { eventName: string; args: Record<string, unknown> }
        if (ev.eventName === 'NameRegistered') state.tokenId = String((ev.args as { tokenId: bigint }).tokenId)
      } catch {
        /* not our event */
      }
    }
    state.label = LABEL
    state.parentName = `${LABEL}.eth`
    save()
    ok(`registered ${LABEL}.eth  tokenId ${state.tokenId}`)
  }
}

// ------------------------------------------------------------------ 3. verify
step('verifying on-chain wiring')
const ethRegistry = { address: A.ensv2.ETHRegistry, abi: abiOf('ETHRegistry') } as const
const sub = (await pub.readContract({ ...ethRegistry, functionName: 'getSubregistry', args: [LABEL] })) as Hex
const owner = (await pub.readContract({ ...ethRegistry, functionName: 'findOwner', args: [LABEL] }).catch(() => null)) as Hex | null

console.log(`        ETHRegistry.getSubregistry("${LABEL}") = ${sub}`)
console.log(`        our UserRegistry proxy               = ${state.userRegistry}`)
if (owner) console.log(`        owner                                = ${owner}`)

const wired = sub.toLowerCase() === state.userRegistry!.toLowerCase()
console.log(`\n  ${wired ? 'GATE PASSED' : 'MISMATCH — subregistry is not ours'}`)
console.log(`\n  ${LABEL}.eth  ->  https://sepolia.app.ens.domains/${LABEL}.eth`)
console.log(`  registry      ->  https://sepolia.etherscan.io/address/${state.userRegistry}`)
console.log(`  saved         ->  ${OUT}\n`)
