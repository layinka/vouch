/**
 * Spreads Sepolia ETH from DEPLOYER to SCORER and AGENT.
 *
 * Most faucets are rate-limited per IP or per social account, so getting three
 * addresses funded independently can take a while. Fund DEPLOYER once, then run
 * this to top the other two up to their targets.
 *
 * Idempotent: only sends the shortfall, skips anything already funded.
 *
 * Run: node --env-file=.env spike/06b-fund-roles.ts
 */
import { createWalletClient, createPublicClient, http, parseEther, formatEther } from 'viem'
import { privateKeyToAccount } from 'viem/accounts'
import { sepolia } from 'viem/chains'

const RPC = process.env.SEPOLIA_RPC_URL ?? 'https://ethereum-sepolia-rpc.publicnode.com'

const deployerKey = process.env.DEPLOYER_PRIVATE_KEY as `0x${string}` | undefined
if (!deployerKey) {
  console.error('\n  FAIL  DEPLOYER_PRIVATE_KEY missing. Run: pnpm keys:gen\n')
  process.exit(1)
}

const TARGETS = [
  { name: 'SCORER', address: process.env.SCORER_ADDRESS, want: parseEther('0.05') },
  { name: 'AGENT', address: process.env.AGENT_ADDRESS, want: parseEther('0.02') },
] as const

const deployer = privateKeyToAccount(deployerKey)
const publicClient = createPublicClient({ chain: sepolia, transport: http(RPC) })
const wallet = createWalletClient({ account: deployer, chain: sepolia, transport: http(RPC) })

console.log('\n=== Spread Sepolia ETH from DEPLOYER ===\n')

let balance = await publicClient.getBalance({ address: deployer.address })
console.log(`  DEPLOYER ${deployer.address}`)
console.log(`  balance  ${formatEther(balance)} ETH\n`)

if (balance === 0n) {
  console.error('  FAIL  DEPLOYER is empty. Fund it first:')
  console.error('        https://cloud.google.com/application/web3/faucet/ethereum/sepolia\n')
  process.exit(1)
}

// Keep a working float for deployments; never drain the deployer.
const RESERVE = parseEther('0.1')

for (const t of TARGETS) {
  if (!t.address) {
    console.log(`  skip  ${t.name} — no address in .env`)
    continue
  }
  const addr = t.address as `0x${string}`
  const have = await publicClient.getBalance({ address: addr })

  if (have >= t.want) {
    console.log(`  ok    ${t.name.padEnd(8)} already has ${formatEther(have)} ETH`)
    continue
  }

  const shortfall = t.want - have
  const spendable = balance > RESERVE ? balance - RESERVE : 0n
  const amount = shortfall < spendable ? shortfall : spendable

  if (amount === 0n) {
    console.log(`  WARN  ${t.name.padEnd(8)} needs ${formatEther(shortfall)} ETH but DEPLOYER has no spare`)
    console.log(`        (reserving ${formatEther(RESERVE)} ETH for deployments)`)
    continue
  }

  console.log(`  ..    ${t.name.padEnd(8)} sending ${formatEther(amount)} ETH`)
  const hash = await wallet.sendTransaction({ to: addr, value: amount })
  const receipt = await publicClient.waitForTransactionReceipt({ hash })
  console.log(`  ok    ${t.name.padEnd(8)} ${receipt.status} — https://sepolia.etherscan.io/tx/${hash}`)

  balance = await publicClient.getBalance({ address: deployer.address })
}

console.log('\n  --- final ---')
console.log(`  DEPLOYER ${formatEther(await publicClient.getBalance({ address: deployer.address }))} ETH`)
for (const t of TARGETS) {
  if (!t.address) continue
  const have = await publicClient.getBalance({ address: t.address as `0x${string}` })
  console.log(`  ${t.name.padEnd(8)} ${formatEther(have)} ETH`)
}
console.log()
