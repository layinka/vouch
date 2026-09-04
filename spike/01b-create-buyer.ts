/**
 * Creates a SECOND Hedera testnet account to act as the buyer agent.
 *
 * Why bother: x402 settlement is a TransferTransaction that must move value from
 * payer to payTo. If both are the same account the net movement is zero and the
 * facilitator's verify step rejects it. A separate buyer also makes the demo
 * honest — judges see a real transfer between two distinct parties.
 *
 * The new account gets:
 *   - an ECDSA key WITH an EVM alias (so it works with ethers/viem later)
 *   - HBAR from the operator
 *   - maxAutomaticTokenAssociations = -1, so it can receive USDC with no
 *     TokenAssociateTransaction (this is the cleaner alternative to gate 2)
 *
 * Prints the credentials to paste into .env. Run once.
 *
 * Run: node --env-file=.env spike/01b-create-buyer.ts
 */
import {
  Client, AccountId, PrivateKey, Hbar,
  AccountCreateTransaction, TransferTransaction,
} from '@hiero-ledger/sdk'

const operatorId = AccountId.fromString(process.env.HEDERA_ACCOUNT_ID!)
const operatorKey = PrivateKey.fromStringECDSA(process.env.HEDERA_PRIVATE_KEY!)
const INITIAL_HBAR = Number(process.env.BUYER_INITIAL_HBAR ?? 50)

const client = Client.forTestnet().setOperator(operatorId, operatorKey)
client.setDefaultMaxTransactionFee(new Hbar(5))

console.log('\n=== Create buyer agent account ===\n')

try {
  if (process.env.HEDERA_BUYER_ACCOUNT_ID) {
    console.log(`  note  HEDERA_BUYER_ACCOUNT_ID is already set to ${process.env.HEDERA_BUYER_ACCOUNT_ID}.`)
    console.log('        Delete it from .env first if you really want a fresh buyer.\n')
    process.exit(0)
  }

  const buyerKey = PrivateKey.generateECDSA()

  const receipt = await (
    await new AccountCreateTransaction()
      // ECDSA + EVM alias: the account gets both a 0.0.x id and a 0x address
      .setECDSAKeyWithAlias(buyerKey)
      .setInitialBalance(new Hbar(INITIAL_HBAR))
      // -1 = unlimited auto-association: this account can receive ANY HTS token
      // without an explicit TokenAssociateTransaction. Avoids the single most
      // common x402-on-Hedera failure (TOKEN_NOT_ASSOCIATED_TO_ACCOUNT).
      .setMaxAutomaticTokenAssociations(-1)
      .setMaxTransactionFee(new Hbar(20))
      .execute(client)
  ).getReceipt(client)

  const buyerId = receipt.accountId!.toString()

  console.log(`  ok    buyer account ${buyerId}`)
  console.log(`  ok    funded with ${INITIAL_HBAR} HBAR`)
  console.log(`  ok    unlimited auto token association (can receive USDC immediately)`)
  console.log(`\n  HashScan: https://hashscan.io/testnet/account/${buyerId}\n`)

  console.log('  ---- append these to .env ----\n')
  console.log(`HEDERA_BUYER_ACCOUNT_ID=${buyerId}`)
  console.log(`HEDERA_BUYER_PRIVATE_KEY=0x${buyerKey.toStringRaw()}`)
  console.log('\n  ------------------------------\n')
  console.log('  For USDC: https://faucet.circle.com  -> Hedera Testnet -> paste the buyer id above')
  console.log('  (20 USDC per address every 2 hours. No bridging needed.)\n')
} catch (err) {
  const status = (err as { status?: { toString(): string } }).status?.toString()
  console.error(`\n  FAIL  ${status ?? ''} ${(err as Error).message}\n`)
  process.exit(1)
} finally {
  client.close()
}
