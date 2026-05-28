import { expect } from "chai";
import {
  DEFAULT_FEE_BPS,
  HUNDRED_TOKENS,
  approve,
  deployFlashLoanFixture,
  ethers,
  networkHelpers,
} from "../fixtures/deploy.js";

describe("FlashLoanReceiverSimple", function () {
  it("stores the configured flash-loan contract", async function () {
    const { flashLoan, receiverSimple } = await networkHelpers.loadFixture(deployFlashLoanFixture);

    expect(await receiverSimple.flashLoanContract()).to.equal(await flashLoan.getAddress());
  });

  it("sets the deployer as owner", async function () {
    const { receiverSimple, deployer } = await networkHelpers.loadFixture(deployFlashLoanFixture);

    expect(await receiverSimple.owner()).to.equal(deployer.address);
  });

  it("rejects callback calls from anything other than the flash-loan contract", async function () {
    const { receiverSimple, tokenA, lender1, feeRecipient, other } =
      await networkHelpers.loadFixture(deployFlashLoanFixture);

    await expect(receiverSimple.connect(other).executeOperation(
      [lender1.address],
      [await tokenA.getAddress()],
      [1n],
      [await tokenA.getAddress()],
      [1n],
      1n,
      feeRecipient.address,
      other.address,
      "0x"
    )).to.be.revertedWithCustomError(receiverSimple, "CallerNotFlashLoanContract");
  });

  it("rejects direct flash-loan callbacks not initiated by the receiver", async function () {
    const { flashLoan, receiverSimple, tokenA, lender1 } =
      await networkHelpers.loadFixture(deployFlashLoanFixture);
    const amount = ethers.parseEther("10");
    const receiverAddress = await receiverSimple.getAddress();
    const tokenAAddress = await tokenA.getAddress();

    await approve(tokenA, lender1, await flashLoan.getAddress(), HUNDRED_TOKENS);

    await expect(flashLoan.flashLoan(
      receiverAddress,
      [lender1.address],
      [tokenAAddress],
      [amount],
      "0x"
    )).to.be.revertedWithCustomError(receiverSimple, "InvalidInitiator");
  });

  it("only allows the owner to initiate flash loans", async function () {
    const { receiverSimple, lenderRegistry, other } = await networkHelpers.loadFixture(deployFlashLoanFixture);

    await expect(receiverSimple.connect(other).initiateFlashLoan(
      [],
      [],
      [],
      "0x"
    )).to.be.revertedWithCustomError(receiverSimple, "OwnableUnauthorizedAccount")
      .withArgs(other.address);

    await expect(receiverSimple.connect(other).initiateFlashLoanBestEffort(
      [],
      [],
      [],
      "0x"
    )).to.be.revertedWithCustomError(receiverSimple, "OwnableUnauthorizedAccount")
      .withArgs(other.address);

    await expect(receiverSimple.connect(other).initiateFlashLoanWithPermit2(
      [],
      [],
      [],
      [],
      "0x"
    )).to.be.revertedWithCustomError(receiverSimple, "OwnableUnauthorizedAccount")
      .withArgs(other.address);

    await expect(receiverSimple.connect(other).initiateFlashLoanBestEffortMix(
      [],
      [],
      [],
      [],
      "0x"
    )).to.be.revertedWithCustomError(receiverSimple, "OwnableUnauthorizedAccount")
      .withArgs(other.address);

    await expect(receiverSimple.connect(other).initiateFlashLoanFromRegistry(
      await lenderRegistry.getAddress(),
      "0x"
    )).to.be.revertedWithCustomError(receiverSimple, "OwnableUnauthorizedAccount")
      .withArgs(other.address);
  });

  it("initiates a direct flash loan, restores principal, and forwards fees", async function () {
    const { flashLoan, receiverSimple, tokenA, lender1, feeRecipient } =
      await networkHelpers.loadFixture(deployFlashLoanFixture);
    const tokenAAddress = await tokenA.getAddress();
    const receiverAddress = await receiverSimple.getAddress();
    const amount = ethers.parseEther("10");
    const fee = amount * DEFAULT_FEE_BPS / 10_000n;

    await approve(tokenA, lender1, await flashLoan.getAddress(), HUNDRED_TOKENS);
    const lenderBalanceBefore = await tokenA.balanceOf(lender1.address);
    const feeRecipientBalanceBefore = await tokenA.balanceOf(feeRecipient.address);
    const receiverBalanceBefore = await tokenA.balanceOf(receiverAddress);

    await expect(receiverSimple.initiateFlashLoan(
      [lender1.address],
      [tokenAAddress],
      [amount],
      "0x1234"
    )).to.emit(flashLoan, "FlashLoan")
      .withArgs(
        receiverAddress,
        receiverAddress,
        [lender1.address],
        [tokenAAddress],
        [amount],
        [tokenAAddress],
        [fee]
      );

    expect(await tokenA.balanceOf(lender1.address)).to.equal(lenderBalanceBefore);
    expect(await tokenA.balanceOf(feeRecipient.address)).to.equal(feeRecipientBalanceBefore + fee);
    expect(await tokenA.balanceOf(receiverAddress)).to.equal(receiverBalanceBefore - fee);
    expect(await tokenA.allowance(receiverAddress, await flashLoan.getAddress())).to.equal(0n);
  });
});
