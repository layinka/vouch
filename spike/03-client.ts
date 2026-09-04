/**
 * Day-0 gate 4/4 — a buyer agent completes a REAL PAID REQUEST end to end.
 *
 * This is the money shot for the Hedera track: "Build a platform or agent that
 * consumes that service and completes at least one real paid request end to end."
 *
 * Flow (all handled by wrapFetchWithPayment):
 *   1. GET /score               -> 402 + PaymentRequirements
 *   2. build TransferTransaction, transactionId.accountId = facilitator feePayer
 *   3. sign with OUR key only   -> PARTIALLY signed
 *   4. retry with X-PAYMENT     -> server verifies + settles via Blocky402
 *   5. facilitator adds its fee-payer signature and submits to Hedera
 *
 * Prints a HashScan link to the settled transaction. That link is the gate.
 *
 * Run: pnpm spike:client   (with the server running in another terminal)
 */
import { wrapFetchWithPayment, x402Client, decodePaymentResponseHeader } from '@x402/fetch'
import { ExactHederaScheme } from '@x402/hedera/exact/client'
import { createClientHederaSigner } from '@x402/hedera'
import { PrivateKey } from '@hiero-ledger/sdk'
import type { Network } from '@x402/core/types'

const BASE = process.env.SPIKE_BASE_URL ?? 'http://localhost:3000'
const NETWORK = (process.env.X402_NETWORK ?? 'hedera:testnet') as Network
const AGENT = process.argv[2] ?? 'researcher.vouch.eth'

// The BUYER's credentials. For the spike this can be the same account as the
// server; for the real demo use a separate buyer account so the transfer is
// visibly between two parties.
const buyerId = process.env.HEDERA_BUYER_ACCOUNT_ID ?? process.env.HEDERA_ACCOUNT_ID
const buyerKeyRaw = process.env.HEDERA_BUYER_PRIVATE_KEY ?? process.env.HEDERA_PRIVATE_KEY

if (!buyerId || !buyerKeyRaw) {
  console.error('\n  FAIL  HEDERA_ACCOUNT_ID / HEDERA_PRIVATE_KEY not set.\n')
  process.exit(1)
}

console.log('\n=== Vouch day-0 gate 4/4: buyer agent pays for a reputation lookup ===\n')

const signer = createClientHederaSigner(buyerId, PrivateKey.fromStringECDSA(buyerKeyRaw), {
  network: NETWORK,
})

// SPEND CONTROLS — enforced client-side, BEFORE any payment payload is built.
//
// This is not our code: @x402/core ships a budget guardrail. By default it allows
// only assets the scheme recognises (USDC on Hedera) and caps each payment at $1.
// HBAR (0.0.0) is NOT a default asset, so paying in HBAR must be opted into
// explicitly — which is why the first run of this script failed closed.
//
// This matters for Vouch: it is the buyer agent's mandate, expressed in code. A
// rogue or hijacked agent cannot pay an unexpected asset or exceed its per-call cap.
const client = new x402Client()
  .register(NETWORK, new ExactHederaScheme(signer))
  .setSpendControls({
    maxAmountPerPayment: '$0.50',
    allowedAssets: [
      { network: NETWORK, asset: '0.0.429274', maxAmountPerPayment: '50000' },   // USDC: max $0.05/call
      { network: NETWORK, asset: '0.0.0', maxAmountPerPayment: '5000000' },      // HBAR: max 0.05 HBAR/call
    ],
  })

const fetchWithPay = wrapFetchWithPayment(fetch, client)

// --- 1. the free endpoint: what the agent claims ---
console.log(`  [free] GET /v1/agents/${AGENT}`)
const claims = await fetch(`${BASE}/v1/agents/${AGENT}`)
console.log('        ', JSON.stringify(await claims.json()).slice(0, 160), '\n')

// --- 2. unpaid hit, to prove the gate is real ---
const unpaid = await fetch(`${BASE}/v1/agents/${AGENT}/score`)
console.log(`  [gate] GET .../score without payment -> HTTP ${unpaid.status}`)
if (unpaid.status !== 402) {
  console.error('  FAIL  expected 402 Payment Required. Is the middleware wired up?')
  process.exit(1)
}
const required = (await unpaid.json()) as { accepts?: unknown[] }
console.log('        accepts:', JSON.stringify(required.accepts?.[0] ?? required).slice(0, 240), '\n')

// --- 3. the paid request ---
console.log(`  [paid] GET .../score  as ${buyerId} ...`)
const t0 = Date.now()
const paid = await fetchWithPay(`${BASE}/v1/agents/${AGENT}/score`)
const ms = Date.now() - t0

if (!paid.ok) {
  console.error(`\n  FAIL  HTTP ${paid.status}: ${(await paid.text()).slice(0, 400)}\n`)
  process.exit(1)
}

const body = await paid.json()
console.log(`  ok     HTTP ${paid.status} in ${ms}ms`)
console.log('        ', JSON.stringify(body, null, 2).split('\n').join('\n         '))

// --- 4. the settlement receipt ---
// x402 v2 uses bare header names (PAYMENT-RESPONSE), not the X- prefixed v1 ones.
// Look them all up rather than guessing.
const paymentHeaders = [...paid.headers.keys()].filter((h) => h.toLowerCase().includes('payment'))
console.log('\n  payment headers:', paymentHeaders.length ? paymentHeaders.join(', ') : '(none)')

const header =
  paid.headers.get('payment-response') ??
  paid.headers.get('x-payment-response') ??
  (paymentHeaders.length ? paid.headers.get(paymentHeaders[0]!) : null)

if (!header) {
  console.log('\n  WARN  no settlement receipt header found.')
  console.log('        all headers:', [...paid.headers.keys()].join(', '), '\n')
  process.exit(1)
}

const settlement = decodePaymentResponseHeader(header)
console.log('\n  === SETTLEMENT ===')
console.log('  success    ', settlement.success)
console.log('  payer      ', settlement.payer)
console.log('  network    ', settlement.network)
console.log('  transaction', settlement.transaction)
if (settlement.errorReason) console.log('  error      ', settlement.errorReason, settlement.errorMessage)

if (settlement.success && settlement.transaction) {
  // Hedera tx ids look like 0.0.1234@1700000000.000000000 — HashScan wants 0.0.1234-1700000000-000000000
  const hashscan = settlement.transaction.replace('@', '-').replace(/\.(\d{9})$/, '-$1')
  console.log(`\n  HashScan: https://hashscan.io/testnet/transaction/${hashscan}`)
  console.log(`  Mirror:   https://testnet.mirrornode.hedera.com/api/v1/transactions/${hashscan}`)
  console.log('\n  GATE 4/4 PASSED — real paid request settled on Hedera testnet.\n')
} else {
  console.error('\n  FAIL  settlement did not succeed.\n')
  process.exit(1)
}
