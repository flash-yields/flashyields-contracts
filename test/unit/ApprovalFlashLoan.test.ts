import { expect } from "chai";
import {
  DEFAULT_FEE_BPS,
  DEFAULT_MAX_STALENESS,
  HUNDRED_TOKENS,
  TOKEN_B_HUNDRED_TOKENS,
  ZERO_ADDRESS,
  approve,
  deployFlashLoanFixture,
  deployWithMockPermit2Fixture,
  ethers,
  executeTimelockCall,
  networkHelpers,
} from "../fixtures/deploy.js";
import { emptyPermit } from "../fixtures/permit2.js";

describe("ApprovalFlashLoan", function () {
  describe("constructor and admin controls", function () {
    it("validates constructor inputs", async function () {
      const { aclManager, feeVerifier, permit2, flashLoan } =
        await networkHelpers.loadFixture(deployFlashLoanFixture);

      await expect(ethers.deployContract("ApprovalFlashLoan", [
        ZERO_ADDRESS,
        await feeVerifier.getAddress(),
        await permit2.getAddress(),
      ])).to.be.revertedWithCustomError(flashLoan, "InvalidZeroAddress");
      await expect(ethers.deployContract("ApprovalFlashLoan", [
        await aclManager.getAddress(),
        ZERO_ADDRESS,
        await permit2.getAddress(),
      ])).to.be.revertedWithCustomError(flashLoan, "InvalidZeroAddress");
      await expect(ethers.deployContract("ApprovalFlashLoan", [
        await aclManager.getAddress(),
        await feeVerifier.getAddress(),
        ZERO_ADDRESS,
      ])).to.be.revertedWithCustomError(flashLoan, "InvalidZeroAddress");
    });

    it("pauses and unpauses through ACL roles", async function () {
      const { flashLoan, pauser, admin, aclManager, other, lender1, tokenA, receiver } =
        await networkHelpers.loadFixture(deployFlashLoanFixture);

      await expect(flashLoan.connect(other).pause())
        .to.be.revertedWithCustomError(aclManager, "NotPauserRole")
        .withArgs(other.address);
      await flashLoan.connect(pauser).pause();
      await expect(flashLoan.connect(other).unpause())
        .to.be.revertedWithCustomError(aclManager, "NotAdminRole")
        .withArgs(other.address);

      await approve(tokenA, lender1, await flashLoan.getAddress(), HUNDRED_TOKENS);
      await expect(flashLoan.flashLoan(
        await receiver.getAddress(),
        [lender1.address],
        [await tokenA.getAddress()],
        [ethers.parseEther("1")],
        "0x"
      )).to.be.revertedWithCustomError(flashLoan, "EnforcedPause");

      await flashLoan.connect(admin).unpause();
      expect(await flashLoan.paused()).to.equal(false);
    });

    it("updates fee verifier through timelock role", async function () {
      const { flashLoan, feeVerifier, aclManager, admin, timelockController, other, feeRecipient } =
        await networkHelpers.loadFixture(deployFlashLoanFixture);
      const nextFeeVerifier = await ethers.deployContract("FeeVerifier", [
        await aclManager.getAddress(),
        feeRecipient.address,
        DEFAULT_FEE_BPS,
        DEFAULT_MAX_STALENESS,
      ]);

      await expect(flashLoan.connect(other).setFeeVerifier(await nextFeeVerifier.getAddress()))
        .to.be.revertedWithCustomError(aclManager, "NotTimelockRole")
        .withArgs(other.address);
      await expect(executeTimelockCall(
        timelockController,
        admin,
        await flashLoan.getAddress(),
        flashLoan.interface.encodeFunctionData("setFeeVerifier", [await nextFeeVerifier.getAddress()])
      ))
        .to.emit(flashLoan, "FeeVerifierChanged")
        .withArgs(await nextFeeVerifier.getAddress());
      expect(await flashLoan.feeVerifier()).to.equal(await nextFeeVerifier.getAddress());
      expect(await feeVerifier.getAddress()).not.to.equal(await nextFeeVerifier.getAddress());
    });

    it("updates token blacklist through admin role", async function () {
      const { flashLoan, aclManager, admin, other, tokenA, tokenB } =
        await networkHelpers.loadFixture(deployFlashLoanFixture);
      const tokenAAddress = await tokenA.getAddress();
      const tokenBAddress = await tokenB.getAddress();

      await expect(flashLoan.connect(other).setTokenBlacklist([tokenAAddress], [true]))
        .to.be.revertedWithCustomError(aclManager, "NotAdminRole")
        .withArgs(other.address);
      await expect(flashLoan.connect(admin).setTokenBlacklist([tokenAAddress], []))
        .to.be.revertedWithCustomError(flashLoan, "ArrayLengthMismatch");
      await expect(flashLoan.connect(admin).setTokenBlacklist([ZERO_ADDRESS], [true]))
        .to.be.revertedWithCustomError(flashLoan, "InvalidZeroAddress");

      const setBlacklistTx = await flashLoan.connect(admin).setTokenBlacklist(
        [tokenAAddress, tokenBAddress],
        [true, false]
      );
      await expect(setBlacklistTx)
        .to.emit(flashLoan, "TokenBlacklistUpdated")
        .withArgs(tokenAAddress, true);
      await expect(setBlacklistTx)
        .to.emit(flashLoan, "TokenBlacklistUpdated")
        .withArgs(tokenBAddress, false);

      expect(await flashLoan.blacklistedTokens(tokenAAddress)).to.equal(true);
      expect(await flashLoan.blacklistedTokens(tokenBAddress)).to.equal(false);
    });
  });

  describe("direct flash loans", function () {
    it("executes a single-lender flash loan and pays fees", async function () {
      const { flashLoan, receiver, tokenA, lender1, feeRecipient, initiator } =
        await networkHelpers.loadFixture(deployFlashLoanFixture);
      const amount = ethers.parseEther("10");
      const fee = amount * DEFAULT_FEE_BPS / 10_000n;
      const tokenAAddress = await tokenA.getAddress();

      await approve(tokenA, lender1, await flashLoan.getAddress(), HUNDRED_TOKENS);
      const lenderBalanceBefore = await tokenA.balanceOf(lender1.address);
      const feeRecipientBalanceBefore = await tokenA.balanceOf(feeRecipient.address);

      await expect(flashLoan.connect(initiator).flashLoan(
        await receiver.getAddress(),
        [lender1.address],
        [tokenAAddress],
        [amount],
        "0x1234"
      )).to.emit(flashLoan, "FlashLoan")
        .withArgs(
          await receiver.getAddress(),
          initiator.address,
          [lender1.address],
          [tokenAAddress],
          [amount],
          [tokenAAddress],
          [fee]
        );

      expect(await tokenA.balanceOf(lender1.address)).to.equal(lenderBalanceBefore);
      expect(await tokenA.balanceOf(feeRecipient.address)).to.equal(feeRecipientBalanceBefore + fee);
      expect(await receiver.calls()).to.equal(1n);
      expect(await receiver.lastInitiator()).to.equal(initiator.address);
      expect(await receiver.lastParamsHash()).to.equal(ethers.keccak256("0x1234"));
    });

    it("emits empty fee data when the fee is zero", async function () {
      const { flashLoan, feeVerifier, receiver, tokenA, lender1, feeRecipient, admin, initiator } =
        await networkHelpers.loadFixture(deployFlashLoanFixture);
      const amount = ethers.parseEther("10");
      const tokenAAddress = await tokenA.getAddress();

      await feeVerifier.connect(admin).setFlashLoanFeeBps(0n);
      await approve(tokenA, lender1, await flashLoan.getAddress(), HUNDRED_TOKENS);
      const feeRecipientBalanceBefore = await tokenA.balanceOf(feeRecipient.address);

      await expect(flashLoan.connect(initiator).flashLoan(
        await receiver.getAddress(),
        [lender1.address],
        [tokenAAddress],
        [amount],
        "0x"
      )).to.emit(flashLoan, "FlashLoan")
        .withArgs(
          await receiver.getAddress(),
          initiator.address,
          [lender1.address],
          [tokenAAddress],
          [amount],
          [],
          []
        );

      expect(await tokenA.balanceOf(feeRecipient.address)).to.equal(feeRecipientBalanceBefore);
    });

    it("handles multiple lenders, assets, and duplicate fee assets", async function () {
      const { flashLoan, receiver, tokenA, tokenB, lender1, lender2, lender3 } =
        await networkHelpers.loadFixture(deployFlashLoanFixture);

      await approve(tokenA, lender1, await flashLoan.getAddress(), HUNDRED_TOKENS);
      await approve(tokenA, lender2, await flashLoan.getAddress(), HUNDRED_TOKENS);
      await approve(tokenB, lender3, await flashLoan.getAddress(), TOKEN_B_HUNDRED_TOKENS);
      const lender1BalanceBefore = await tokenA.balanceOf(lender1.address);
      const lender2BalanceBefore = await tokenA.balanceOf(lender2.address);
      const lender3BalanceBefore = await tokenB.balanceOf(lender3.address);

      await flashLoan.flashLoan(
        await receiver.getAddress(),
        [lender1.address, lender2.address, lender3.address],
        [await tokenA.getAddress(), await tokenA.getAddress(), await tokenB.getAddress()],
        [ethers.parseEther("10"), ethers.parseEther("5"), ethers.parseUnits("7", 6)],
        "0x"
      );

      expect(await tokenA.balanceOf(lender1.address)).to.equal(lender1BalanceBefore);
      expect(await tokenA.balanceOf(lender2.address)).to.equal(lender2BalanceBefore);
      expect(await tokenB.balanceOf(lender3.address)).to.equal(lender3BalanceBefore);
      expect(await receiver.lastLenderCount()).to.equal(3n);
      expect(await receiver.lastFeeAssetCount()).to.equal(2n);
    });

    it("reverts on invalid inputs and insufficient allowance", async function () {
      const { flashLoan, receiver, tokenA, lender1 } = await networkHelpers.loadFixture(deployFlashLoanFixture);

      await expect(flashLoan.flashLoan(await receiver.getAddress(), [], [], [], "0x"))
        .to.be.revertedWithCustomError(flashLoan, "EmptyArrays");
      await expect(flashLoan.flashLoan(await receiver.getAddress(), [lender1.address], [], [], "0x"))
        .to.be.revertedWithCustomError(flashLoan, "ArrayLengthMismatch");
      await expect(flashLoan.flashLoan(
        await receiver.getAddress(),
        [lender1.address],
        [await tokenA.getAddress()],
        [0n],
        "0x"
      )).to.be.revertedWithCustomError(flashLoan, "AmountMustBePositive");
      await expect(flashLoan.flashLoan(
        await receiver.getAddress(),
        [lender1.address],
        [await tokenA.getAddress()],
        [1n],
        "0x"
      )).to.be.revertedWithCustomError(tokenA, "ERC20InsufficientAllowance")
        .withArgs(await flashLoan.getAddress(), 0n, 1n);
    });

    it("rejects blacklisted borrowed tokens", async function () {
      const { flashLoan, receiver, tokenA, lender1, admin } =
        await networkHelpers.loadFixture(deployFlashLoanFixture);
      const tokenAAddress = await tokenA.getAddress();

      await flashLoan.connect(admin).setTokenBlacklist([tokenAAddress], [true]);
      await approve(tokenA, lender1, await flashLoan.getAddress(), HUNDRED_TOKENS);

      await expect(flashLoan.flashLoan(
        await receiver.getAddress(),
        [lender1.address],
        [tokenAAddress],
        [ethers.parseEther("10")],
        "0x"
      )).to.be.revertedWithCustomError(flashLoan, "TokenBlacklisted")
        .withArgs(tokenAAddress);
    });

    it("reverts when the receiver fails, underpays principal, or underpays fees", async function () {
      const { flashLoan, receiver, tokenA, lender1 } = await networkHelpers.loadFixture(deployFlashLoanFixture);
      const amount = ethers.parseEther("10");
      await approve(tokenA, lender1, await flashLoan.getAddress(), HUNDRED_TOKENS);

      await receiver.configure(true, false, false, false, 0n, 0n);
      await expect(flashLoan.flashLoan(
        await receiver.getAddress(),
        [lender1.address],
        [await tokenA.getAddress()],
        [amount],
        "0x"
      )).to.be.revertedWithCustomError(flashLoan, "ReceiverExecutionFailed");

      await receiver.configure(false, false, false, false, 1n, 0n);
      await expect(flashLoan.flashLoan(
        await receiver.getAddress(),
        [lender1.address],
        [await tokenA.getAddress()],
        [amount],
        "0x"
      )).to.be.revertedWithCustomError(tokenA, "ERC20InsufficientAllowance")
        .withArgs(await flashLoan.getAddress(), amount - 1n, amount);

      await receiver.configure(false, false, false, false, 0n, 1n);
      await expect(flashLoan.flashLoan(
        await receiver.getAddress(),
        [lender1.address],
        [await tokenA.getAddress()],
        [amount],
        "0x"
      )).to.be.revertedWithCustomError(flashLoan, "FlashLoanNotRepaid");
    });

    it("blocks reentrancy from the receiver callback", async function () {
      const { flashLoan, receiver, tokenA, lender1 } = await networkHelpers.loadFixture(deployFlashLoanFixture);
      await approve(tokenA, lender1, await flashLoan.getAddress(), HUNDRED_TOKENS);
      await receiver.configure(false, false, false, true, 0n, 0n);

      await expect(flashLoan.flashLoan(
        await receiver.getAddress(),
        [lender1.address],
        [await tokenA.getAddress()],
        [ethers.parseEther("1")],
        "0x"
      )).to.be.revertedWithCustomError(flashLoan, "ReentrancyGuardReentrantCall");
    });
  });

  describe("best-effort direct flash loans", function () {
    it("skips lenders with insufficient direct allowance", async function () {
      const { flashLoan, receiver, tokenA, lender1, lender2, deployer } =
        await networkHelpers.loadFixture(deployFlashLoanFixture);
      const tokenAAddress = await tokenA.getAddress();
      const amount = ethers.parseEther("10");
      const fee = amount * DEFAULT_FEE_BPS / 10_000n;

      await approve(tokenA, lender1, await flashLoan.getAddress(), HUNDRED_TOKENS);
      const tx = await flashLoan.flashLoanBestEffort(
        await receiver.getAddress(),
        [lender1.address, lender2.address],
        [tokenAAddress, tokenAAddress],
        [amount, amount],
        "0x"
      );

      await expect(tx).to.emit(flashLoan, "FlashLoan")
        .withArgs(
          await receiver.getAddress(),
          deployer.address,
          [lender1.address],
          [tokenAAddress],
          [amount],
          [tokenAAddress],
          [fee]
        );
      expect(await receiver.lastLenderCount()).to.equal(1n);
    });

    it("skips lenders with insufficient direct balance", async function () {
      const { flashLoan, receiver, tokenA, lender1, lender2, deployer } =
        await networkHelpers.loadFixture(deployFlashLoanFixture);
      const tokenAAddress = await tokenA.getAddress();
      const validAmount = ethers.parseEther("10");
      const overBalanceAmount = HUNDRED_TOKENS + 1n;
      const fee = validAmount * DEFAULT_FEE_BPS / 10_000n;

      await approve(tokenA, lender1, await flashLoan.getAddress(), HUNDRED_TOKENS);
      await approve(tokenA, lender2, await flashLoan.getAddress(), overBalanceAmount);
      const tx = await flashLoan.flashLoanBestEffort(
        await receiver.getAddress(),
        [lender1.address, lender2.address],
        [tokenAAddress, tokenAAddress],
        [validAmount, overBalanceAmount],
        "0x"
      );

      await expect(tx).to.emit(flashLoan, "FlashLoan")
        .withArgs(
          await receiver.getAddress(),
          deployer.address,
          [lender1.address],
          [tokenAAddress],
          [validAmount],
          [tokenAAddress],
          [fee]
        );
      expect(await receiver.lastLenderCount()).to.equal(1n);
    });

    it("skips blacklisted tokens", async function () {
      const { flashLoan, receiver, tokenA, tokenB, lender1, lender2, admin, deployer } =
        await networkHelpers.loadFixture(deployFlashLoanFixture);
      const tokenAAddress = await tokenA.getAddress();
      const tokenBAddress = await tokenB.getAddress();
      const tokenAAmount = ethers.parseEther("10");
      const tokenBAmount = ethers.parseUnits("7", 6);
      const tokenBFee = tokenBAmount * DEFAULT_FEE_BPS / 10_000n;

      await flashLoan.connect(admin).setTokenBlacklist([tokenAAddress], [true]);
      await approve(tokenA, lender1, await flashLoan.getAddress(), HUNDRED_TOKENS);
      await approve(tokenB, lender2, await flashLoan.getAddress(), TOKEN_B_HUNDRED_TOKENS);

      const tx = await flashLoan.flashLoanBestEffort(
        await receiver.getAddress(),
        [lender1.address, lender2.address],
        [tokenAAddress, tokenBAddress],
        [tokenAAmount, tokenBAmount],
        "0x"
      );

      await expect(tx).to.emit(flashLoan, "FlashLoan")
        .withArgs(
          await receiver.getAddress(),
          deployer.address,
          [lender2.address],
          [tokenBAddress],
          [tokenBAmount],
          [tokenBAddress],
          [tokenBFee]
        );
      expect(await receiver.lastLenderCount()).to.equal(1n);
    });

    it("reverts when no lenders remain after filtering", async function () {
      const { flashLoan, receiver, tokenA, lender1 } = await networkHelpers.loadFixture(deployFlashLoanFixture);

      await expect(flashLoan.flashLoanBestEffort(
        await receiver.getAddress(),
        [lender1.address],
        [await tokenA.getAddress()],
        [ethers.parseEther("10")],
        "0x"
      )).to.be.revertedWithCustomError(flashLoan, "NoValidLenders");
    });
  });

  describe("Permit2 and mixed best-effort paths", function () {
    it("uses an existing Permit2 allowance in the all-or-nothing Permit2 entry point", async function () {
      const { flashLoan, receiver, tokenA, lender1, permit2, deployer } =
        await networkHelpers.loadFixture(deployWithMockPermit2Fixture);
      const tokenAAddress = await tokenA.getAddress();
      const amount = ethers.parseEther("10");
      const fee = amount * DEFAULT_FEE_BPS / 10_000n;
      const expiration = BigInt(await networkHelpers.time.latest()) + 3600n;

      await approve(tokenA, lender1, await permit2.getAddress(), HUNDRED_TOKENS);
      await permit2.setAllowance(lender1.address, tokenAAddress, await flashLoan.getAddress(), amount, expiration, 0n);

      const tx = await flashLoan.flashLoanWithPermit2(
        await receiver.getAddress(),
        [lender1.address],
        [tokenAAddress],
        [amount],
        [emptyPermit()],
        "0x"
      );
      await expect(tx).to.emit(flashLoan, "FlashLoan")
        .withArgs(
          await receiver.getAddress(),
          deployer.address,
          [lender1.address],
          [tokenAAddress],
          [amount],
          [tokenAAddress],
          [fee]
        );
      expect(await receiver.lastLenderCount()).to.equal(1n);
    });

    it("sets Permit2 allowance from permit data when needed", async function () {
      const { flashLoan, receiver, tokenA, lender1, permit2 } =
        await networkHelpers.loadFixture(deployWithMockPermit2Fixture);
      const amount = ethers.parseEther("10");
      const now = BigInt(await networkHelpers.time.latest());

      await approve(tokenA, lender1, await permit2.getAddress(), HUNDRED_TOKENS);
      await flashLoan.flashLoanWithPermit2(
        await receiver.getAddress(),
        [lender1.address],
        [await tokenA.getAddress()],
        [amount],
        [{
          amount,
          expiration: now + 3600n,
          nonce: 7n,
          sigDeadline: now + 3600n,
          signature: "0x1234",
        }],
        "0x"
      );
      const [remaining,, nonce] = await permit2.allowance(lender1.address, await tokenA.getAddress(), await flashLoan.getAddress());
      expect(remaining).to.equal(0n);
      expect(nonce).to.equal(8n);
    });

    it("skips invalid signed rows but keeps empty-permit direct allowance rows in the mixed path", async function () {
      const { flashLoan, receiver, tokenA, lender1, lender2, permit2, deployer } =
        await networkHelpers.loadFixture(deployWithMockPermit2Fixture);
      const tokenAAddress = await tokenA.getAddress();
      const amount1 = ethers.parseEther("10");
      const amount2 = ethers.parseEther("100");
      const fee = amount2 * DEFAULT_FEE_BPS / 10_000n;
      const now = BigInt(await networkHelpers.time.latest());

      await approve(tokenA, lender1, await permit2.getAddress(), HUNDRED_TOKENS);
      await approve(tokenA, lender2, await flashLoan.getAddress(), HUNDRED_TOKENS);
      await permit2.setPermitShouldRevert(true);

      const tx = await flashLoan.flashLoanBestEffortMix(
        await receiver.getAddress(),
        [lender1.address, lender2.address],
        [tokenAAddress, tokenAAddress],
        [amount1, amount2],
        [{
          amount: amount1,
          expiration: now + 3600n,
          nonce: 0n,
          sigDeadline: now + 3600n,
          signature: "0x1234",
        }, emptyPermit()],
        "0x"
      );
      await expect(tx).to.emit(flashLoan, "FlashLoan")
        .withArgs(
          await receiver.getAddress(),
          deployer.address,
          [lender2.address],
          [tokenAAddress],
          [amount2],
          [tokenAAddress],
          [fee]
        );
      expect(await receiver.lastLenderCount()).to.equal(1n);
    });

    it("skips mixed signed and direct rows with insufficient balance", async function () {
      const { flashLoan, receiver, tokenA, lender1, lender2, lender3, permit2, deployer } =
        await networkHelpers.loadFixture(deployWithMockPermit2Fixture);
      const tokenAAddress = await tokenA.getAddress();
      const validAmount = ethers.parseEther("10");
      const overBalanceAmount = HUNDRED_TOKENS + 1n;
      const fee = validAmount * DEFAULT_FEE_BPS / 10_000n;
      const now = BigInt(await networkHelpers.time.latest());

      await approve(tokenA, lender1, await permit2.getAddress(), overBalanceAmount);
      await approve(tokenA, lender2, await flashLoan.getAddress(), overBalanceAmount);
      await approve(tokenA, lender3, await flashLoan.getAddress(), HUNDRED_TOKENS);

      const tx = await flashLoan.flashLoanBestEffortMix(
        await receiver.getAddress(),
        [lender1.address, lender2.address, lender3.address],
        [tokenAAddress, tokenAAddress, tokenAAddress],
        [overBalanceAmount, overBalanceAmount, validAmount],
        [{
          amount: overBalanceAmount,
          expiration: now + 3600n,
          nonce: 0n,
          sigDeadline: now + 3600n,
          signature: "0x1234",
        }, emptyPermit(), emptyPermit()],
        "0x"
      );
      await expect(tx).to.emit(flashLoan, "FlashLoan")
        .withArgs(
          await receiver.getAddress(),
          deployer.address,
          [lender3.address],
          [tokenAAddress],
          [validAmount],
          [tokenAAddress],
          [fee]
        );
      expect(await receiver.lastLenderCount()).to.equal(1n);
    });

    it("reverts mixed path when all signed and direct rows are invalid", async function () {
      const { flashLoan, receiver, tokenA, lender1, permit2 } =
        await networkHelpers.loadFixture(deployWithMockPermit2Fixture);
      const now = BigInt(await networkHelpers.time.latest());

      await permit2.setPermitShouldRevert(true);
      await expect(flashLoan.flashLoanBestEffortMix(
        await receiver.getAddress(),
        [lender1.address],
        [await tokenA.getAddress()],
        [ethers.parseEther("10")],
        [{
          amount: ethers.parseEther("10"),
          expiration: now + 3600n,
          nonce: 0n,
          sigDeadline: now + 3600n,
          signature: "0x1234",
        }],
        "0x"
      )).to.be.revertedWithCustomError(flashLoan, "NoValidLenders");
    });

    it("rejects all-or-nothing Permit2 amounts that exceed uint160", async function () {
      const { flashLoan, receiver, tokenA, lender1 } = await networkHelpers.loadFixture(deployFlashLoanFixture);

      await expect(flashLoan.flashLoanWithPermit2(
        await receiver.getAddress(),
        [lender1.address],
        [await tokenA.getAddress()],
        [1n << 160n],
        [emptyPermit()],
        "0x"
      )).to.be.revertedWithCustomError(flashLoan, "AmountExceedsPermit2Max");
    });

    it("rejects blacklisted tokens in the all-or-nothing Permit2 path", async function () {
      const { flashLoan, receiver, tokenA, lender1, admin } =
        await networkHelpers.loadFixture(deployWithMockPermit2Fixture);
      const tokenAAddress = await tokenA.getAddress();

      await flashLoan.connect(admin).setTokenBlacklist([tokenAAddress], [true]);

      await expect(flashLoan.flashLoanWithPermit2(
        await receiver.getAddress(),
        [lender1.address],
        [tokenAAddress],
        [ethers.parseEther("10")],
        [emptyPermit()],
        "0x"
      )).to.be.revertedWithCustomError(flashLoan, "TokenBlacklisted")
        .withArgs(tokenAAddress);
    });

    it("skips blacklisted tokens in the mixed best-effort path", async function () {
      const { flashLoan, receiver, tokenA, tokenB, lender1, lender2, admin } =
        await networkHelpers.loadFixture(deployWithMockPermit2Fixture);
      const tokenAAddress = await tokenA.getAddress();
      const tokenBAddress = await tokenB.getAddress();
      const now = BigInt(await networkHelpers.time.latest());

      await flashLoan.connect(admin).setTokenBlacklist([tokenAAddress], [true]);
      await approve(tokenB, lender2, await flashLoan.getAddress(), TOKEN_B_HUNDRED_TOKENS);

      await flashLoan.flashLoanBestEffortMix(
        await receiver.getAddress(),
        [lender1.address, lender2.address],
        [tokenAAddress, tokenBAddress],
        [ethers.parseEther("10"), ethers.parseUnits("7", 6)],
        [{
          amount: ethers.parseEther("10"),
          expiration: now + 3600n,
          nonce: 0n,
          sigDeadline: now + 3600n,
          signature: "0x1234",
        }, emptyPermit()],
        "0x"
      );

      expect(await receiver.lastLenderCount()).to.equal(1n);
    });
  });
});
