import { defineConfig } from 'hardhat/config'
import hardhatToolboxViem from '@nomicfoundation/hardhat-toolbox-viem'

// Hardhat 3 config is ESM-only and uses a `plugins` array.
export default defineConfig({
  plugins: [hardhatToolboxViem],
  solidity: {
    version: '0.8.28',
    settings: { optimizer: { enabled: true, runs: 200 }, evmVersion: 'cancun' },
  },
  networks: {
    sepolia: {
      type: 'http',
      chainType: 'l1',
      url: process.env.SEPOLIA_RPC_URL ?? 'https://ethereum-sepolia-rpc.publicnode.com',
      accounts: process.env.DEPLOYER_PRIVATE_KEY ? [process.env.DEPLOYER_PRIVATE_KEY] : [],
    },
  },
  verify: {
    etherscan: { apiKey: process.env.ETHERSCAN_API_KEY ?? '' },
  },
})
