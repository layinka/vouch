/**
 * Deploys the two Vouch evidence contracts to Sepolia and copies their ABIs into
 * packages/contracts/abis/ so the indexer and subgraph read from one place.
 *
 *   VouchAttestations  — counterparties record job outcomes; agents cannot rate
 *                        themselves (enforced against the ERC-8004 owner)
 *   VouchScoreAnchor   — the scorer publishes every score it writes, giving the
 *                        subgraph a time series instead of only a latest value
 *
 * VouchScoreAnchor's constructor takes SCORER_ADDRESS, deliberately the same key
 * that holds `agent:score` write permission on each PermissionedResolver. One
 * principal, one authority, enforced in two places.
 *
 * Idempotent. Run: node --env-file=.env spike/12-deploy-vouch.ts
 */
import { readFileSync, writeFileSync, existsSync } from 'node:fs'
import { createPublicClient, createWalletClient, http, type Hex, type Abi } from 'viem'
import { privateKeyToAccount } from 'viem/accounts'
import { sepolia } from 'viem/chains'

const RPC = process.env.SEPOLIA_RPC_URL ?? 'https://ethereum-sepolia-rpc.publicnode.com'
const ART = 'packages/contracts/artifacts/contracts'
const ABIS = 'packages/contracts/abis'
const OUT = 'deployments/sepolia.json'

const A = JSON.parse(readFileSync(`${ABIS}/_addresses.json`, 'utf8')) as { erc8004: Record<string, Hex> }

type Deployment = {
  agents: Record<string, unknown>
  vouchAttestations?: Hex
  vouchScoreAnchor?: Hex
  vouchAttestationsBlock?: string
  vouchScoreAnchorBlock?: string
}
const state: Deployment = JSON.parse(readFileSync(OUT, 'utf8'))
const save = () => writeFileSync(OUT, JSON.stringify(state, null, 2) + '\n')

const deployer = privateKeyToAccount(process.env.DEPLOYER_PRIVATE_KEY as Hex)
const scorer = process.env.SCORER_ADDRESS as Hex
if (!scorer) throw new Error('SCORER_ADDRESS missing')

const pub = createPublicClient({ chain: sepolia, transport: http(RPC) })
const wallet = createWalletClient({ account: deployer, chain: sepolia, transport: http(RPC) })

type Artifact = { abi: Abi; bytecode: Hex; contractName: string }
const artifact = (name: string): Artifact =>
  JSON.parse(readFileSync(`${ART}/${name}.sol/${name}.json`, 'utf8'))

console.log('\n=== Deploy Vouch evidence contracts ===\n')
console.log(`  deployer  ${deployer.address}`)
console.log(`  scorer    ${scorer}`)
console.log(`  identity  ${A.erc8004.IdentityRegistry}\n`)

async function deploy(name: string, args: unknown[], key: 'vouchAttestations' | 'vouchScoreAnchor') {
  if (state[key]) {
    console.log(`  ok    ${name} already deployed: ${state[key]}`)
  } else {
    const art = artifact(name)
    console.log(`  ..    deploying ${name}`)
    const hash = await wallet.deployContract({ abi: art.abi, bytecode: art.bytecode, args })
    console.log(`        https://sepolia.etherscan.io/tx/${hash}`)
    const receipt = await pub.waitForTransactionReceipt({ hash })
    if (!receipt.contractAddress) throw new Error(`${name}: no contractAddress in receipt`)
    state[key] = receipt.contractAddress
    state[`${key}Block` as 'vouchAttestationsBlock'] = String(receipt.blockNumber)
    save()
    console.log(`  ok    ${name} ${receipt.contractAddress} (block ${receipt.blockNumber})`)
  }
  // keep ABIs in one place for the indexer + subgraph
  const art = artifact(name)
  writeFileSync(`${ABIS}/${name}.json`, JSON.stringify(art.abi, null, 2) + '\n')
}

await deploy('VouchAttestations', [A.erc8004.IdentityRegistry], 'vouchAttestations')
await deploy('VouchScoreAnchor', [scorer], 'vouchScoreAnchor')

// ---- sanity: read back the constructor wiring ----
console.log('\n  --- verifying constructor wiring ---')
const anchorAbi = artifact('VouchScoreAnchor').abi
const onChainScorer = (await pub.readContract({
  address: state.vouchScoreAnchor!, abi: anchorAbi, functionName: 'scorer',
})) as Hex
console.log(`        VouchScoreAnchor.scorer() = ${onChainScorer}`)
console.log(`        expected                  = ${scorer}`)
const match = onChainScorer.toLowerCase() === scorer.toLowerCase()

const attAbi = artifact('VouchAttestations').abi
const onChainIdentity = (await pub.readContract({
  address: state.vouchAttestations!, abi: attAbi, functionName: 'identityRegistry',
})) as Hex
console.log(`        VouchAttestations.identityRegistry() = ${onChainIdentity}`)

console.log(`\n  ${match ? 'GATE PASSED' : 'MISMATCH — scorer is wrong'}\n`)
console.log('  Verify on Etherscan:')
console.log(`    cd packages/contracts && pnpm exec hardhat verify --network sepolia ${state.vouchAttestations} ${A.erc8004.IdentityRegistry}`)
console.log(`    cd packages/contracts && pnpm exec hardhat verify --network sepolia ${state.vouchScoreAnchor} ${scorer}\n`)

if (!existsSync(`${ABIS}/VouchAttestations.json`)) throw new Error('ABI copy failed')
