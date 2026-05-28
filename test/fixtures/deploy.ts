import { network } from "hardhat";
import type { Contract, ContractTransactionResponse } from "ethers";
import type { HardhatEthersSigner } from "@nomicfoundation/hardhat-ethers/types";
import { loadAndExecuteDeploymentsFromFiles } from "../../rocketh/environment.js";

const connection = await network.connect();
const { ethers, networkHelpers } = connection;

export { connection, ethers, networkHelpers };

export const ZERO_ADDRESS = ethers.ZeroAddress;
export const PERMIT2_ADDRESS = "0x000000000022D473030F116dDEE9F6B43aC78BA3";
export const DEFAULT_FEE_BPS = 5n;
export const DEFAULT_MAX_STALENESS = 86_400n;
export const TIMELOCK_MIN_DELAY = 3n * 24n * 60n * 60n;
export const ONE_TOKEN = ethers.parseEther("1");
export const TEN_TOKENS = ethers.parseEther("10");
export const HUNDRED_TOKENS = ethers.parseEther("100");
export const TOKEN_B_HUNDRED_TOKENS = ethers.parseUnits("100", 6);
const TIMELOCK_CONTROLLER_CONTRACT =
  "contracts/dependencies/openzeppelin-v4.7.0/governance/TimelockController.sol:TimelockController";

let timelockOperationNonce = 0n;

export async function deployToken(
  name: string,
  symbol: string,
  decimals = 18
): Promise<Contract> {
  return ethers.deployContract("MockERC20Decimals", [name, symbol, decimals]);
}

export async function mint(token: Contract, account: string, amount: bigint): Promise<void> {
  await token.mint(account, amount);
}

export async function approve(
  token: Contract,
  signer: HardhatEthersSigner,
  spender: string,
  amount: bigint
): Promise<void> {
  await token.connect(signer).approve(spender, amount);
}

export async function latestTimestamp(): Promise<bigint> {
  return BigInt(await networkHelpers.time.latest());
}

export async function deployTimelockController(
  proposer: string,
  executor = proposer
): Promise<Contract> {
  return ethers.deployContract(TIMELOCK_CONTROLLER_CONTRACT, [
    TIMELOCK_MIN_DELAY,
    [proposer],
    [executor],
  ]);
}

export async function executeTimelockCall(
  timelockController: Contract,
  executor: HardhatEthersSigner,
  target: string,
  data: string,
  value = 0n
): Promise<ContractTransactionResponse> {
  const predecessor = ethers.ZeroHash;
  const salt = ethers.id(`timelock-operation-${timelockOperationNonce++}`);
  const minDelay = await timelockController.getMinDelay();

  await timelockController.connect(executor).schedule(
    target,
    value,
    data,
    predecessor,
    salt,
    minDelay
  );

  if (minDelay > 0n) {
    await networkHelpers.time.increase(Number(minDelay));
  }

  return timelockController.connect(executor).execute(
    target,
    value,
    data,
    predecessor,
    salt,
    { value }
  );
}

export async function deployFlashLoanFixture() {
  const [
    deployer,
    admin,
    pauser,
    bookKeeper,
    lender1,
    lender2,
    lender3,
    initiator,
    feeRecipient,
    other,
  ] = await ethers.getSigners(); // these are not the same roles in config files, just default hardhat seed

  const aclManager = await ethers.deployContract("MockACLManager");
  const timelockController = await deployTimelockController(admin.address);
  await aclManager.setAdminRole(admin.address, true);
  await aclManager.setAdminRole(deployer.address, true);
  await aclManager.setTimelockRole(await timelockController.getAddress(), true);
  await aclManager.setPauserRole(pauser.address, true);
  await aclManager.setPauserRole(deployer.address, true);
  await aclManager.setBookKeeperRole(bookKeeper.address, true);
  await aclManager.setBookKeeperRole(deployer.address, true);

  const permit2 = await ethers.deployContract("TestPermit2AllowanceTransfer");
  const feeVerifier = await ethers.deployContract("FeeVerifier", [
    await aclManager.getAddress(),
    feeRecipient.address,
    DEFAULT_FEE_BPS,
    DEFAULT_MAX_STALENESS,
  ]);
  const flashLoan = await ethers.deployContract("ApprovalFlashLoan", [
    await aclManager.getAddress(),
    await feeVerifier.getAddress(),
    await permit2.getAddress(),
  ]);
  const lenderRegistry = await ethers.deployContract("LenderRegistry", [
    await flashLoan.getAddress(),
  ]);
  const uniswapV3PositionManager = await ethers.deployContract("MockUniswapV3NonfungiblePositionManager");
  const receiver = await ethers.deployContract("TestFlashLoanReceiver", [
    await flashLoan.getAddress(),
  ]);
  const receiverWithUniswap = await ethers.deployContract("FlashLoanReceiverWithUniswap", [
    await flashLoan.getAddress(),
    await uniswapV3PositionManager.getAddress(),
  ]);
  const receiverSimple = await ethers.deployContract("FlashLoanReceiverSimple", [
    await flashLoan.getAddress()
  ]);
  const vault = await ethers.deployContract("ERC20Vault", [
    await flashLoan.getAddress(),
    await aclManager.getAddress(),
    [],
    [],
    [],
  ]);

  const tokenA = await deployToken("Token A", "TKNA", 18);
  const tokenB = await deployToken("Token B", "TKNB", 6);
  const feeToken = await deployToken("Fee Token", "FEE", 18);

  for (const lender of [lender1, lender2, lender3]) {
    await mint(tokenA, lender.address, HUNDRED_TOKENS);
    await mint(tokenB, lender.address, TOKEN_B_HUNDRED_TOKENS);
    await mint(feeToken, lender.address, HUNDRED_TOKENS);
  }
  await mint(tokenA, await receiver.getAddress(), HUNDRED_TOKENS);
  await mint(tokenB, await receiver.getAddress(), TOKEN_B_HUNDRED_TOKENS);
  await mint(feeToken, await receiver.getAddress(), HUNDRED_TOKENS);
  await mint(tokenA, await receiverSimple.getAddress(), HUNDRED_TOKENS);
  await mint(tokenB, await receiverSimple.getAddress(), TOKEN_B_HUNDRED_TOKENS);
  await mint(feeToken, await receiverSimple.getAddress(), HUNDRED_TOKENS);
  await mint(tokenA, await receiverWithUniswap.getAddress(), HUNDRED_TOKENS);
  await mint(tokenB, await receiverWithUniswap.getAddress(), TOKEN_B_HUNDRED_TOKENS);
  await mint(feeToken, await receiverWithUniswap.getAddress(), HUNDRED_TOKENS);

  return {
    ethers,
    networkHelpers,
    deployer,
    admin,
    pauser,
    bookKeeper,
    lender1,
    lender2,
    lender3,
    initiator,
    feeRecipient,
    other,
    aclManager,
    timelockController,
    permit2,
    feeVerifier,
    flashLoan,
    lenderRegistry,
    uniswapV3PositionManager,
    receiver,
    receiverSimple,
    receiverWithUniswap,
    vault,
    tokenA,
    tokenB,
    feeToken,
  };
}

export async function deployWithMockPermit2Fixture() {
  const fixture = await deployFlashLoanFixture();
  const mockPermit2 = await ethers.deployContract("MockAllowanceTransfer");
  const flashLoan = await ethers.deployContract("ApprovalFlashLoan", [
    await fixture.aclManager.getAddress(),
    await fixture.feeVerifier.getAddress(),
    await mockPermit2.getAddress(),
  ]);
  const receiver = await ethers.deployContract("TestFlashLoanReceiver", [
    await flashLoan.getAddress(),
  ]);
  await mint(fixture.tokenA, await receiver.getAddress(), HUNDRED_TOKENS);
  await mint(fixture.tokenB, await receiver.getAddress(), TOKEN_B_HUNDRED_TOKENS);
  await mint(fixture.feeToken, await receiver.getAddress(), HUNDRED_TOKENS);

  return {
    ...fixture,
    permit2: mockPermit2,
    flashLoan,
    receiver,
  };
}

export async function approveDirectLoanDefaults(fixture: Awaited<ReturnType<typeof deployFlashLoanFixture>>) {
  const flashLoanAddress = await fixture.flashLoan.getAddress();
  await approve(fixture.tokenA, fixture.lender1, flashLoanAddress, HUNDRED_TOKENS);
  await approve(fixture.tokenA, fixture.lender2, flashLoanAddress, HUNDRED_TOKENS);
  await approve(fixture.tokenB, fixture.lender3, flashLoanAddress, TOKEN_B_HUNDRED_TOKENS);
}

export async function deployAggregator(answer: bigint, updatedAt?: bigint, decimals = 8): Promise<Contract> {
  const timestamp = updatedAt ?? await latestTimestamp();
  return ethers.deployContract("MockEACAggregatorProxy", [decimals, answer, timestamp]);
}

export async function deployRockethFixture() {
  const [deployer, lender] = await ethers.getSigners();
  const permit2 = await ethers.deployContract("TestPermit2AllowanceTransfer");
  const permit2Code = await ethers.provider.getCode(await permit2.getAddress());
  await networkHelpers.setCode(PERMIT2_ADDRESS, permit2Code);

  const env = await loadAndExecuteDeploymentsFromFiles({
    provider: connection.provider,
    environment: "default",
    saveDeployments: false,
    askBeforeProceeding: false,
  });

  const feeVerifierDeployment = env.getOrNull("FeeVerifier");
  const flashLoanDeployment = env.getOrNull("ApprovalFlashLoan");
  const receiverDeployment = env.getOrNull("FlashLoanReceiverSimple");
  if (!feeVerifierDeployment || !flashLoanDeployment || !receiverDeployment) {
    throw new Error("Expected Rocketh deploy scripts to deploy all flash-loan contracts");
  }

  const feeVerifier = await ethers.getContractAt("FeeVerifier", feeVerifierDeployment.address);
  const flashLoan = await ethers.getContractAt("ApprovalFlashLoan", flashLoanDeployment.address);
  const receiver = await ethers.getContractAt("FlashLoanReceiverSimple", receiverDeployment.address);
  const token = await deployToken("Rocketh Token", "ROCK", 18);
  await mint(token, lender.address, HUNDRED_TOKENS);
  await mint(token, await receiver.getAddress(), HUNDRED_TOKENS);
  await approve(token, lender, await flashLoan.getAddress(), HUNDRED_TOKENS);

  return {
    env,
    deployer,
    lender,
    token,
    feeVerifier,
    flashLoan,
    receiver,
  };
}
