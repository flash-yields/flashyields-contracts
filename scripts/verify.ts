import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Wallet } from "ethers";
import hre from "hardhat";
import { verifyContract } from "@nomicfoundation/hardhat-verify/verify";
import { getNetworkConfig, type NetworkConfig } from "../config/types.js";

type Deployment = {
  address: `0x${string}`;
  contractName?: string;
  sourceName?: string;
  args?: unknown[];
};

type ArgsContext = {
  config: NetworkConfig;
  deployer: `0x${string}`;
  networkName: string;
  targetDeployment: Deployment;
  getDeployed: (name: string) => Promise<`0x${string}`>;
};

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const MAINNET_UNISWAP_V3_POSITION_MANAGER = "0xC36442b4a4522E871399CD717aBDD847Ab11FE88";
const SEPOLIA_UNISWAP_V3_POSITION_MANAGER = "0x1238536071E1c677A632429e3655c799b22cDA52";

function getUniswapV3PositionManagerAddress(networkName: string): `0x${string}` {
  return networkName === "sepolia_dev"
    ? SEPOLIA_UNISWAP_V3_POSITION_MANAGER
    : MAINNET_UNISWAP_V3_POSITION_MANAGER;
}

function requireField<K extends keyof NetworkConfig>(
  config: NetworkConfig,
  key: K,
): NonNullable<NetworkConfig[K]> {
  const value = config[key];
  if (value === undefined || value === null) {
    throw new Error(`Missing "${String(key)}" in network config`);
  }
  return value as NonNullable<NetworkConfig[K]>;
}

function requireDeploymentArgs(deployment: Deployment, name: string): unknown[] {
  if (!Array.isArray(deployment.args)) {
    throw new Error(`Deployment for "${name}" must include constructor args.`);
  }

  return deployment.args;
}

const CONSTRUCTOR_ARGS: Record<string, (ctx: ArgsContext) => Promise<unknown[]>> = {
  FeeVerifier: async ({ config, deployer }) => [
    requireField(config, "aclManager"),
    config.flashLoanFeeRecipient ?? deployer,
    config.flashLoanFeeBps ?? 9n,
    config.maxStaleness ?? 86_400n,
  ],
  ApprovalFlashLoan: async ({ config, getDeployed }) => [
    requireField(config, "aclManager"),
    await getDeployed("FeeVerifier"),
    requireField(config, "permit2"),
  ],
  LenderRegistry: async ({ getDeployed }) => [
    await getDeployed("ApprovalFlashLoan"),
  ],
  ERC20Vault: async ({ config, getDeployed }) => {
    const initialTokens = config.erc20VaultInitialWhitelistedTokens ?? [];
    const initialMinimumDepositAmounts = config.erc20VaultInitialMinimumDepositAmounts ?? initialTokens.map(() => 0n);
    return [
      await getDeployed("ApprovalFlashLoan"),
      requireField(config, "aclManager"),
      initialTokens,
      initialTokens.map(() => true),
      initialMinimumDepositAmounts,
    ];
  },
  Rebate: async ({ config }) => {
    const initialDailyWithdrawalCapTokens = config.rebateInitialDailyWithdrawalCapTokens ?? [];
    const initialDailyWithdrawalCaps = config.rebateInitialDailyWithdrawalCaps ?? initialDailyWithdrawalCapTokens.map(() => 0n);
    if (initialDailyWithdrawalCapTokens.length !== initialDailyWithdrawalCaps.length) {
      throw new Error("rebateInitialDailyWithdrawalCapTokens and rebateInitialDailyWithdrawalCaps length mismatch.");
    }

    return [
      requireField(config, "aclManager"),
      initialDailyWithdrawalCapTokens,
      initialDailyWithdrawalCaps,
      requireField(config, "weth"),
      requireField(config, "protocolToken"),
      requireField(config, "veToken"),
    ];
  },
  FlashLoanReceiverSimple: async ({ getDeployed }) => [
    await getDeployed("ApprovalFlashLoan")
  ],
  FlashLoanReceiverWithUniswap: async ({ getDeployed, networkName }) => [
    await getDeployed("ApprovalFlashLoan"),
    getUniswapV3PositionManagerAddress(networkName),
  ],
  BestEffortTestToken18A: async ({ targetDeployment }) =>
    requireDeploymentArgs(targetDeployment, "BestEffortTestToken18A"),
  BestEffortTestToken18B: async ({ targetDeployment }) =>
    requireDeploymentArgs(targetDeployment, "BestEffortTestToken18B"),
  BestEffortTestToken6: async ({ targetDeployment }) =>
    requireDeploymentArgs(targetDeployment, "BestEffortTestToken6"),
};

async function readDeployment(networkName: string, name: string): Promise<Deployment> {
  const filePath = path.join(rootDir, "deployments", networkName, `${name}.json`);
  try {
    const raw = await readFile(filePath, "utf8");
    return JSON.parse(raw) as Deployment;
  } catch (err) {
    throw new Error(
      `Could not read deployment for "${name}" on network "${networkName}" at ${filePath}: ${(err as Error).message}`,
    );
  }
}

function resolveDeployerAddress(): `0x${string}` {
  const pk = process.env.DEPLOYER_PRIVATE_KEY;
  if (!pk) {
    throw new Error(
      "DEPLOYER_PRIVATE_KEY env is required to derive the deployer address for fallback constructor args.",
    );
  }
  return new Wallet(pk).address as `0x${string}`;
}

function previewArg(value: unknown): string {
  if (typeof value === "bigint") return value.toString();
  if (Array.isArray(value)) return JSON.stringify(value.map(previewArg));
  if (typeof value === "object" && value !== null) {
    return JSON.stringify(value, (_k, v) => (typeof v === "bigint" ? v.toString() : v));
  }
  return String(value);
}

async function main() {
  const contractName = process.env.CONTRACT;
  if (!contractName) {
    console.error(
      "CONTRACT env variable is required.\n" +
        "Example: CONTRACT=FeeVerifier npx hardhat run scripts/verify.ts --network sepolia_dev\n\n" +
        `Supported contracts: ${Object.keys(CONSTRUCTOR_ARGS).join(", ")}`,
    );
    process.exit(1);
  }

  const buildArgs = CONSTRUCTOR_ARGS[contractName];
  if (!buildArgs) {
    console.error(
      `Unknown contract "${contractName}". Supported: ${Object.keys(CONSTRUCTOR_ARGS).join(", ")}`,
    );
    process.exit(1);
  }

  const connection = await hre.network.connect();
  const networkName = connection.networkName;
  await connection.close();

  const config = getNetworkConfig(networkName);
  const deployer = config.flashLoanFeeRecipient ? ("0x0000000000000000000000000000000000000000" as `0x${string}`) : resolveDeployerAddress();

  const deployedCache = new Map<string, `0x${string}`>();
  const getDeployed = async (name: string): Promise<`0x${string}`> => {
    const cached = deployedCache.get(name);
    if (cached) return cached;
    const dep = await readDeployment(networkName, name);
    if (!dep.address) {
      throw new Error(`Deployment for "${name}" has no address on ${networkName}`);
    }
    deployedCache.set(name, dep.address);
    return dep.address;
  };

  const targetDeployment = await readDeployment(networkName, contractName);
  const { address, contractName: cName, sourceName } = targetDeployment;
  if (!address) {
    throw new Error(`Deployment for "${contractName}" on ${networkName} has no address`);
  }
  const constructorArgs = await buildArgs({ config, deployer, networkName, targetDeployment, getDeployed });
  const fqn = sourceName && cName ? `${sourceName}:${cName}` : undefined;

  console.log("=".repeat(72));
  console.log(`Verifying ${contractName} @ ${address} on ${networkName}`);
  if (fqn) console.log(`Contract: ${fqn}`);
  if (constructorArgs.length > 0) {
    console.log("Constructor args:");
    constructorArgs.forEach((a, i) => console.log(`  [${i}] ${previewArg(a)}`));
  } else {
    console.log("Constructor args: (none)");
  }
  console.log("=".repeat(72));

  await verifyContract(
    {
      address,
      constructorArgs,
      ...(fqn ? { contract: fqn } : {}),
    },
    hre,
  );
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
