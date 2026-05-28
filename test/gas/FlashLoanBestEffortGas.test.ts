import { expect } from "chai";
import {
  DEFAULT_FEE_BPS,
  HUNDRED_TOKENS,
  TOKEN_B_HUNDRED_TOKENS,
  approve,
  deployFlashLoanFixture,
  ethers,
  mint,
  networkHelpers,
} from "../fixtures/deploy.js";

describe("Gas: flashLoanBestEffort", function () {
  async function expectFlashLoanBestEffortGas(lenderCount: number, tokenCount: 1 | 2) {
    const { flashLoan, receiverSimple, tokenA, tokenB } =
      await networkHelpers.loadFixture(deployFlashLoanFixture);
    const signers = await ethers.getSigners();
    const lenders = signers.slice(0, lenderCount);
    const tokenAAmount = ethers.parseEther("1");
    const tokenBAmount = ethers.parseUnits("1", 6);
    const tokenAAddress = await tokenA.getAddress();
    const tokenBAddress = await tokenB.getAddress();
    const flashLoanAddress = await flashLoan.getAddress();
    const receiverAddress = await receiverSimple.getAddress();
    const lenderAddresses = lenders.map((lender) => lender.address);
    const assets = lenders.map((_, index) => tokenCount === 1 || index % 2 === 0 ? tokenAAddress : tokenBAddress);
    const amounts = lenders.map((_, index) => tokenCount === 1 || index % 2 === 0 ? tokenAAmount : tokenBAmount);
    const tokenALenderCount = assets.filter((asset) => asset === tokenAAddress).length;
    const tokenBLenderCount = assets.filter((asset) => asset === tokenBAddress).length;
    const expectedFeeAssets = tokenCount === 1 ? [tokenAAddress] : [tokenAAddress, tokenBAddress];
    const expectedAggregatedFees = tokenCount === 1
      ? [tokenAAmount * BigInt(lenderCount) * DEFAULT_FEE_BPS / 10_000n]
      : [
          tokenAAmount * BigInt(tokenALenderCount) * DEFAULT_FEE_BPS / 10_000n,
          tokenBAmount * BigInt(tokenBLenderCount) * DEFAULT_FEE_BPS / 10_000n,
        ];

    expect(lenders.length).to.equal(lenderCount);

    for (const [index, lender] of lenders.entries()) {
      if (tokenCount === 1 || index % 2 === 0) {
        await mint(tokenA, lender.address, HUNDRED_TOKENS);
        await approve(tokenA, lender, flashLoanAddress, HUNDRED_TOKENS);
      } else {
        await mint(tokenB, lender.address, TOKEN_B_HUNDRED_TOKENS);
        await approve(tokenB, lender, flashLoanAddress, TOKEN_B_HUNDRED_TOKENS);
      }
    }

    const tx = await receiverSimple.initiateFlashLoanBestEffort(
      lenderAddresses,
      assets,
      amounts,
      "0x"
    );
    const receipt = await tx.wait();

    expect(receipt).not.to.equal(null);
    expect(receipt!.gasUsed > 0n).to.equal(true);
    await expect(tx).to.emit(flashLoan, "FlashLoan")
      .withArgs(
        receiverAddress,
        receiverAddress,
        lenderAddresses,
        assets,
        amounts,
        expectedFeeAssets,
        expectedAggregatedFees
      );

    console.log(
      `flashLoanBestEffort gas used (${lenderCount} lenders, ${tokenCount} token${tokenCount === 1 ? "" : "s"}, FlashLoanReceiverSimple): ${receipt!.gasUsed.toString()}`
    );
  }

  it("estimates gas for 5 lenders, 1 token, and FlashLoanReceiverSimple", async function () {
    await expectFlashLoanBestEffortGas(5, 1);
  });

  it("estimates gas for 10 lenders, 1 token, and FlashLoanReceiverSimple", async function () {
    await expectFlashLoanBestEffortGas(10, 1);
  });

  it("estimates gas for 20 lenders, 1 tokens, and FlashLoanReceiverSimple", async function () {
    await expectFlashLoanBestEffortGas(20, 1);
  });

  it("estimates gas for 10 lenders, 2 tokens, and FlashLoanReceiverSimple", async function () {
    await expectFlashLoanBestEffortGas(10, 2);
  });

  it("estimates gas for 20 lenders, 1 tokens, and FlashLoanReceiverSimple", async function () {
    await expectFlashLoanBestEffortGas(20, 2);
  });

});
