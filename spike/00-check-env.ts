/**
 * Day-0 gate 1/4 — prove we can talk to Hedera testnet.
 *
 * Checks: credentials parse, key is ECDSA (NOT ED25519), account exists,
 * HBAR balance is non-zero, and whether USDC (0.0.429274) is associated.
 *
 * Run: pnpm spike:env
 */
import { Client, AccountId, PrivateKey, AccountBalanceQuery, Hbar } from '@hiero-ledger/sdk'

const MIRROR = process.env.HEDERA_MIRROR_URL ?? 'https://testnet.mirrornode.hedera.com/api/v1'
const USDC = process.env.X402_ASSET ?? '0.0.429274'

const accountId = process.env.HEDERA_ACCOUNT_ID
const rawKey = process.env.HEDERA_PRIVATE_KEY

function die(msg: string): never {
  console.error(`\n  FAIL  ${msg}\n`)
  process.exit(1)
}

if (!accountId) die('HEDERA_ACCOUNT_ID is not set. Copy .env.example to .env and fill it in.')
if (!rawKey) die('HEDERA_PRIVATE_KEY is not set.')

console.log('\n=== Vouch day-0 gate 1/4: Hedera connectivity ===\n')

// --- key must be ECDSA secp256k1, or EVM tooling will not work later ---
let key: PrivateKey
try {
  key = PrivateKey.fromStringECDSA(rawKey)
} catch {
  try {
    PrivateKey.fromStringED25519(rawKey)
    die(
      'That key parses as ED25519, not ECDSA.\n' +
        '        ED25519 accounts have no EVM address and will break ethers/viem later.\n' +
        '        Create a new TESTNET account on portal.hedera.com and pick ECDSA.',
    )
  } catch {
    die('HEDERA_PRIVATE_KEY did not parse as either ECDSA or ED25519. Check for stray quotes/whitespace.')
  }
}
console.log(`  ok    key parsed as ECDSA secp256k1`)
console.log(`        public key   ${key.publicKey.toStringDer().slice(0, 26)}...`)

const operator = AccountId.fromString(accountId)
const client = Client.forTestnet().setOperator(operator, key)
client.setDefaultMaxTransactionFee(new Hbar(5))

try {
  // --- consensus-node read: balances ---
  const balance = await new AccountBalanceQuery().setAccountId(operator).execute(client)
  const hbar = balance.hbars.toBigNumber().toNumber()
  console.log(`  ok    account      ${accountId}`)
  console.log(`  ${hbar > 1 ? 'ok  ' : 'WARN'}  HBAR balance ${hbar}`)
  if (hbar <= 1) console.log('        Low. Top up at portal.hedera.com (100 HBAR/day faucet).')

  const usdcRaw = balance.tokens?.get(USDC)
  const associated = usdcRaw !== null && usdcRaw !== undefined
  if (associated) {
    console.log(`  ok    USDC ${USDC} associated, balance ${Number(usdcRaw) / 1e6} USDC`)
    if (Number(usdcRaw) === 0) {
      console.log('        Balance is 0 — fine for the RECEIVING account, not for the payer.')
    }
  } else {
    console.log(`  WARN  USDC ${USDC} is NOT associated with this account.`)
    console.log('        Run: pnpm spike:assoc     (or fall back to HBAR settlement)')
  }

  // --- mirror-node read: EVM address (proves ECDSA alias exists) ---
  const res = await fetch(`${MIRROR}/accounts/${accountId}`)
  if (res.ok) {
    const acc = (await res.json()) as { evm_address?: string; key?: { _type?: string } }
    console.log(`  ok    mirror node reachable`)
    console.log(`        key type     ${acc.key?._type ?? 'unknown'}`)
    console.log(`        evm address  ${acc.evm_address ?? '(none — not an ECDSA account!)'}`)
    if (acc.key?._type && !acc.key._type.toUpperCase().includes('ECDSA')) {
      console.log('  WARN  Mirror node reports a non-ECDSA key on this account.')
    }
  } else {
    console.log(`  WARN  mirror node returned ${res.status} (it lags a few seconds for new accounts)`)
  }

  console.log(`\n  HashScan: https://hashscan.io/testnet/account/${accountId}\n`)
  console.log('  GATE 1/4 PASSED\n')
} catch (err) {
  const status = (err as { status?: { toString(): string } }).status
  die(`${status ? status.toString() + ' — ' : ''}${(err as Error).message}`)
} finally {
  client.close()
}
