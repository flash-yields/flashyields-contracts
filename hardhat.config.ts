import { config as loadEnv } from "dotenv";
import { defineConfig } from "hardhat/config";
import hardhatDeploy from "hardhat-deploy";
import hardhatEthers from "@nomicfoundation/hardhat-ethers";
import hardhatMocha from "@nomicfoundation/hardhat-mocha";
import hardhatEthersChaiMatchers from "@nomicfoundation/hardhat-ethers-chai-matchers";
import hardhatNetworkHelpers from "@nomicfoundation/hardhat-network-helpers";
import hardhatVerify from "@nomicfoundation/hardhat-verify";

loadEnv();

const deployerPrivateKey = process.env.DEPLOYER_PRIVATE_KEY ?? "";
const privateKeyArr = [deployerPrivateKey];

function getRpcUrl(networkName: string): string {
  const base = networkName.split("_")[0].toUpperCase();
  return process.env[`${base}_RPC_URL`] ?? "";
}

function httpNetwork(networkName: string) {
  return {
    type: "http" as const,
    chainType: "l1" as const,
    url: getRpcUrl(networkName),
    accounts: privateKeyArr,
  };
}

const networks = {
  hardhat: {
    type: "edr-simulated" as const,
    chainType: "l1" as const,
  },
  node: {
    type: "edr-simulated" as const,
    chainType: "l1" as const,
    initialBaseFeePerGas: 1n
  },
  sepolia_dev: httpNetwork("sepolia_dev"),
  mainnet_prod: httpNetwork("mainnet_prod"),
  ...(process.env.MAINNET_RPC_URL
    ? {
        mainnet_fork: {
          type: "edr-simulated" as const,
          chainType: "l1" as const,
          forking: {
            url: process.env.MAINNET_RPC_URL,
            blockNumber: 24_984_062,
          },
          accounts: {
            mnemonic: "rug worry bitter labor suffer hello service conduct spawn announce icon impulse", // not for production, to avoid reusing the publicly known seed phrase
          }
        },
      }
    : {}),
};

export default defineConfig({
  plugins: [
    hardhatDeploy,
    hardhatEthers,
    hardhatMocha,
    hardhatEthersChaiMatchers,
    hardhatNetworkHelpers,
    hardhatVerify,
  ],
  solidity: {
    compilers: [
      {
        version: "0.8.27",
        settings: {
          viaIR: true,
          optimizer: {
            enabled: true,
            runs: 20000,
          },
        }
      },
      {
        version: "0.8.12",
        settings: {
          optimizer: {
            enabled: true,
            runs: 20000,
          },
        },
      },
    ]
  },
  paths: {
    sources: "./contracts",
    tests: "./test",
    cache: "./cache",
    artifacts: "./artifacts",
  },
  verify: {
    etherscan: {
      apiKey: process.env.ETHERSCAN_API_KEY ?? "",
    },
  },
  networks
});
