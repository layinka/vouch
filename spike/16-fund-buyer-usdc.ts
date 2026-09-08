/**
 * Moves USDC from the service account to the buyer agent so the marketplace demo
 * can settle in USDC rather than HBAR. The buyer has
 * maxAutomaticTokenAssociations = -1, so no TokenAssociateTransaction is needed.
 *
 * Run: node --env-file=.env spike/16-fund-buyer-usdc.ts [amountUsdc]
 */
import { Client, AccountId, PrivateKey, Hbar, TransferTransaction } from '@hiero-ledger/sdk'

const USDC = process.env.X402_ASSET ?? '0.0.429274'
const AMOUNT = Number(process.argv[2] ?? 8)
const from = AccountId.fromString(process.env.HEDERA_ACCOUNT_ID!)
const to = AccountId.fromString(process.env.HEDERA_BUYER_ACCOUNT_ID!)
const key = PrivateKey.fromStringECDSA(process.env.HEDERA_PRIVATE_KEY!)

const client = Client.forTestnet().setOperator(from, key)
client.setDefaultMaxTransactionFee(new Hbar(5))

const units = Math.round(AMOUNT * 1e6) // USDC has 6 decimals

console.log(`\n  sending ${AMOUNT} USDC  ${from} -> ${to}`)
const receipt = await (
  await new TransferTransaction()
    .addTokenTransfer(USDC, from, -units)
    .addTokenTransfer(USDC, to, units)
    .setMaxTransactionFee(new Hbar(5))
    .execute(client)
).getReceipt(client)

console.log(`  ${receipt.status.toString()}`)
console.log(`  https://hashscan.io/testnet/account/${to}/tokens\n`)
client.close()
