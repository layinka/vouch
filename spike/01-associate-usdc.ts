/**
 * Day-0 gate 2/4 — associate this account with USDC so it can receive HTS transfers.
 *
 * This is THE x402-on-Hedera footgun: an account cannot receive an HTS token it has
 * not opted into. If payTo is unassociated, settlement fails with
 * TOKEN_NOT_ASSOCIATED_TO_ACCOUNT.
 *
 * Idempotent: exits cleanly if already associated.
 *
 * Run: pnpm spike:assoc
 */
import {
  Client, AccountId, PrivateKey, Hbar,
  AccountBalanceQuery, TokenAssociateTransaction,
} from '@hiero-ledger/sdk'

const USDC = process.env.X402_ASSET ?? '0.0.429274'
const accountId = process.env.HEDERA_ACCOUNT_ID!
const key = PrivateKey.fromStringECDSA(process.env.HEDERA_PRIVATE_KEY!)
const operator = AccountId.fromString(accountId)

const client = Client.forTestnet().setOperator(operator, key)
client.setDefaultMaxTransactionFee(new Hbar(5))

console.log('\n=== Vouch day-0 gate 2/4: associate USDC ===\n')

try {
  if (USDC === '0.0.0') {
    console.log('  skip  X402_ASSET is 0.0.0 (HBAR). HBAR needs no association.\n')
    process.exit(0)
  }

  const before = await new AccountBalanceQuery().setAccountId(operator).execute(client)
  if (before.tokens?.get(USDC) !== null && before.tokens?.get(USDC) !== undefined) {
    console.log(`  ok    ${accountId} is already associated with ${USDC} — nothing to do.\n`)
    console.log('  GATE 2/4 PASSED\n')
    process.exit(0)
  }

  console.log(`  ..    associating ${accountId} with ${USDC}`)
  const signed = await new TokenAssociateTransaction()
    .setAccountId(operator)
    .setTokenIds([USDC])
    .setMaxTransactionFee(new Hbar(5))
    .freezeWith(client)
    .sign(key)

  const response = await signed.execute(client)
  const receipt = await response.getReceipt(client)

  console.log(`  ok    status ${receipt.status.toString()}`)
  console.log(`\n  HashScan: https://hashscan.io/testnet/account/${accountId}/tokens\n`)
  console.log('  GATE 2/4 PASSED\n')
} catch (err) {
  const status = (err as { status?: { toString(): string } }).status?.toString()
  console.error(`\n  FAIL  ${status ?? ''} ${(err as Error).message}`)
  if (status === 'INSUFFICIENT_TX_FEE') console.error('        Raise setMaxTransactionFee.')
  if (status === 'INSUFFICIENT_PAYER_BALANCE') console.error('        Top up HBAR at portal.hedera.com.')
  if (status === 'TOKEN_ALREADY_ASSOCIATED_TO_ACCOUNT') {
    console.error('        Already associated — this is fine, treat as pass.')
    process.exit(0)
  }
  process.exit(1)
} finally {
  client.close()
}
