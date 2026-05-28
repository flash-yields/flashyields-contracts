import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  Contract,
  type ContractRunner,
  type ContractTransactionReceipt,
  type ContractTransactionResponse,
  type BigNumberish,
  type BaseContractMethod,
  getAddress,
  isAddress,
  type TypedDataDomain,
  type TypedDataField,
  Wallet,
  ZeroAddress,
} from "ethers";
import { network } from "hardhat";
import type { HardhatEthers } from "@nomicfoundation/hardhat-ethers/types";

type ArtifactLike = {
  _format?: string;
  abi: readonly unknown[];
  bytecode: string;
  deployedBytecode?: string;
  contractName: string;
  sourceName: string;
  linkReferences?: unknown;
  deployedLinkReferences?: unknown;
  immutableReferences?: unknown;
  inputSourceName?: string;
  buildInfoId?: string;
};

type DeploymentLike = {
  address?: string;
};

type TestToken = Contract & {
  mint(account: string, amount: bigint): Promise<ContractTransactionResponse>;
  balanceOf(account: string): Promise<bigint>;
  allowance(owner: string, spender: string): Promise<bigint>;
  approve(spender: string, amount: bigint): Promise<ContractTransactionResponse>;
  decimals(): Promise<bigint>;
  connect(runner: ContractRunner | null): TestToken;
};

type ApprovalFlashLoan = Contract & {
  feeVerifier(): Promise<string>;
  PERMIT2(): Promise<string>;
};

type FeeVerifier = Contract & {
  feeRecipient(): Promise<string>;
  getFeeToken(asset: string): Promise<string>;
  getFeeAmount(asset: string, amount: bigint): Promise<bigint>;
};

type FlashLoanReceiverWithUniswap = Contract & {
  flashLoanContract(): Promise<string>;
  owner(): Promise<string>;
  initiateFlashLoanBestEffort: BaseContractMethod<
    [string[], string[], bigint[], string],
    void,
    ContractTransactionResponse
  >;
  initiateFlashLoanBestEffortMix: BaseContractMethod<
    [string[], string[], bigint[], Permit2SignatureData[], string],
    void,
    ContractTransactionResponse
  >;
  connect(runner: ContractRunner | null): FlashLoanReceiverWithUniswap;
};

type AllowanceTransfer = Contract & {
  allowance(owner: string, token: string, spender: string): Promise<[bigint, bigint, bigint]>;
};

type TokenConfig = {
  deploymentName: string;
  name: string;
  symbol: string;
  decimals: number;
};

type TokenDeployment = {
  config: TokenConfig;
  contract: TestToken;
  address: `0x${string}`;
};

type FlashLoanMode = "three-tokens" | "one-token";
type Lender2ApprovalMode = "onchain" | "permit2";

type Permit2SignatureData = {
  amount: BigNumberish;
  expiration: BigNumberish;
  nonce: BigNumberish;
  sigDeadline: BigNumberish;
  signature: string;
};

type PermitSingle = {
  details: {
    token: string;
    amount: BigNumberish;
    expiration: BigNumberish;
    nonce: BigNumberish;
  };
  spender: string;
  sigDeadline: BigNumberish;
};

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const LENDER_COUNT = 3;
const FLASH_LOAN_MODE_ENV = "FLASHLOAN_BEST_EFFORT_MODE";
const LENDER_2_APPROVAL_MODE_ENV = "LENDER_2_APPROVAL_MODE";
const LOAN_AMOUNT_ENV = "LOAN_AMOUNT";
const MINT_AMOUNT = "10000";
const DEFAULT_LOAN_AMOUNT = "3500";
const PERMIT2_VALIDITY_SECONDS = 3600n;
const UNISWAP_V3_ROUNDING_BUFFER = "1";
const PERMIT2_TYPES = {
  PermitSingle: [
    { name: "details", type: "PermitDetails" },
    { name: "spender", type: "address" },
    { name: "sigDeadline", type: "uint256" },
  ],
  PermitDetails: [
    { name: "token", type: "address" },
    { name: "amount", type: "uint160" },
    { name: "expiration", type: "uint48" },
    { name: "nonce", type: "uint48" },
  ],
} satisfies Record<string, TypedDataField[]>;

const TOKEN_CONFIGS: TokenConfig[] = [
  {
    deploymentName: "BestEffortTestToken18A",
    name: "Best Effort Test Token 18A",
    symbol: "BET18A",
    decimals: 18,
  },
  {
    deploymentName: "BestEffortTestToken18B",
    name: "Best Effort Test Token 18B",
    symbol: "BET18B",
    decimals: 18,
  },
  {
    deploymentName: "BestEffortTestToken6",
    name: "Best Effort Test Token 6",
    symbol: "BET6",
    decimals: 6,
  },
];

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

function splitPrivateKeyList(value: string | undefined): string[] {
  return (value ?? "")
    .split(/[\s,]+/)
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
}

function getIndexedLenderPrivateKey(index: number): string | undefined {
  return (
    process.env[`LENDER_${index}_PRIVATE_KEY`] ??
    process.env[`LENDER${index}_PRIVATE_KEY`] ??
    process.env[`LENDER_PRIVATE_KEY_${index}`]
  );
}

function loadFlashLoanMode(): FlashLoanMode {
  const rawValue = process.env[FLASH_LOAN_MODE_ENV]?.trim().toLowerCase();
  if (!rawValue || ["3-token", "3-tokens"].includes(rawValue)) {
    return "three-tokens";
  }

  if (["1-token", "1-tokens"].includes(rawValue)) {
    return "one-token";
  }

  throw new Error(
    `Invalid ${FLASH_LOAN_MODE_ENV}=${process.env[FLASH_LOAN_MODE_ENV]}. Use three-tokens or one-token.`,
  );
}

function loadLender2ApprovalMode(): Lender2ApprovalMode {
  const rawValue = process.env[LENDER_2_APPROVAL_MODE_ENV]?.trim().toLowerCase();
  if (!rawValue || ["onchain", "on-chain", "direct", "approval", "erc20"].includes(rawValue)) {
    return "onchain";
  }

  if (["permit2", "permit"].includes(rawValue)) {
    return "permit2";
  }

  throw new Error(
    `Invalid ${LENDER_2_APPROVAL_MODE_ENV}=${process.env[LENDER_2_APPROVAL_MODE_ENV]}. Use onchain or permit2.`,
  );
}

function loadLoanAmount(): string {
  return process.env[LOAN_AMOUNT_ENV]?.trim() || DEFAULT_LOAN_AMOUNT;
}

function emptyPermit(): Permit2SignatureData {
  return {
    amount: 0n,
    expiration: 0n,
    nonce: 0n,
    sigDeadline: 0n,
    signature: "0x",
  };
}

function firstTwoDistinctLiquidityTokens(loanEntries: { tokenDeployment: TokenDeployment }[]): TokenDeployment[] {
  const liquidityTokens: TokenDeployment[] = [];
  const seen = new Set<string>();

  for (const { tokenDeployment } of loanEntries) {
    const key = tokenDeployment.address.toLowerCase();
    if (seen.has(key)) continue;

    seen.add(key);
    liquidityTokens.push(tokenDeployment);

    if (liquidityTokens.length === 2) {
      break;
    }
  }

  return liquidityTokens;
}

function loadLenderWallets(provider: HardhatEthers["provider"]): Wallet[] {
  const privateKeysFromList = splitPrivateKeyList(process.env.LENDER_PRIVATE_KEYS);
  const privateKeys = privateKeysFromList.length > 0
    ? privateKeysFromList
    : Array.from({ length: LENDER_COUNT }, (_value, index) => getIndexedLenderPrivateKey(index + 1) ?? "");

  if (privateKeys.length !== LENDER_COUNT || privateKeys.some((privateKey) => privateKey.trim() === "")) {
    throw new Error(
      "Set three lender private keys in .env with LENDER_PRIVATE_KEYS=pk1,pk2,pk3 " +
      "or LENDER_1_PRIVATE_KEY, LENDER_2_PRIVATE_KEY, and LENDER_3_PRIVATE_KEY.",
    );
  }

  const wallets = privateKeys.map((privateKey, index) => (
    new Wallet(normalizePrivateKey(privateKey, `lender ${index + 1}`), provider)
  ));

  return wallets;
}

function loadBorrowerWallet(provider: HardhatEthers["provider"]): Wallet {
  const privateKey = process.env.BORROWER_PRIVATE_KEY?.trim();
  if (!privateKey) {
    throw new Error("Set BORROWER_PRIVATE_KEY in .env.");
  }

  return new Wallet(normalizePrivateKey(privateKey, "borrower"), provider);
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

async function readOptionalDeploymentAddress(
  networkName: string,
  deploymentName: string,
): Promise<`0x${string}` | null> {
  const filePath = deploymentFilePath(networkName, deploymentName);
  try {
    const deployment = JSON.parse(await readFile(filePath, "utf8")) as DeploymentLike;
    return requireDeploymentAddress(deployment, deploymentName);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      return null;
    }

    throw err;
  }
}

async function loadArtifact(contractName: string, sourceName = contractName): Promise<ArtifactLike> {
  const artifactPath = path.join(rootDir, "artifacts", "contracts", `${sourceName}.sol`, `${contractName}.json`);
  return JSON.parse(await readFile(artifactPath, "utf8")) as ArtifactLike;
}

function deploymentJson(value: unknown): string {
  return `${JSON.stringify(value, (_key, nestedValue) => (
    typeof nestedValue === "bigint" ? nestedValue.toString() : nestedValue
  ), 2)}\n`;
}

function receiptSummary(receipt: ContractTransactionReceipt | null) {
  if (!receipt) return undefined;

  return {
    hash: receipt.hash,
    blockHash: receipt.blockHash,
    blockNumber: receipt.blockNumber,
    contractAddress: receipt.contractAddress,
    gasUsed: receipt.gasUsed,
    status: receipt.status,
  };
}

async function saveTokenDeployment(
  networkName: string,
  deploymentName: string,
  artifact: ArtifactLike,
  address: `0x${string}`,
  args: [string, string, number],
  transaction: ContractTransactionResponse | null,
  receipt: ContractTransactionReceipt | null,
) {
  const deploymentDir = path.join(rootDir, "deployments", networkName);
  await mkdir(deploymentDir, { recursive: true });

  await writeFile(
    deploymentFilePath(networkName, deploymentName),
    deploymentJson({
      address,
      abi: artifact.abi,
      contractName: artifact.contractName,
      sourceName: artifact.sourceName,
      bytecode: artifact.bytecode,
      deployedBytecode: artifact.deployedBytecode,
      linkReferences: artifact.linkReferences,
      deployedLinkReferences: artifact.deployedLinkReferences,
      immutableReferences: artifact.immutableReferences,
      inputSourceName: artifact.inputSourceName,
      buildInfoId: artifact.buildInfoId,
      args,
      transaction: transaction ? { hash: transaction.hash } : undefined,
      receipt: receiptSummary(receipt),
    }),
    "utf8",
  );
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

function asTestToken(contract: Contract): TestToken {
  return contract as TestToken;
}

async function getOrDeployToken(
  ethers: HardhatEthers,
  borrower: Wallet,
  networkName: string,
  artifact: ArtifactLike,
  config: TokenConfig,
): Promise<TokenDeployment> {
  const existingAddress = await readOptionalDeploymentAddress(networkName, config.deploymentName);

  if (existingAddress !== null) {
    const code = await ethers.provider.getCode(existingAddress);
    if (code !== "0x") {
      const existingToken = asTestToken(await ethers.getContractAt("MockERC20Decimals", existingAddress, borrower));
      const existingDecimals = Number(await existingToken.decimals());
      if (existingDecimals !== config.decimals) {
        throw new Error(
          `${config.deploymentName} at ${existingAddress} has ${existingDecimals} decimals, expected ${config.decimals}.`,
        );
      }

      console.log(`${config.deploymentName}: reusing ${existingAddress}`);
      return {
        config,
        contract: existingToken,
        address: existingAddress,
      };
    }

    console.log(`${config.deploymentName}: deployment file points to ${existingAddress}, but no code exists. Redeploying.`);
  }

  const tokenFactory = await ethers.getContractFactory("MockERC20Decimals", borrower);
  const token = asTestToken(await tokenFactory.deploy(config.name, config.symbol, config.decimals));
  const transaction = token.deploymentTransaction();
  console.log(`${config.deploymentName}: deploying ${config.symbol}`);
  const receipt = transaction ? await transaction.wait() : null;
  await token.waitForDeployment();

  const address = getAddress(await token.getAddress()) as `0x${string}`;
  console.log(`${config.deploymentName}: deployed ${address}`);
  if (receipt) console.log(`${config.deploymentName}: gasUsed=${receipt.gasUsed.toString()}`);

  await saveTokenDeployment(
    networkName,
    config.deploymentName,
    artifact,
    address,
    [config.name, config.symbol, config.decimals],
    transaction,
    receipt,
  );

  return {
    config,
    contract: token,
    address,
  };
}

async function ensureNativeBalance(ethers: HardhatEthers, address: string, label: string) {
  const balance = await ethers.provider.getBalance(address);
  if (balance === 0n) {
    throw new Error(`${label} ${address} has no native token balance to pay transaction gas.`);
  }
}

async function ensureTokenBalance(
  token: TestToken,
  account: string,
  targetAmount: bigint,
  label: string,
) {
  const balance = await token.balanceOf(account);
  if (balance >= targetAmount) {
    console.log(`${label}: balance already ${balance.toString()}`);
    return;
  }

  await waitForTransaction(token.mint(account, targetAmount - balance), `${label}: mint`);
}

async function ensureAllowance(
  token: TestToken,
  lender: Wallet,
  spender: string,
  amount: bigint,
  label: string,
) {
  const currentAllowance = await token.allowance(lender.address, spender);
  if (currentAllowance >= amount) {
    console.log(`${label}: allowance already ${currentAllowance.toString()}`);
    return;
  }

  await waitForTransaction(
    asTestToken(token.connect(lender) as Contract).approve(spender, amount),
    `${label}: approve`,
  );
}

function parseConfiguredAmount(
  ethers: HardhatEthers,
  amount: string,
  decimals: number,
  label: string,
): bigint {
  try {
    return ethers.parseUnits(amount, decimals);
  } catch (err) {
    throw new Error(
      `Invalid ${label}=${amount} for ${decimals}-decimal token: ${(err as Error).message}`,
    );
  }
}

async function latestBlockTimestamp(provider: HardhatEthers["provider"]): Promise<bigint> {
  const block = await provider.getBlock("latest");
  if (!block) {
    throw new Error("Could not read the latest block timestamp.");
  }

  return BigInt(block.timestamp);
}

function formatContractError(err: unknown): string {
  const error = err as {
    shortMessage?: string;
    reason?: string;
    message?: string;
  };

  return error.shortMessage ?? error.reason ?? error.message ?? String(err);
}

async function simulateTransaction(transactionPromise: Promise<unknown>, label: string) {
  try {
    await transactionPromise;
    console.log(`${label}: staticCall succeeded`);
  } catch (err) {
    throw new Error(`${label}: staticCall failed: ${formatContractError(err)}`);
  }
}

async function preflightReceiverOwner(receiver: FlashLoanReceiverWithUniswap, borrowerAddress: string) {
  const receiverOwner = getAddress(await receiver.owner());
  const borrower = getAddress(borrowerAddress);
  if (receiverOwner === borrower) {
    return;
  }

  throw new Error(
    `BORROWER_PRIVATE_KEY resolves to ${borrower}, but FlashLoanReceiverWithUniswap owner is ${receiverOwner}. ` +
    "Use the receiver owner's private key as BORROWER_PRIVATE_KEY or transfer receiver ownership to the borrower before running this script.",
  );
}

async function signPermit2Allowance(params: {
  owner: Wallet;
  permit2: string;
  spender: string;
  token: string;
  amount: bigint;
  expiration: bigint;
  nonce: bigint;
  sigDeadline: bigint;
  chainId: bigint;
}): Promise<Permit2SignatureData> {
  const { owner, permit2, spender, token, amount, expiration, nonce, sigDeadline, chainId } = params;
  const permit: PermitSingle = {
    details: {
      token,
      amount: amount.toString(),
      expiration: expiration.toString(),
      nonce: nonce.toString(),
    },
    spender,
    sigDeadline: sigDeadline.toString(),
  };
  const domain: TypedDataDomain = {
    name: "Permit2",
    chainId,
    verifyingContract: permit2,
  };
  const signature = await owner.signTypedData(
    domain,
    PERMIT2_TYPES,
    permit,
  );

  return {
    amount,
    expiration,
    nonce,
    sigDeadline,
    signature,
  };
}

async function main() {
  const connection = await network.connect();
  const { ethers } = connection;

  try {
    const networkName = connection.networkName;
    const flashLoanMode = loadFlashLoanMode();
    const lender2ApprovalMode = loadLender2ApprovalMode();
    const loanAmount = loadLoanAmount();
    const borrower = loadBorrowerWallet(ethers.provider);
    const lenderWallets = loadLenderWallets(ethers.provider);
    const approvalFlashLoanAddress = requireDeploymentAddress(
      await readDeployment(networkName, "ApprovalFlashLoan"),
      "ApprovalFlashLoan",
    );
    const receiverAddress = requireDeploymentAddress(
      await readDeployment(networkName, "FlashLoanReceiverWithUniswap"),
      "FlashLoanReceiverWithUniswap",
    );

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
    await preflightReceiverOwner(receiver, borrower.address);

    const feeVerifierAddress = getAddress(await flashLoan.feeVerifier());
    const feeVerifier = await ethers.getContractAt("FeeVerifier", feeVerifierAddress, borrower) as FeeVerifier;
    const feeRecipient = getAddress(await feeVerifier.feeRecipient());
    const tokenArtifact = await loadArtifact("MockERC20Decimals", "test/MockERC20Decimals");

    console.log(`network=${networkName}`);
    console.log(`flashLoanMode=${flashLoanMode}`);
    console.log(`lender2ApprovalMode=${lender2ApprovalMode}`);
    console.log(`loanAmount=${loanAmount}`);
    console.log(`mintAmount=${MINT_AMOUNT}`);
    console.log(`borrower=${borrower.address}`);
    console.log(`approvalFlashLoan=${approvalFlashLoanAddress}`);
    console.log(`FlashLoanReceiverWithUniswap=${receiverAddress}`);
    console.log(`feeVerifier=${feeVerifierAddress}`);
    console.log(`feeRecipient=${feeRecipient}`);

    await ensureNativeBalance(ethers, borrower.address, "Borrower");
    await Promise.all(
      lenderWallets.map((lender, index) => ensureNativeBalance(ethers, lender.address, `Lender ${index + 1}`)),
    );

    const tokenDeployments: TokenDeployment[] = [];
    for (const config of TOKEN_CONFIGS) {
      tokenDeployments.push(await getOrDeployToken(ethers, borrower, networkName, tokenArtifact, config));
    }

    const primaryTokenDeployment = tokenDeployments[0];
    if (!primaryTokenDeployment) {
      throw new Error("At least one token config is required.");
    }

    const loanEntries = flashLoanMode === "one-token"
      ? lenderWallets.map((lender) => ({
        lender,
        tokenDeployment: primaryTokenDeployment,
      }))
      : tokenDeployments.map((tokenDeployment, index) => ({
        lender: lenderWallets[index],
        tokenDeployment,
      }));

    const lenders = loanEntries.map(({ lender }) => getAddress(lender.address));
    const assets = loanEntries.map(({ tokenDeployment }) => tokenDeployment.address);
    const amounts = loanEntries.map(({ tokenDeployment: { config } }) => (
      parseConfiguredAmount(ethers, loanAmount, config.decimals, LOAN_AMOUNT_ENV)
    ));
    const mintTargets = loanEntries.map(({ tokenDeployment: { config } }) => (
      parseConfiguredAmount(ethers, MINT_AMOUNT, config.decimals, "MINT_AMOUNT")
    ));
    for (let i = 0; i < loanEntries.length; i++) {
      if (amounts[i] > mintTargets[i]) {
        throw new Error(
          `${LOAN_AMOUNT_ENV}=${loanAmount} exceeds MINT_AMOUNT=${MINT_AMOUNT} ` +
          `for ${loanEntries[i].tokenDeployment.config.deploymentName}.`,
        );
      }
    }

    const permit2Address = lender2ApprovalMode === "permit2"
      ? getAddress(await flashLoan.PERMIT2())
      : null;
    if (permit2Address) {
      const permit2Code = await ethers.provider.getCode(permit2Address);
      if (permit2Code === "0x") {
        throw new Error(`PERMIT2 address ${permit2Address} has no deployed code.`);
      }

      console.log(`permit2=${permit2Address}`);
    }

    for (let i = 0; i < loanEntries.length; i++) {
      const { lender, tokenDeployment } = loanEntries[i];
      const { config, contract } = tokenDeployment;
      await ensureTokenBalance(
        contract,
        lenders[i],
        mintTargets[i],
        `${config.deploymentName}: lender ${i + 1}`,
      );

      const spender = lender2ApprovalMode === "permit2" && i === 1
        ? permit2Address
        : approvalFlashLoanAddress;
      if (!spender) {
        throw new Error("Missing Permit2 address for lender 2.");
      }

      await ensureAllowance(
        contract,
        lender,
        spender,
        amounts[i],
        `${config.deploymentName}: lender ${i + 1}`,
      );
    }

    const tokenByAddress = new Map(
      tokenDeployments.map(({ address, contract }) => [address.toLowerCase(), contract]),
    );
    const requiredReceiverBuffersByToken = new Map<string, { token: TestToken; amount: bigint; address: string }>();
    const addRequiredReceiverBuffer = (token: TestToken, address: string, amount: bigint) => {
      const existing = requiredReceiverBuffersByToken.get(address.toLowerCase());
      if (existing) {
        existing.amount += amount;
      } else {
        requiredReceiverBuffersByToken.set(address.toLowerCase(), {
          token,
          amount,
          address,
        });
      }
    };

    for (let i = 0; i < assets.length; i++) {
      const feeTokenAddress = getAddress(await feeVerifier.getFeeToken(assets[i]));
      const feeAmount = await feeVerifier.getFeeAmount(assets[i], amounts[i]);
      if (feeAmount === 0n) continue;

      const feeToken = tokenByAddress.get(feeTokenAddress.toLowerCase());
      if (!feeToken) {
        throw new Error(
          `Fee token ${feeTokenAddress} for asset ${assets[i]} is not one of the deployed test tokens. ` +
          "This script can only mint fee buffers for its own test tokens.",
        );
      }

      addRequiredReceiverBuffer(feeToken, feeTokenAddress, feeAmount);
    }

    const liquidityTokens = firstTwoDistinctLiquidityTokens(loanEntries);
    if (liquidityTokens.length === 2) {
      for (const tokenDeployment of liquidityTokens) {
        addRequiredReceiverBuffer(
          tokenDeployment.contract,
          tokenDeployment.address,
          ethers.parseUnits(UNISWAP_V3_ROUNDING_BUFFER, tokenDeployment.config.decimals),
        );
      }
    }

    for (const { token, amount, address } of requiredReceiverBuffersByToken.values()) {
      await ensureTokenBalance(
        token,
        receiverAddress,
        amount,
        `Receiver fee/liquidity buffer ${address}`,
      );
    }

    const receiverWithBorrower = receiver.connect(borrower) as FlashLoanReceiverWithUniswap;
    const receipt = lender2ApprovalMode === "permit2"
      ? await waitForTransaction(
        (async () => {
          if (!permit2Address) {
            throw new Error("Missing Permit2 address for lender 2.");
          }

          const lender2Index = 1;
          const permit2 = await ethers.getContractAt(
            "IAllowanceTransfer",
            permit2Address,
            borrower,
          ) as AllowanceTransfer;
          const [, , nonce] = await permit2.allowance(
            lenders[lender2Index],
            assets[lender2Index],
            approvalFlashLoanAddress,
          );
          const now = await latestBlockTimestamp(ethers.provider);
          const expiration = now + PERMIT2_VALIDITY_SECONDS;
          const permits = lenders.map(() => emptyPermit());
          permits[lender2Index] = await signPermit2Allowance({
            owner: loanEntries[lender2Index].lender,
            permit2: permit2Address,
            spender: approvalFlashLoanAddress,
            token: assets[lender2Index],
            amount: amounts[lender2Index],
            expiration,
            nonce,
            sigDeadline: expiration,
            chainId: (await ethers.provider.getNetwork()).chainId,
          });

          await simulateTransaction(
            receiverWithBorrower.initiateFlashLoanBestEffortMix.staticCall(
              lenders,
              assets,
              amounts,
              permits,
              "0x",
            ),
            "initiateFlashLoanBestEffortMix",
          );

          return receiverWithBorrower.initiateFlashLoanBestEffortMix(
            lenders,
            assets,
            amounts,
            permits,
            "0x",
          );
        })(),
        "initiateFlashLoanBestEffortMix",
      )
      : await (async () => {
        await simulateTransaction(
          receiverWithBorrower.initiateFlashLoanBestEffort.staticCall(lenders, assets, amounts, "0x"),
          "initiateFlashLoanBestEffort",
        );
        return waitForTransaction(
          receiverWithBorrower.initiateFlashLoanBestEffort(lenders, assets, amounts, "0x"),
          "initiateFlashLoanBestEffort",
        );
      })();

    console.log("Completed best-effort flash loan flow.");
    console.log(`flashLoanTx=${receipt?.hash ?? "unknown"}`);
  } finally {
    await connection.close();
  }
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
