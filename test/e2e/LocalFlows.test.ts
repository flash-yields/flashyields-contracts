import { expect } from "chai";
import {
  DEFAULT_FEE_BPS,
  HUNDRED_TOKENS,
  approve,
  deployAggregator,
  deployFlashLoanFixture,
  deployRockethFixture,
  ethers,
  networkHelpers,
} from "../fixtures/deploy.js";
import { emptyPermit, signPermit2Allowance } from "../fixtures/permit2.js";

describe("E2E: local flash-loan flows", function () {
  it("runs the full direct allowance flow through FlashLoanReceiverSimple", async function () {
    const { flashLoan, receiverSimple, tokenA, lender1, feeRecipient } =
      await networkHelpers.loadFixture(deployFlashLoanFixture);
    const amount = ethers.parseEther("10");
    const fee = amount * DEFAULT_FEE_BPS / 10_000n;

    await approve(tokenA, lender1, await flashLoan.getAddress(), HUNDRED_TOKENS);
    const lenderBalanceBefore = await tokenA.balanceOf(lender1.address);
    const feeRecipientBalanceBefore = await tokenA.balanceOf(feeRecipient.address);

    await receiverSimple.initiateFlashLoan(
      [lender1.address],
      [await tokenA.getAddress()],
      [amount],
      "0x"
    );

    expect(await tokenA.balanceOf(lender1.address)).to.equal(lenderBalanceBefore);
    expect(await tokenA.balanceOf(feeRecipient.address)).to.equal(feeRecipientBalanceBefore + fee);
  });

  it("runs a direct flow from registry availability through FlashLoanReceiverSimple", async function () {
    const {
      flashLoan,
      lenderRegistry,
      receiverSimple,
      tokenA,
      tokenB,
      feeToken,
      admin,
      lender1,
      lender2,
      lender3,
      feeRecipient,
    } = await networkHelpers.loadFixture(deployFlashLoanFixture);
    const flashLoanAddress = await flashLoan.getAddress();
    const lenderRegistryAddress = await lenderRegistry.getAddress();
    const receiverAddress = await receiverSimple.getAddress();
    const tokenAAddress = await tokenA.getAddress();
    const tokenBAddress = await tokenB.getAddress();
    const feeTokenAddress = await feeToken.getAddress();
    const lenders = [lender1.address, lender2.address, lender3.address];
    const assets = [tokenAAddress, tokenBAddress, feeTokenAddress];
    const amounts = [
      ethers.parseEther("12.5"),
      ethers.parseUnits("40", 6),
      ethers.parseEther("7.25"),
    ];
    const fees = amounts.map((amount) => amount * DEFAULT_FEE_BPS / 10_000n);

    await lenderRegistry.connect(admin).setPermissionlessParticipationEnabled(true);
    await lenderRegistry.connect(lender1).indicateParticipation([tokenAAddress]);
    await lenderRegistry.connect(lender2).indicateParticipation([tokenBAddress]);
    await lenderRegistry.connect(lender3).indicateParticipation([feeTokenAddress]);
    await approve(tokenA, lender1, flashLoanAddress, amounts[0]);
    await approve(tokenB, lender2, flashLoanAddress, amounts[1]);
    await approve(feeToken, lender3, flashLoanAddress, amounts[2]);

    const availability = await lenderRegistry.getAllPotentialLendersAvailability();
    expect(availability).to.have.lengthOf(3);
    for (const [index, tokenAvailability] of availability.entries()) {
      expect(tokenAvailability.token).to.equal(assets[index]);
      expect([...tokenAvailability.lenders]).to.deep.equal([lenders[index]]);
      expect([...tokenAvailability.availableAmounts]).to.deep.equal([amounts[index]]);
    }

    const feeRecipientBalancesBefore = [
      await tokenA.balanceOf(feeRecipient.address),
      await tokenB.balanceOf(feeRecipient.address),
      await feeToken.balanceOf(feeRecipient.address),
    ];
    const lenderBalancesBefore = [
      await tokenA.balanceOf(lender1.address),
      await tokenB.balanceOf(lender2.address),
      await feeToken.balanceOf(lender3.address),
    ];

    await expect(receiverSimple.initiateFlashLoanFromRegistry(
      lenderRegistryAddress,
      "0x"
    )).to.emit(flashLoan, "FlashLoan")
      .withArgs(
        receiverAddress,
        receiverAddress,
        lenders,
        assets,
        amounts,
        assets,
        fees
      );

    expect(await tokenA.balanceOf(lender1.address)).to.equal(lenderBalancesBefore[0]);
    expect(await tokenB.balanceOf(lender2.address)).to.equal(lenderBalancesBefore[1]);
    expect(await feeToken.balanceOf(lender3.address)).to.equal(lenderBalancesBefore[2]);
    expect(await tokenA.balanceOf(feeRecipient.address)).to.equal(feeRecipientBalancesBefore[0] + fees[0]);
    expect(await tokenB.balanceOf(feeRecipient.address)).to.equal(feeRecipientBalancesBefore[1] + fees[1]);
    expect(await feeToken.balanceOf(feeRecipient.address)).to.equal(feeRecipientBalancesBefore[2] + fees[2]);
  });

  it("runs the best-effort direct flow and skips under-approved lenders", async function () {
    const { flashLoan, receiverSimple, tokenA, lender1, lender2 } =
      await networkHelpers.loadFixture(deployFlashLoanFixture);
    const amount = ethers.parseEther("10");
    await approve(tokenA, lender1, await flashLoan.getAddress(), HUNDRED_TOKENS);

    const lender2BalanceBefore = await tokenA.balanceOf(lender2.address);
    await receiverSimple.initiateFlashLoanBestEffort(
      [lender1.address, lender2.address],
      [await tokenA.getAddress(), await tokenA.getAddress()],
      [amount, amount],
      "0x"
    );

    expect(await tokenA.balanceOf(lender2.address)).to.equal(lender2BalanceBefore);
  });

  it("runs best-effort flow from all registry availability through FlashLoanReceiverSimple", async function () {
    const {
      flashLoan,
      lenderRegistry,
      receiverSimple,
      tokenA,
      tokenB,
      feeToken,
      admin,
      lender1,
      lender2,
      lender3,
    } = await networkHelpers.loadFixture(deployFlashLoanFixture);
    const flashLoanAddress = await flashLoan.getAddress();
    const receiverAddress = await receiverSimple.getAddress();
    const tokenAAddress = await tokenA.getAddress();
    const tokenBAddress = await tokenB.getAddress();
    const feeTokenAddress = await feeToken.getAddress();
    const expectedLenders = [lender1.address, lender2.address, lender3.address];
    const expectedAssets = [tokenAAddress, tokenBAddress, feeTokenAddress];
    const expectedAmounts = [
      ethers.parseEther("12"),
      ethers.parseUnits("35", 6),
      ethers.parseEther("8"),
    ];
    const expectedFees = expectedAmounts.map((amount) => amount * DEFAULT_FEE_BPS / 10_000n);

    await lenderRegistry.connect(admin).setPermissionlessParticipationEnabled(true);
    await lenderRegistry.connect(lender1).indicateParticipation([tokenAAddress]);
    await lenderRegistry.connect(lender2).indicateParticipation([tokenBAddress]);
    await lenderRegistry.connect(lender3).indicateParticipation([feeTokenAddress]);
    await approve(tokenA, lender1, flashLoanAddress, expectedAmounts[0]);
    await approve(tokenB, lender2, flashLoanAddress, expectedAmounts[1]);
    await approve(feeToken, lender3, flashLoanAddress, expectedAmounts[2]);

    const availability = await lenderRegistry.getAllPotentialLendersAvailability();
    const lenders: string[] = [];
    const assets: string[] = [];
    const amounts: bigint[] = [];

    for (const tokenAvailability of availability) {
      for (const [index, lender] of tokenAvailability.lenders.entries()) {
        const availableAmount = tokenAvailability.availableAmounts[index];
        lenders.push(lender);
        assets.push(tokenAvailability.token);
        amounts.push(availableAmount);
      }
    }

    expect(lenders).to.deep.equal(expectedLenders);
    expect(assets).to.deep.equal(expectedAssets);
    expect(amounts).to.deep.equal(expectedAmounts);

    await expect(receiverSimple.initiateFlashLoanBestEffort(
      lenders,
      assets,
      amounts,
      "0x"
    )).to.emit(flashLoan, "FlashLoan")
      .withArgs(
        receiverAddress,
        receiverAddress,
        expectedLenders,
        expectedAssets,
        expectedAmounts,
        expectedAssets,
        expectedFees
      );
  });

  it("runs best-effort flow from token-specific registry availability through FlashLoanReceiverSimple", async function () {
    const { flashLoan, lenderRegistry, receiverSimple, tokenA, admin, lender1, lender2, lender3 } =
      await networkHelpers.loadFixture(deployFlashLoanFixture);
    const flashLoanAddress = await flashLoan.getAddress();
    const receiverAddress = await receiverSimple.getAddress();
    const tokenAAddress = await tokenA.getAddress();
    const approvedAmounts = [
      ethers.parseEther("11"),
      0n,
      ethers.parseEther("9"),
    ];
    const expectedAmounts = [approvedAmounts[0], approvedAmounts[2]];

    await lenderRegistry.connect(admin).setPermissionlessParticipationEnabled(true);
    await lenderRegistry.connect(lender1).indicateParticipation([tokenAAddress]);
    await lenderRegistry.connect(lender2).indicateParticipation([tokenAAddress]);
    await lenderRegistry.connect(lender3).indicateParticipation([tokenAAddress]);
    await approve(tokenA, lender1, flashLoanAddress, approvedAmounts[0]);
    await approve(tokenA, lender3, flashLoanAddress, approvedAmounts[2]);

    const availability = await lenderRegistry.getPotentialLendersAvailabilityByToken(tokenAAddress);
    const lenders: string[] = [];
    const assets: string[] = [];
    const amounts: bigint[] = [];

    expect(availability).to.have.lengthOf(2);
    expect(availability.map(({ lender }) => lender)).to.deep.equal([lender1.address, lender3.address]);
    expect(availability.map(({ availableAmount }) => availableAmount)).to.deep.equal(expectedAmounts);

    for (const lenderAvailability of availability) {
      lenders.push(lenderAvailability.lender);
      assets.push(tokenAAddress);
      amounts.push(lenderAvailability.availableAmount);
    }

    const expectedLenders = [lender1.address, lender3.address];
    const expectedAssets = [tokenAAddress, tokenAAddress];
    const expectedFee = expectedAmounts.reduce(
      (total, amount) => total + amount * DEFAULT_FEE_BPS / 10_000n,
      0n
    );

    expect(lenders).to.deep.equal(expectedLenders);
    expect(assets).to.deep.equal(expectedAssets);
    expect(amounts).to.deep.equal(expectedAmounts);

    await expect(receiverSimple.initiateFlashLoanBestEffort(
      lenders,
      assets,
      amounts,
      "0x"
    )).to.emit(flashLoan, "FlashLoan")
      .withArgs(
        receiverAddress,
        receiverAddress,
        expectedLenders,
        expectedAssets,
        expectedAmounts,
        [tokenAAddress],
        [expectedFee]
      );
  });

  it("runs best-effort flow from requested-lender registry availability through FlashLoanReceiverSimple", async function () {
    const { flashLoan, lenderRegistry, receiverSimple, tokenB, lender1, lender2, lender3 } =
      await networkHelpers.loadFixture(deployFlashLoanFixture);
    const flashLoanAddress = await flashLoan.getAddress();
    const receiverAddress = await receiverSimple.getAddress();
    const tokenBAddress = await tokenB.getAddress();
    const requestedLenders = [lender1.address, lender2.address, lender3.address];
    const approvedAmounts = [
      ethers.parseUnits("20", 6),
      0n,
      ethers.parseUnits("15", 6),
    ];

    await approve(tokenB, lender1, flashLoanAddress, approvedAmounts[0]);
    await approve(tokenB, lender3, flashLoanAddress, approvedAmounts[2]);

    const availableAmounts = await lenderRegistry.getAvailableAmountsByTokenAndLenders(
      tokenBAddress,
      requestedLenders
    );
    const lenders: string[] = [];
    const assets: string[] = [];
    const amounts: bigint[] = [];

    expect([...availableAmounts]).to.deep.equal(approvedAmounts);

    for (const [index, availableAmount] of availableAmounts.entries()) {
      if (availableAmount === 0n) continue;

      lenders.push(requestedLenders[index]);
      assets.push(tokenBAddress);
      amounts.push(availableAmount);
    }

    const expectedLenders = [lender1.address, lender3.address];
    const expectedAssets = [tokenBAddress, tokenBAddress];
    const expectedAmounts = [approvedAmounts[0], approvedAmounts[2]];
    const expectedFee = expectedAmounts.reduce(
      (total, amount) => total + amount * DEFAULT_FEE_BPS / 10_000n,
      0n
    );

    expect(lenders).to.deep.equal(expectedLenders);
    expect(assets).to.deep.equal(expectedAssets);
    expect(amounts).to.deep.equal(expectedAmounts);

    await expect(receiverSimple.initiateFlashLoanBestEffort(
      lenders,
      assets,
      amounts,
      "0x"
    )).to.emit(flashLoan, "FlashLoan")
      .withArgs(
        receiverAddress,
        receiverAddress,
        expectedLenders,
        expectedAssets,
        expectedAmounts,
        [tokenBAddress],
        [expectedFee]
      );
  });

  it("runs fee-token override flow with aggregator and fallback pricing", async function () {
    const { flashLoan, feeVerifier, receiverSimple, tokenA, feeToken, admin, bookKeeper, lender1, feeRecipient } =
      await networkHelpers.loadFixture(deployFlashLoanFixture);
    const tokenAAddress = await tokenA.getAddress();
    const feeTokenAddress = await feeToken.getAddress();
    const amount = HUNDRED_TOKENS;
    const expectedFeeTokenAmount = ethers.parseEther("0.2");
    const aggregator = await deployAggregator(200_000_000n);

    await feeVerifier.connect(admin).setTokenUsdPriceAggregatorProxy([tokenAAddress], [await aggregator.getAddress()]);
    await feeVerifier.connect(bookKeeper).setTokenUsdPrice(feeTokenAddress, 5_000000000n);
    await feeVerifier.connect(admin).setAssetFeeToken([tokenAAddress], [feeTokenAddress]);
    await approve(tokenA, lender1, await flashLoan.getAddress(), HUNDRED_TOKENS);

    const feeRecipientBalanceBefore = await feeToken.balanceOf(feeRecipient.address);
    await receiverSimple.initiateFlashLoan([lender1.address], [tokenAAddress], [amount], "0x");

    expect(await feeToken.balanceOf(feeRecipient.address)).to.equal(
      feeRecipientBalanceBefore + expectedFeeTokenAmount
    );
  });

  it("uses updated fee bps on the next direct flash loan", async function () {
    const { flashLoan, feeVerifier, receiverSimple, tokenA, admin, lender1, feeRecipient } =
      await networkHelpers.loadFixture(deployFlashLoanFixture);
    const tokenAAddress = await tokenA.getAddress();
    const amount = HUNDRED_TOKENS;
    const initialFee = amount * DEFAULT_FEE_BPS / 10_000n;
    const updatedFeeBps = 25n;
    const updatedFee = amount * updatedFeeBps / 10_000n;

    await approve(tokenA, lender1, await flashLoan.getAddress(), amount * 2n);

    const feeRecipientBalanceBefore = await tokenA.balanceOf(feeRecipient.address);
    await receiverSimple.initiateFlashLoan([lender1.address], [tokenAAddress], [amount], "0x");
    const feeRecipientBalanceAfterFirstLoan = await tokenA.balanceOf(feeRecipient.address);
    expect(feeRecipientBalanceAfterFirstLoan).to.equal(feeRecipientBalanceBefore + initialFee);

    await feeVerifier.connect(admin).setFlashLoanFeeBps(updatedFeeBps);
    await receiverSimple.initiateFlashLoan([lender1.address], [tokenAAddress], [amount], "0x");

    expect(await tokenA.balanceOf(feeRecipient.address)).to.equal(
      feeRecipientBalanceAfterFirstLoan + updatedFee
    );
  });

  it("charges per-asset fee bps in a multi-token direct flash loan", async function () {
    const { flashLoan, feeVerifier, receiverSimple, tokenA, tokenB, admin, lender1, lender2, feeRecipient } =
      await networkHelpers.loadFixture(deployFlashLoanFixture);
    const flashLoanAddress = await flashLoan.getAddress();
    const receiverAddress = await receiverSimple.getAddress();
    const tokenAAddress = await tokenA.getAddress();
    const tokenBAddress = await tokenB.getAddress();
    const tokenAAmount = HUNDRED_TOKENS;
    const tokenBAmount = ethers.parseUnits("40", 6);
    const tokenAFeeBps = 25n;
    const tokenBFeeBps = 75n;
    const tokenAFee = tokenAAmount * tokenAFeeBps / 10_000n;
    const tokenBFee = tokenBAmount * tokenBFeeBps / 10_000n;

    await feeVerifier.connect(admin).setAssetFlashLoanFeeBps(
      [tokenAAddress, tokenBAddress],
      [tokenAFeeBps, tokenBFeeBps]
    );
    await approve(tokenA, lender1, flashLoanAddress, tokenAAmount);
    await approve(tokenB, lender2, flashLoanAddress, tokenBAmount);

    const tokenAFeeRecipientBalanceBefore = await tokenA.balanceOf(feeRecipient.address);
    const tokenBFeeRecipientBalanceBefore = await tokenB.balanceOf(feeRecipient.address);
    await expect(receiverSimple.initiateFlashLoan(
      [lender1.address, lender2.address],
      [tokenAAddress, tokenBAddress],
      [tokenAAmount, tokenBAmount],
      "0x"
    )).to.emit(flashLoan, "FlashLoan")
      .withArgs(
        receiverAddress,
        receiverAddress,
        [lender1.address, lender2.address],
        [tokenAAddress, tokenBAddress],
        [tokenAAmount, tokenBAmount],
        [tokenAAddress, tokenBAddress],
        [tokenAFee, tokenBFee]
      );
    expect(await tokenA.balanceOf(feeRecipient.address)).to.equal(
      tokenAFeeRecipientBalanceBefore + tokenAFee
    );
    expect(await tokenB.balanceOf(feeRecipient.address)).to.equal(
      tokenBFeeRecipientBalanceBefore + tokenBFee
    );
  });

  it("uses updated fee token on the next direct flash loan", async function () {
    const { flashLoan, feeVerifier, receiverSimple, tokenA, feeToken, admin, bookKeeper, lender1, feeRecipient } =
      await networkHelpers.loadFixture(deployFlashLoanFixture);
    const tokenAAddress = await tokenA.getAddress();
    const feeTokenAddress = await feeToken.getAddress();
    const amount = HUNDRED_TOKENS;
    const initialFee = amount * DEFAULT_FEE_BPS / 10_000n;
    const expectedFeeTokenAmount = ethers.parseEther("0.02");
    const aggregator = await deployAggregator(200_000_000n);

    await approve(tokenA, lender1, await flashLoan.getAddress(), amount * 2n);

    const tokenAFeeRecipientBalanceBefore = await tokenA.balanceOf(feeRecipient.address);
    const feeTokenBalanceBefore = await feeToken.balanceOf(feeRecipient.address);
    await receiverSimple.initiateFlashLoan([lender1.address], [tokenAAddress], [amount], "0x");
    const tokenAFeeRecipientBalanceAfterFirstLoan = await tokenA.balanceOf(feeRecipient.address);
    expect(tokenAFeeRecipientBalanceAfterFirstLoan).to.equal(tokenAFeeRecipientBalanceBefore + initialFee);
    expect(await feeToken.balanceOf(feeRecipient.address)).to.equal(feeTokenBalanceBefore);

    await feeVerifier.connect(admin).setTokenUsdPriceAggregatorProxy([tokenAAddress], [await aggregator.getAddress()]);
    await feeVerifier.connect(bookKeeper).setTokenUsdPrice(feeTokenAddress, 5_0000000000n);
    await feeVerifier.connect(admin).setAssetFeeToken([tokenAAddress], [feeTokenAddress]);
    await receiverSimple.initiateFlashLoan([lender1.address], [tokenAAddress], [amount], "0x");

    expect(await tokenA.balanceOf(feeRecipient.address)).to.equal(tokenAFeeRecipientBalanceAfterFirstLoan);
    expect(await feeToken.balanceOf(feeRecipient.address)).to.equal(
      feeTokenBalanceBefore + expectedFeeTokenAmount
    );
  });

  it("runs Permit2 allowance flow with SDK-signed PermitSingle data", async function () {
    const { flashLoan, permit2, receiverSimple, tokenA, lender1 } =
      await networkHelpers.loadFixture(deployFlashLoanFixture);
    const amount = ethers.parseEther("10");
    const fee = amount * DEFAULT_FEE_BPS / 10_000n;
    const receiverAddress = await receiverSimple.getAddress();
    const tokenAAddress = await tokenA.getAddress();
    const now = BigInt(await networkHelpers.time.latest());
    const permit = await signPermit2Allowance({
      owner: lender1,
      permit2: await permit2.getAddress(),
      spender: await flashLoan.getAddress(),
      token: tokenAAddress,
      amount,
      expiration: now + 3600n,
      nonce: 0n,
      sigDeadline: now + 3600n,
    });

    await approve(tokenA, lender1, await permit2.getAddress(), HUNDRED_TOKENS);
    await expect(receiverSimple.initiateFlashLoanWithPermit2(
      [lender1.address],
      [tokenAAddress],
      [amount],
      [permit],
      "0x"
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

    const [remaining,, nonce] = await permit2.allowance(lender1.address, tokenAAddress, await flashLoan.getAddress());
    expect(remaining).to.equal(0n);
    expect(nonce).to.equal(1n);
  });

  it("runs mixed Permit2 and direct-allowance best-effort flow", async function () {
    const { flashLoan, permit2, receiverSimple, tokenA, lender1, lender2 } =
      await networkHelpers.loadFixture(deployFlashLoanFixture);
    const amount = ethers.parseEther("10");
    const fee = amount * DEFAULT_FEE_BPS / 10_000n;
    const receiverAddress = await receiverSimple.getAddress();
    const tokenAAddress = await tokenA.getAddress();
    const now = BigInt(await networkHelpers.time.latest());
    const permit = await signPermit2Allowance({
      owner: lender1,
      permit2: await permit2.getAddress(),
      spender: await flashLoan.getAddress(),
      token: tokenAAddress,
      amount,
      expiration: now + 3600n,
      nonce: 0n,
      sigDeadline: now + 3600n,
    });

    await approve(tokenA, lender1, await permit2.getAddress(), HUNDRED_TOKENS);
    await approve(tokenA, lender2, await flashLoan.getAddress(), HUNDRED_TOKENS);
    await expect(receiverSimple.initiateFlashLoanBestEffortMix(
      [lender1.address, lender2.address],
      [tokenAAddress, tokenAAddress],
      [amount, amount],
      [permit, emptyPermit()],
      "0x"
    )).to.emit(flashLoan, "FlashLoan")
      .withArgs(
        receiverAddress,
        receiverAddress,
        [lender1.address, lender2.address],
        [tokenAAddress, tokenAAddress],
        [amount, amount],
        [tokenAAddress],
        [fee * 2n]
      );

    const [remaining] = await permit2.allowance(lender1.address, tokenAAddress, await flashLoan.getAddress());
    expect(remaining).to.equal(0n);
  });

  it("executes Rocketh deploy scripts locally and runs a deployed direct flow", async function () {
    const { flashLoan, feeVerifier, receiver, token, lender } =
      await networkHelpers.loadFixture(deployRockethFixture);
    const amount = ethers.parseEther("10");
    const fee = amount * (await feeVerifier.flashLoanFeeBps()) / 10_000n;
    const receiverAddress = ethers.getAddress(await receiver.getAddress());
    const tokenAddress = await token.getAddress();
    const feeRecipient = await feeVerifier.feeRecipient();
    const feeRecipientBalanceBefore = await token.balanceOf(feeRecipient);

    expect((await receiver.flashLoanContract()).toLowerCase()).to.equal(
      (await flashLoan.getAddress()).toLowerCase()
    );
    expect((await flashLoan.feeVerifier()).toLowerCase()).to.equal(
      (await feeVerifier.getAddress()).toLowerCase()
    );

    await expect(receiver.initiateFlashLoan(
      [lender.address],
      [tokenAddress],
      [amount],
      "0x"
    )).to.emit(flashLoan, "FlashLoan")
      .withArgs(
        receiverAddress,
        receiverAddress,
        [lender.address],
        [tokenAddress],
        [amount],
        [tokenAddress],
        [fee]
      );

    expect(await token.balanceOf(feeRecipient)).to.be.gt(feeRecipientBalanceBefore);
  });
});
