import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  Contract,
  type ContractRunner,
  type ContractTransactionReceipt,
  type ContractTransactionResponse,
  getAddress,
  isAddress,
  Wallet,
  ZeroAddress,
} from "ethers";
import { network } from "hardhat";
import type { HardhatEthers } from "@nomicfoundation/hardhat-ethers/types";

type DeploymentLike = {
  address?: string;
};

type ApprovalFlashLoan = Contract & {
  feeVerifier(): Promise<string>;
  blacklistedTokens(token: string): Promise<boolean>;
};

type FeeVerifier = Contract & {
  feeRecipient(): Promise<string>;
  getFeeToken(asset: string): Promise<string>;
  getFeeAmount(asset: string, amount: bigint): Promise<bigint>;
};

type FlashLoanReceiverWithUniswap = Contract & {
  flashLoanContract(): Promise<string>;
  initiateFlashLoanBestEffort(
    lenders: string[],
    assets: string[],
    amounts: bigint[],
    params: string,
  ): Promise<ContractTransactionResponse>;
  connect(runner: ContractRunner | null): FlashLoanReceiverWithUniswap;
};

type LenderRegistry = Contract & {
  approvalFlashLoan(): Promise<string>;
  getAvailableAmountsByTokenAndLenders(token: string, lenders: string[]): Promise<bigint[]>;
};

type Erc20Metadata = Contract & {
  balanceOf(account: string): Promise<bigint>;
  allowance(owner: string, spender: string): Promise<bigint>;
  decimals(): Promise<bigint>;
};

type TokenInfo = {
  contract: Erc20Metadata;
  decimals: number;
};

type EthersNetworkConnection = Awaited<ReturnType<typeof network.connect>> & {
  ethers: HardhatEthers;
};

type LoanRow = {
  lender: `0x${string}`;
  asset: `0x${string}`;
  amountInput: string;
  amount: bigint;
  amountSource: "env" | "registry";
};

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const LENDER_ADDRESSES_ENV = "FLASHLOAN_BEST_EFFORT_LENDER_ADDRESSES";
const TOKEN_ADDRESSES_ENV = "FLASHLOAN_BEST_EFFORT_TOKEN_ADDRESSES";
const AMOUNTS_ENV = "FLASHLOAN_BEST_EFFORT_AMOUNTS";
const UNISWAP_V3_ROUNDING_BUFFER = "1";

function deploymentFilePath(networkName: string, deploymentName: string): string {
  return path.join(rootDir, "deployments", networkName, `${deploymentName}.json`);
}

function normalizePrivateKey(privateKey: string, label: string): string {
  const normalized = privateKey.trim().startsWith("0x")
    ? privateKey.trim()
    : `0x${privateKey.trim()}`;

  if (!/^0x[0-9a-fA-F]{64}$/.test(normalized)) {
    throw new Error(`Invalid ${label} private key format in .env.`);
  }

  return normalized;
}

function loadBorrowerWallet(provider: HardhatEthers["provider"]): Wallet {
  const privateKey = process.env.BORROWER_PRIVATE_KEY?.trim();
  if (!privateKey) {
    throw new Error("Set BORROWER_PRIVATE_KEY in .env.");
  }

  return new Wallet(normalizePrivateKey(privateKey, "borrower"), provider);
}

function splitCommaSeparatedEnv(envName: string): string[] {
  const value = process.env[envName]?.trim();
  if (!value) {
    throw new Error(`Set ${envName} in .env.`);
  }

  const entries = value.split(",").map((entry) => entry.trim());
  if (entries.some((entry) => entry.length === 0)) {
    throw new Error(`${envName} must be a comma-separated list without empty entries.`);
  }

  return entries;
}

function requireAddress(value: string, label: string): `0x${string}` {
  if (!isAddress(value)) {
    throw new Error(`${label} must be a valid EVM address.`);
  }

  const address = getAddress(value);
  if (address === ZeroAddress) {
    throw new Error(`${label} must not be the zero address.`);
  }

  return address as `0x${string}`;
}

function loadAddressList(envName: string): `0x${string}`[] {
  return splitCommaSeparatedEnv(envName).map((entry, index) => (
    requireAddress(entry, `${envName}[${index}]`)
  ));
}

function loadOptionalAmountInputs(): string[] | null {
  const value = process.env[AMOUNTS_ENV]?.trim();
  if (!value || value.toLowerCase() === "null") {
    return null;
  }

  const amountInputs = value.split(",").map((entry) => entry.trim());
  if (amountInputs.some((entry) => entry.length === 0)) {
    throw new Error(`${AMOUNTS_ENV} must be a comma-separated list without empty entries.`);
  }

  for (let i = 0; i < amountInputs.length; i++) {
    if (!/^\d+(\.\d+)?$/.test(amountInputs[i])) {
      throw new Error(`${AMOUNTS_ENV}[${i}] must be a positive decimal token-unit amount.`);
    }
  }

  return amountInputs;
}

function requireDeploymentAddress(deployment: DeploymentLike, deploymentName: string): `0x${string}` {
  const address = deployment.address?.trim() ?? "";
  if (!isAddress(address) || getAddress(address) === ZeroAddress) {
    throw new Error(`${deploymentName} deployment must contain a valid non-zero address.`);
  }

  return getAddress(address) as `0x${string}`;
}

async function readDeployment(networkName: string, deploymentName: string): Promise<DeploymentLike> {
  const filePath = deploymentFilePath(networkName, deploymentName);
  try {
    return JSON.parse(await readFile(filePath, "utf8")) as DeploymentLike;
  } catch (err) {
    throw new Error(
      `Could not read ${deploymentName} deployment for ${networkName} at ${filePath}: ${(err as Error).message}`,
    );
  }
}

async function ensureNativeBalance(ethers: HardhatEthers, address: string, label: string) {
  const balance = await ethers.provider.getBalance(address);
  if (balance === 0n) {
    throw new Error(`${label} ${address} has no native token balance to pay transaction gas.`);
  }
}

async function ensureCode(ethers: HardhatEthers, address: string, label: string) {
  const code = await ethers.provider.getCode(address);
  if (code === "0x") {
    throw new Error(`${label} ${address} has no deployed code.`);
  }
}

async function waitForTransaction(
  transactionPromise: Promise<ContractTransactionResponse>,
  label: string,
): Promise<ContractTransactionReceipt | null> {
  const transaction = await transactionPromise;
  console.log(`${label}: txHash=${transaction.hash}`);
  const receipt = await transaction.wait();
  console.log(`${label}: gasUsed=${receipt?.gasUsed.toString() ?? "unknown"}`);
  return receipt;
}

async function getTokenInfo(
  ethers: HardhatEthers,
  borrower: Wallet,
  cache: Map<string, TokenInfo>,
  tokenAddress: `0x${string}`,
): Promise<TokenInfo> {
  const cacheKey = tokenAddress.toLowerCase();
  const cached = cache.get(cacheKey);
  if (cached) {
    return cached;
  }

  await ensureCode(ethers, tokenAddress, "Token");

  const contract = await ethers.getContractAt("contracts/dependencies/openzeppelin-v5.0.1/token/ERC20/extensions/IERC20Metadata.sol:IERC20Metadata", tokenAddress, borrower) as Erc20Metadata;
  const decimals = Number(await contract.decimals());
  if (!Number.isInteger(decimals) || decimals < 0 || decimals > 255) {
    throw new Error(`Token ${tokenAddress} returned invalid decimals ${decimals}.`);
  }

  const tokenInfo = { contract, decimals };
  cache.set(cacheKey, tokenInfo);
  return tokenInfo;
}

function parseTokenAmount(
  ethers: HardhatEthers,
  amountInput: string,
  decimals: number,
  label: string,
): bigint {
  try {
    const amount = ethers.parseUnits(amountInput, decimals);
    if (amount === 0n) {
      throw new Error("amount resolves to zero");
    }

    return amount;
  } catch (err) {
    throw new Error(
      `Invalid ${label}=${amountInput} for ${decimals}-decimal token: ${(err as Error).message}`,
    );
  }
}

async function loadLoanRows(
  ethers: HardhatEthers,
  borrower: Wallet,
  tokenCache: Map<string, TokenInfo>,
  amountInputs: string[] | null,
  lenderRegistry: LenderRegistry | null,
): Promise<LoanRow[]> {
  const lenders = loadAddressList(LENDER_ADDRESSES_ENV);
  const assets = loadAddressList(TOKEN_ADDRESSES_ENV);

  if (lenders.length !== assets.length) {
    throw new Error(`${LENDER_ADDRESSES_ENV} and ${TOKEN_ADDRESSES_ENV} must have the same number of entries.`);
  }

  if (amountInputs && amountInputs.length !== lenders.length) {
    throw new Error(
      `${AMOUNTS_ENV} must have the same number of entries as ${LENDER_ADDRESSES_ENV} and ${TOKEN_ADDRESSES_ENV}.`,
    );
  }

  if (!amountInputs && !lenderRegistry) {
    throw new Error(`LenderRegistry deployment is required when ${AMOUNTS_ENV} is blank or null.`);
  }

  const registryAmounts = amountInputs
    ? null
    : await loadAmountsFromRegistry(lenderRegistry!, lenders, assets);

  return Promise.all(lenders.map(async (lender, index) => {
    const asset = assets[index];
    const tokenInfo = await getTokenInfo(ethers, borrower, tokenCache, asset);
    const amountInput = amountInputs?.[index];
    const registryAmount = registryAmounts?.[index];
    const amount = amountInput
      ? parseTokenAmount(ethers, amountInput, tokenInfo.decimals, `${AMOUNTS_ENV}[${index}]`)
      : registryAmount ?? 0n;

    return {
      lender,
      asset,
      amountInput: amountInput ?? amount.toString(),
      amount,
      amountSource: amountInput ? "env" : "registry",
    };
  }));
}

async function loadAmountsFromRegistry(
  lenderRegistry: LenderRegistry,
  lenders: `0x${string}`[],
  assets: `0x${string}`[],
): Promise<bigint[]> {
  const amounts = new Array<bigint>(lenders.length).fill(0n);
  const groupedRows = new Map<string, { asset: `0x${string}`; lenders: `0x${string}`[]; indexes: number[] }>();
  const seenPairs = new Set<string>();

  for (let i = 0; i < lenders.length; i++) {
    const pairKey = `${assets[i].toLowerCase()}:${lenders[i].toLowerCase()}`;
    if (seenPairs.has(pairKey)) {
      throw new Error(
        `Duplicate lender/token row at index ${i}. Registry amount mode would request the full available amount twice.`,
      );
    }
    seenPairs.add(pairKey);

    const tokenKey = assets[i].toLowerCase();
    const group = groupedRows.get(tokenKey);
    if (group) {
      group.lenders.push(lenders[i]);
      group.indexes.push(i);
    } else {
      groupedRows.set(tokenKey, {
        asset: assets[i],
        lenders: [lenders[i]],
        indexes: [i],
      });
    }
  }

  for (const group of groupedRows.values()) {
    const availableAmounts = await lenderRegistry.getAvailableAmountsByTokenAndLenders(group.asset, group.lenders);
    if (availableAmounts.length !== group.lenders.length) {
      throw new Error(`LenderRegistry returned an invalid amount count for token ${group.asset}.`);
    }

    for (let i = 0; i < availableAmounts.length; i++) {
      amounts[group.indexes[i]] = availableAmounts[i];
    }
  }

  return amounts;
}

function addRequiredReceiverBuffer(
  buffers: Map<string, { token: Erc20Metadata; amount: bigint; address: `0x${string}` }>,
  token: Erc20Metadata,
  address: `0x${string}`,
  amount: bigint,
) {
  const key = address.toLowerCase();
  const existing = buffers.get(key);
  if (existing) {
    existing.amount += amount;
    return;
  }

  buffers.set(key, { token, amount, address });
}

function firstTwoDistinctAssets(rows: LoanRow[]): `0x${string}`[] {
  const assets: `0x${string}`[] = [];
  const seen = new Set<string>();

  for (const row of rows) {
    const key = row.asset.toLowerCase();
    if (seen.has(key)) continue;

    seen.add(key);
    assets.push(row.asset);

    if (assets.length === 2) {
      break;
    }
  }

  return assets;
}

async function preflightRows(params: {
  ethers: HardhatEthers;
  borrower: Wallet;
  tokenCache: Map<string, TokenInfo>;
  flashLoan: ApprovalFlashLoan;
  feeVerifier: FeeVerifier;
  approvalFlashLoanAddress: `0x${string}`;
  receiverAddress: `0x${string}`;
  rows: LoanRow[];
}): Promise<LoanRow[]> {
  const {
    ethers,
    borrower,
    tokenCache,
    flashLoan,
    feeVerifier,
    approvalFlashLoanAddress,
    receiverAddress,
    rows,
  } = params;
  const acceptedRows: LoanRow[] = [];
  const requiredReceiverBuffers = new Map<string, { token: Erc20Metadata; amount: bigint; address: `0x${string}` }>();

  console.log("Configured rows:");
  for (let i = 0; i < rows.length; i++) {
    const row = rows[i];
    const tokenInfo = await getTokenInfo(ethers, borrower, tokenCache, row.asset);
    const [balance, allowance, blacklisted] = await Promise.all([
      tokenInfo.contract.balanceOf(row.lender),
      tokenInfo.contract.allowance(row.lender, approvalFlashLoanAddress),
      flashLoan.blacklistedTokens(row.asset),
    ]);

    const skipped = row.amount === 0n || blacklisted || allowance < row.amount || balance < row.amount;
    const skippedReason = row.amount === 0n
      ? "zero amount"
      : blacklisted
      ? "blacklisted"
      : allowance < row.amount
        ? "insufficient allowance"
        : balance < row.amount
          ? "insufficient balance"
          : "";
    const status = skipped ? `skipped (${skippedReason})` : "accepted";
    console.log(
      `${i + 1}: lender=${row.lender} token=${row.asset} amount=${row.amount.toString()} ` +
      `source=${row.amountSource} balance=${balance.toString()} allowance=${allowance.toString()} status=${status}`,
    );

    if (row.amount === 0n || blacklisted) {
      continue;
    }

    if (allowance < row.amount || balance < row.amount) continue;

    const feeTokenAddress = requireAddress(await feeVerifier.getFeeToken(row.asset), `fee token for row ${i + 1}`);
    const feeAmount = await feeVerifier.getFeeAmount(row.asset, row.amount);
    if (feeAmount > 0n) {
      const feeTokenInfo = await getTokenInfo(ethers, borrower, tokenCache, feeTokenAddress);
      addRequiredReceiverBuffer(requiredReceiverBuffers, feeTokenInfo.contract, feeTokenAddress, feeAmount);
    }

    acceptedRows.push(row);
  }

  if (acceptedRows.length === 0) {
    throw new Error("No rows have a positive available amount for best-effort; the contract would revert NoValidLenders.");
  }

  const liquidityAssets = firstTwoDistinctAssets(acceptedRows);
  if (liquidityAssets.length === 2) {
    for (const asset of liquidityAssets) {
      const tokenInfo = await getTokenInfo(ethers, borrower, tokenCache, asset);
      addRequiredReceiverBuffer(
        requiredReceiverBuffers,
        tokenInfo.contract,
        asset,
        parseTokenAmount(ethers, UNISWAP_V3_ROUNDING_BUFFER, tokenInfo.decimals, "UNISWAP_V3_ROUNDING_BUFFER"),
      );
    }
  }

  for (const { token, amount, address } of requiredReceiverBuffers.values()) {
    const receiverBalance = await token.balanceOf(receiverAddress);
    console.log(
      `Receiver buffer ${address}: required=${amount.toString()} balance=${receiverBalance.toString()}`,
    );
    if (receiverBalance < amount) {
      throw new Error(
        `FlashLoanReceiverWithUniswap needs at least ${amount.toString()} of ${address} before this script runs.`,
      );
    }
  }

  return acceptedRows;
}

function logFlashLoanEvent(flashLoan: ApprovalFlashLoan, receipt: ContractTransactionReceipt | null) {
  if (!receipt) {
    return;
  }

  for (const log of receipt.logs) {
    try {
      const parsedLog = flashLoan.interface.parseLog(log);
      if (parsedLog?.name !== "FlashLoan") {
        continue;
      }

      const lenders = parsedLog.args.lenders as string[];
      const assets = parsedLog.args.assets as string[];
      const amounts = parsedLog.args.amounts as bigint[];
      const feeAssets = parsedLog.args.feeAssets as string[];
      const aggregatedFees = parsedLog.args.aggregatedFees as bigint[];

      console.log("Accepted rows from FlashLoan event:");
      for (let i = 0; i < lenders.length; i++) {
        console.log(`${i + 1}: lender=${lenders[i]} token=${assets[i]} amount=${amounts[i].toString()}`);
      }
      console.log(`feeAssets=${feeAssets.join(",")}`);
      console.log(`aggregatedFees=${aggregatedFees.map((fee) => fee.toString()).join(",")}`);
      return;
    } catch {
      continue;
    }
  }
}

async function main() {
  const connection = await network.connect() as EthersNetworkConnection;
  const { ethers } = connection;

  try {
    const networkName = connection.networkName;
    const borrower = loadBorrowerWallet(ethers.provider);
    const tokenCache = new Map<string, TokenInfo>();
    const amountInputs = loadOptionalAmountInputs();
    const approvalFlashLoanAddress = requireDeploymentAddress(
      await readDeployment(networkName, "ApprovalFlashLoan"),
      "ApprovalFlashLoan",
    );
    const receiverAddress = requireDeploymentAddress(
      await readDeployment(networkName, "FlashLoanReceiverWithUniswap"),
      "FlashLoanReceiverWithUniswap",
    );

    await ensureCode(ethers, approvalFlashLoanAddress, "ApprovalFlashLoan");
    await ensureCode(ethers, receiverAddress, "FlashLoanReceiverWithUniswap");

    const flashLoan = await ethers.getContractAt(
      "ApprovalFlashLoan",
      approvalFlashLoanAddress,
      borrower,
    ) as ApprovalFlashLoan;
    const receiver = await ethers.getContractAt(
      "FlashLoanReceiverWithUniswap",
      receiverAddress,
      borrower,
    ) as FlashLoanReceiverWithUniswap;
    const receiverFlashLoanAddress = getAddress(await receiver.flashLoanContract());
    if (receiverFlashLoanAddress !== approvalFlashLoanAddress) {
      throw new Error(
        `FlashLoanReceiverWithUniswap points to ${receiverFlashLoanAddress}, expected ${approvalFlashLoanAddress}.`,
      );
    }

    const feeVerifierAddress = getAddress(await flashLoan.feeVerifier()) as `0x${string}`;
    await ensureCode(ethers, feeVerifierAddress, "FeeVerifier");
    const feeVerifier = await ethers.getContractAt("FeeVerifier", feeVerifierAddress, borrower) as FeeVerifier;
    const feeRecipient = getAddress(await feeVerifier.feeRecipient());

    let lenderRegistryAddress: `0x${string}` | null = null;
    let lenderRegistry: LenderRegistry | null = null;
    if (!amountInputs) {
      lenderRegistryAddress = requireDeploymentAddress(
        await readDeployment(networkName, "LenderRegistry"),
        "LenderRegistry",
      );
      await ensureCode(ethers, lenderRegistryAddress, "LenderRegistry");
      lenderRegistry = await ethers.getContractAt(
        "LenderRegistry",
        lenderRegistryAddress,
        borrower,
      ) as LenderRegistry;

      const registryFlashLoanAddress = getAddress(await lenderRegistry.approvalFlashLoan());
      if (registryFlashLoanAddress !== approvalFlashLoanAddress) {
        throw new Error(
          `LenderRegistry points to ${registryFlashLoanAddress}, expected ${approvalFlashLoanAddress}.`,
        );
      }
    }

    const rows = await loadLoanRows(ethers, borrower, tokenCache, amountInputs, lenderRegistry);

    console.log(`network=${networkName}`);
    console.log(`amountMode=${amountInputs ? "env" : "lender-registry"}`);
    console.log(`borrower=${borrower.address}`);
    console.log(`approvalFlashLoan=${approvalFlashLoanAddress}`);
    console.log(`FlashLoanReceiverWithUniswap=${receiverAddress}`);
    if (lenderRegistryAddress) console.log(`LenderRegistry=${lenderRegistryAddress}`);
    console.log(`feeVerifier=${feeVerifierAddress}`);
    console.log(`feeRecipient=${feeRecipient}`);

    await ensureNativeBalance(ethers, borrower.address, "Borrower");
    const acceptedRows = await preflightRows({
      ethers,
      borrower,
      tokenCache,
      flashLoan,
      feeVerifier,
      approvalFlashLoanAddress,
      receiverAddress,
      rows,
    });
    const executableRows = amountInputs ? rows : acceptedRows;

    const receiverWithBorrower = receiver.connect(borrower) as FlashLoanReceiverWithUniswap;
    const receipt = await waitForTransaction(
      receiverWithBorrower.initiateFlashLoanBestEffort(
        executableRows.map((row) => row.lender),
        executableRows.map((row) => row.asset),
        executableRows.map((row) => row.amount),
        "0x",
      ),
      "initiateFlashLoanBestEffort",
    );

    logFlashLoanEvent(flashLoan, receipt);
    console.log("Completed borrower-only best-effort flash loan flow.");
    console.log(`flashLoanTx=${receipt?.hash ?? "unknown"}`);
  } finally {
    await connection.close();
  }
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
