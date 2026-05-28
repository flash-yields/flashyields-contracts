import { expect } from "chai";
import {
  DEFAULT_FEE_BPS,
  HUNDRED_TOKENS,
  approve,
  deployFlashLoanFixture,
  networkHelpers,
} from "../fixtures/deploy.js";

describe("FlashLoanreceiverWithUniswap", function () {
  it("sets the deployer as owner", async function () {
    const { receiverWithUniswap, deployer } = await networkHelpers.loadFixture(deployFlashLoanFixture);

    expect(await receiverWithUniswap.owner()).to.equal(deployer.address);
  });

  it("rejects callback calls from anything other than the flash-loan contract", async function () {
    const { receiverWithUniswap, tokenA, lender1, feeRecipient, other } =
      await networkHelpers.loadFixture(deployFlashLoanFixture);

    await expect(receiverWithUniswap.connect(other).executeOperation(
      [lender1.address],
      [await tokenA.getAddress()],
      [1n],
      [await tokenA.getAddress()],
      [1n],
      1n,
      feeRecipient.address,
      other.address,
      "0x"
    )).to.be.revertedWithCustomError(receiverWithUniswap, "CallerNotFlashLoanContract");
  });

  it("round-trips two borrowed assets through Uniswap V3 liquidity before repayment", async function () {
    const { ethers, flashLoan, receiverWithUniswap, uniswapV3PositionManager, tokenA, feeToken, lender1, lender2, feeRecipient } =
      await networkHelpers.loadFixture(deployFlashLoanFixture);
    const tokenAAddress = await tokenA.getAddress();
    const feeTokenAddress = await feeToken.getAddress();
    const flashLoanAddress = await flashLoan.getAddress();
    const amount = ethers.parseEther("10");
    const fee = amount * DEFAULT_FEE_BPS / 10_000n;

    await approve(tokenA, lender1, flashLoanAddress, HUNDRED_TOKENS);
    await approve(feeToken, lender2, flashLoanAddress, HUNDRED_TOKENS);

    const lender1BalanceBefore = await tokenA.balanceOf(lender1.address);
    const lender2BalanceBefore = await feeToken.balanceOf(lender2.address);
    const feeRecipientTokenABalanceBefore = await tokenA.balanceOf(feeRecipient.address);
    const feeRecipientFeeTokenBalanceBefore = await feeToken.balanceOf(feeRecipient.address);

    await receiverWithUniswap.initiateFlashLoan(
      [lender1.address, lender2.address],
      [tokenAAddress, feeTokenAddress],
      [amount, amount],
      "0x"
    );

    const [token0, token1] = BigInt(tokenAAddress) < BigInt(feeTokenAddress)
      ? [tokenAAddress, feeTokenAddress]
      : [feeTokenAddress, tokenAAddress];
    const poolKey = ethers.keccak256(
      ethers.AbiCoder.defaultAbiCoder().encode(["address", "address", "uint24"], [token0, token1, 3000])
    );

    expect(await uniswapV3PositionManager.createAndInitializeCalls()).to.equal(1n);
    expect(await uniswapV3PositionManager.createdPools()).to.equal(1n);
    expect(await uniswapV3PositionManager.pools(poolKey)).to.not.equal(ethers.ZeroAddress);
    expect(await uniswapV3PositionManager.mintCalls()).to.equal(1n);
    expect(await uniswapV3PositionManager.decreaseLiquidityCalls()).to.equal(1n);
    expect(await uniswapV3PositionManager.collectCalls()).to.equal(1n);
    expect(await uniswapV3PositionManager.burnCalls()).to.equal(1n);

    expect(await tokenA.balanceOf(lender1.address)).to.equal(lender1BalanceBefore);
    expect(await feeToken.balanceOf(lender2.address)).to.equal(lender2BalanceBefore);
    expect(await tokenA.balanceOf(feeRecipient.address)).to.equal(feeRecipientTokenABalanceBefore + fee);
    expect(await feeToken.balanceOf(feeRecipient.address)).to.equal(feeRecipientFeeTokenBalanceBefore + fee);
  });
});
