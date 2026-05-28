import { expect } from "chai";
import {
  HUNDRED_TOKENS,
  TOKEN_B_HUNDRED_TOKENS,
  ZERO_ADDRESS,
  approve,
  deployFlashLoanFixture,
  deployToken,
  ethers,
  mint,
  networkHelpers,
} from "../fixtures/deploy.js";

describe("LenderRegistry", function () {
  describe("constructor", function () {
    it("stores immutable flash-loan and ACL manager references", async function () {
      const { lenderRegistry, flashLoan, aclManager } =
        await networkHelpers.loadFixture(deployFlashLoanFixture);

      expect(await lenderRegistry.approvalFlashLoan()).to.equal(await flashLoan.getAddress());
      expect(await lenderRegistry.aclManager()).to.equal(await aclManager.getAddress());
    });

    it("rejects zero flash-loan address", async function () {
      const { lenderRegistry } =
        await networkHelpers.loadFixture(deployFlashLoanFixture);

      await expect(ethers.deployContract("LenderRegistry", [
        ZERO_ADDRESS,
      ])).to.be.revertedWithCustomError(lenderRegistry, "InvalidZeroAddress");
    });
  });

  describe("participation", function () {
    it("rejects blacklisted tokens when indicating participation", async function () {
      const { lenderRegistry, flashLoan, admin, lender1, tokenA, tokenB } =
        await networkHelpers.loadFixture(deployFlashLoanFixture);
      const tokenAAddress = await tokenA.getAddress();
      const tokenBAddress = await tokenB.getAddress();

      await lenderRegistry.connect(admin).setPermissionlessParticipationEnabled(true);
      await flashLoan.connect(admin).setTokenBlacklist([tokenAAddress], [true]);

      await expect(lenderRegistry.connect(lender1).indicateParticipation([tokenBAddress, tokenAAddress]))
        .to.be.revertedWithCustomError(lenderRegistry, "TokenBlacklisted")
        .withArgs(tokenAAddress);

      expect(await lenderRegistry.potentialTokens(tokenAAddress)).to.equal(false);
      expect(await lenderRegistry.potentialTokens(tokenBAddress)).to.equal(false);
    });

    it("skips blacklisted tokens in availability views", async function () {
      const { lenderRegistry, flashLoan, admin, lender1, lender2, tokenA, tokenB } =
        await networkHelpers.loadFixture(deployFlashLoanFixture);
      const flashLoanAddress = await flashLoan.getAddress();
      const tokenAAddress = await tokenA.getAddress();
      const tokenBAddress = await tokenB.getAddress();

      await lenderRegistry.connect(admin).setPermissionlessParticipationEnabled(true);
      await lenderRegistry.connect(lender1).indicateParticipation([tokenAAddress, tokenBAddress]);
      await lenderRegistry.connect(lender2).indicateParticipation([tokenAAddress]);
      await approve(tokenA, lender1, flashLoanAddress, HUNDRED_TOKENS);
      await approve(tokenB, lender1, flashLoanAddress, ethers.MaxUint256);
      await approve(tokenA, lender2, flashLoanAddress, HUNDRED_TOKENS);

      await flashLoan.connect(admin).setTokenBlacklist([tokenAAddress], [true]);

      expect(await lenderRegistry.potentialTokens(tokenAAddress)).to.equal(false);
      expect(await lenderRegistry.potentialTokens(tokenBAddress)).to.equal(true);

      const allAvailability = await lenderRegistry.getAllPotentialLendersAvailability();
      expect(allAvailability).to.have.lengthOf(1);
      expect(allAvailability[0].token).to.equal(tokenBAddress);
      expect([...allAvailability[0].lenders]).to.deep.equal([lender1.address]);
      expect([...allAvailability[0].availableAmounts]).to.deep.equal([TOKEN_B_HUNDRED_TOKENS]);

      const tokenAAvailability = await lenderRegistry.getPotentialLendersAvailabilityByToken(tokenAAddress);
      expect(tokenAAvailability).to.have.lengthOf(0);

      const tokenARequestedAvailability = await lenderRegistry.getAvailableAmountsByTokenAndLenders(tokenAAddress, [
        lender1.address,
        lender2.address,
      ]);
      expect([...tokenARequestedAvailability]).to.deep.equal([0n, 0n]);

      const tokenBAvailability = await lenderRegistry.getPotentialLendersAvailabilityByToken(tokenBAddress);
      expect(tokenBAvailability).to.have.lengthOf(1);
      expect(tokenBAvailability[0]).to.deep.equal([lender1.address, TOKEN_B_HUNDRED_TOKENS]);
    });

    it("returns available amounts for user-provided lenders without using lenderList storage", async function () {
      const { lenderRegistry, flashLoan, admin, lender1, lender2, lender3, other, tokenA } =
        await networkHelpers.loadFixture(deployFlashLoanFixture);
      const flashLoanAddress = await flashLoan.getAddress();
      const tokenAAddress = await tokenA.getAddress();

      await lenderRegistry.connect(admin).setPermissionlessParticipationEnabled(true);
      await lenderRegistry.connect(lender1).indicateParticipation([tokenAAddress]);
      await approve(tokenA, lender1, flashLoanAddress, ethers.parseEther("40"));
      await approve(tokenA, lender2, flashLoanAddress, ethers.parseEther("75"));
      await approve(tokenA, lender3, flashLoanAddress, ethers.MaxUint256);
      await approve(tokenA, other, flashLoanAddress, ethers.MaxUint256);

      const availableAmounts = await lenderRegistry.getAvailableAmountsByTokenAndLenders(tokenAAddress, [
        lender2.address,
        other.address,
        lender1.address,
        lender3.address,
      ]);

      expect([...availableAmounts]).to.deep.equal([
        ethers.parseEther("75"),
        0n,
        ethers.parseEther("40"),
        HUNDRED_TOKENS,
      ]);
    });

    it("lets the bookkeeper indicate participation for multiple lenders", async function () {
      const { lenderRegistry, flashLoan, bookKeeper, lender1, lender2, tokenA, tokenB } =
        await networkHelpers.loadFixture(deployFlashLoanFixture);
      const flashLoanAddress = await flashLoan.getAddress();
      const tokenAAddress = await tokenA.getAddress();
      const tokenBAddress = await tokenB.getAddress();

      await lenderRegistry.connect(bookKeeper).indicateParticipationFor([
        {
          token: tokenAAddress,
          lenders: [lender1.address, lender2.address, lender1.address],
        },
        {
          token: tokenBAddress,
          lenders: [lender1.address],
        },
      ]);
      await approve(tokenA, lender1, flashLoanAddress, ethers.parseEther("75"));
      await approve(tokenB, lender1, flashLoanAddress, ethers.MaxUint256);
      await approve(tokenA, lender2, flashLoanAddress, HUNDRED_TOKENS);

      const tokenAAvailability = await lenderRegistry.getPotentialLendersAvailabilityByToken(tokenAAddress);
      expect(tokenAAvailability).to.have.lengthOf(2);
      expect(tokenAAvailability.map(({ lender }) => lender)).to.deep.equal([lender1.address, lender2.address]);
      expect(tokenAAvailability.map(({ availableAmount }) => availableAmount)).to.deep.equal([
        ethers.parseEther("75"),
        HUNDRED_TOKENS,
      ]);

      const tokenBAvailability = await lenderRegistry.getPotentialLendersAvailabilityByToken(tokenBAddress);
      expect(tokenBAvailability).to.have.lengthOf(1);
      expect(tokenBAvailability[0]).to.deep.equal([lender1.address, TOKEN_B_HUNDRED_TOKENS]);
    });

    it("restricts bookkeeper-managed participation", async function () {
      const { lenderRegistry, aclManager, lender1, lender2, tokenA } =
        await networkHelpers.loadFixture(deployFlashLoanFixture);
      const tokenAAddress = await tokenA.getAddress();

      await expect(lenderRegistry.connect(lender1).indicateParticipationFor([
        {
          token: tokenAAddress,
          lenders: [lender2.address],
        },
      ])).to.be.revertedWithCustomError(aclManager, "NotBookKeeperRole")
        .withArgs(lender1.address);
    });

    it("keeps permissionless participation disabled by default while bookkeeper updates still work", async function () {
      const { lenderRegistry, aclManager, admin, lender1, bookKeeper, tokenA } =
        await networkHelpers.loadFixture(deployFlashLoanFixture);
      const tokenAAddress = await tokenA.getAddress();

      expect(await lenderRegistry.permissionlessParticipationEnabled()).to.equal(false);

      await expect(lenderRegistry.connect(lender1).setPermissionlessParticipationEnabled(true))
        .to.be.revertedWithCustomError(aclManager, "NotAdminRole")
        .withArgs(lender1.address);

      await expect(lenderRegistry.connect(lender1).indicateParticipation([tokenAAddress]))
        .to.be.revertedWithCustomError(lenderRegistry, "PermissionlessParticipationDisabled");

      await expect(lenderRegistry.connect(lender1).removeParticipation([tokenAAddress]))
        .to.be.revertedWithCustomError(lenderRegistry, "PermissionlessParticipationDisabled");

      await lenderRegistry.connect(bookKeeper).indicateParticipationFor([
        {
          token: tokenAAddress,
          lenders: [lender1.address],
        },
      ]);
      expect(await lenderRegistry.potentialTokens(tokenAAddress)).to.equal(true);

      await lenderRegistry.connect(bookKeeper).removeParticipationFor([
        {
          token: tokenAAddress,
          lenders: [lender1.address],
        },
      ]);
      expect(await lenderRegistry.potentialTokens(tokenAAddress)).to.equal(false);

      await expect(lenderRegistry.connect(admin).setPermissionlessParticipationEnabled(true))
        .to.emit(lenderRegistry, "PermissionlessParticipationUpdated")
        .withArgs(true);

      expect(await lenderRegistry.permissionlessParticipationEnabled()).to.equal(true);

      await lenderRegistry.connect(lender1).indicateParticipation([tokenAAddress]);
      expect(await lenderRegistry.potentialTokens(tokenAAddress)).to.equal(true);
    });

    it("returns availability for six lenders across four tokens", async function () {
      const {
        lenderRegistry,
        flashLoan,
        admin,
        lender1,
        lender2,
        lender3,
        initiator,
        feeRecipient,
        other,
        tokenA,
        tokenB,
        feeToken,
      } = await networkHelpers.loadFixture(deployFlashLoanFixture);
      const flashLoanAddress = await flashLoan.getAddress();
      const tokenC = await deployToken("Token C", "TKNC", 8);
      const tokenAAddress = await tokenA.getAddress();
      const tokenBAddress = await tokenB.getAddress();
      const feeTokenAddress = await feeToken.getAddress();
      const tokenCAddress = await tokenC.getAddress();
      const tokenCAmount = ethers.parseUnits("100", 8);

      await mint(tokenB, initiator.address, TOKEN_B_HUNDRED_TOKENS);
      await mint(feeToken, feeRecipient.address, HUNDRED_TOKENS);
      await mint(tokenC, other.address, tokenCAmount);

      const tokenConfigs = [
        {
          token: tokenA,
          address: tokenAAddress,
          lenders: [lender1, lender2, lender3],
          allowances: [
            ethers.MaxUint256,
            ethers.parseEther("75"),
            ethers.parseEther("125"),
          ],
          expectedAmounts: [
            HUNDRED_TOKENS,
            ethers.parseEther("75"),
            HUNDRED_TOKENS,
          ],
        },
        {
          token: tokenB,
          address: tokenBAddress,
          lenders: [initiator],
          allowances: [ethers.parseUnits("80", 6)],
          expectedAmounts: [ethers.parseUnits("80", 6)],
        },
        {
          token: feeToken,
          address: feeTokenAddress,
          lenders: [feeRecipient],
          allowances: [ethers.parseEther("150")],
          expectedAmounts: [HUNDRED_TOKENS],
        },
        {
          token: tokenC,
          address: tokenCAddress,
          lenders: [other],
          allowances: [ethers.parseUnits("1", 8)],
          expectedAmounts: [ethers.parseUnits("1", 8)],
        },
      ];

      await lenderRegistry.connect(admin).setPermissionlessParticipationEnabled(true);
      for (const config of tokenConfigs) {
        for (const [lenderIndex, lender] of config.lenders.entries()) {
          await lenderRegistry.connect(lender).indicateParticipation([config.address]);
          await approve(config.token, lender, flashLoanAddress, config.allowances[lenderIndex]);
        }
      }

      const allAvailability = await lenderRegistry.getAllPotentialLendersAvailability();
      expect(allAvailability).to.have.lengthOf(tokenConfigs.length);

      for (const [tokenIndex, config] of tokenConfigs.entries()) {
        const lenderAddresses = config.lenders.map((lender) => lender.address);

        expect(allAvailability[tokenIndex].token).to.equal(config.address);
        expect([...allAvailability[tokenIndex].lenders]).to.deep.equal(lenderAddresses);
        expect([...allAvailability[tokenIndex].availableAmounts]).to.deep.equal(config.expectedAmounts);

        const tokenAvailability = await lenderRegistry.getPotentialLendersAvailabilityByToken(config.address);
        expect(tokenAvailability).to.have.lengthOf(config.lenders.length);
        expect(tokenAvailability.map(({ lender }) => lender)).to.deep.equal(lenderAddresses);
        expect(tokenAvailability.map(({ availableAmount }) => availableAmount)).to.deep.equal(config.expectedAmounts);
      }
    });
  });

  describe("registry reset", function () {
    it("moves participation to a fresh registry set", async function () {
      const { lenderRegistry, flashLoan, aclManager, admin, bookKeeper, lender1, lender2, tokenA } =
        await networkHelpers.loadFixture(deployFlashLoanFixture);
      const flashLoanAddress = await flashLoan.getAddress();
      const tokenAAddress = await tokenA.getAddress();

      await lenderRegistry.connect(admin).setPermissionlessParticipationEnabled(true);
      await lenderRegistry.connect(lender1).indicateParticipation([tokenAAddress]);
      await lenderRegistry.connect(lender2).indicateParticipation([tokenAAddress]);
      await approve(tokenA, lender1, flashLoanAddress, HUNDRED_TOKENS);
      await approve(tokenA, lender2, flashLoanAddress, HUNDRED_TOKENS - 1n);

      const before = await lenderRegistry.getPotentialLendersAvailabilityByToken(tokenAAddress);
      expect(before).to.have.lengthOf(2);
      expect(before[0].lender).to.equal(lender1.address);
      expect(before[0].availableAmount).to.equal(HUNDRED_TOKENS);
      expect(before[1].lender).to.equal(lender2.address);
      expect(before[1].availableAmount).to.equal(HUNDRED_TOKENS - 1n);
      expect(await lenderRegistry.currentRegistrySetId()).to.equal(0n);
      expect(await lenderRegistry.getAllPotentialLendersAvailability()).to.have.lengthOf(1);
      expect(await lenderRegistry.getTotalPotentialLenders()).to.equal(2n);

      await expect(lenderRegistry.connect(lender1).resetRegistrySet())
        .to.be.revertedWithCustomError(aclManager, "NotBookKeeperRole")
        .withArgs(lender1.address);

      await expect(lenderRegistry.connect(admin).resetRegistrySet())
        .to.be.revertedWithCustomError(aclManager, "NotBookKeeperRole")
        .withArgs(admin.address);

      await expect(lenderRegistry.connect(bookKeeper).resetRegistrySet())
        .to.emit(lenderRegistry, "RegistrySetReset")
        .withArgs(1n);

      expect(await lenderRegistry.currentRegistrySetId()).to.equal(1n);
      expect(await lenderRegistry.potentialTokens(tokenAAddress)).to.equal(false);
      expect(await lenderRegistry.getTotalPotentialLenders()).to.equal(0n);
      expect(await lenderRegistry.getAllPotentialLendersAvailability()).to.have.lengthOf(0);
      expect(await lenderRegistry.getPotentialLendersAvailabilityByToken(tokenAAddress)).to.have.lengthOf(0);

      await lenderRegistry.connect(lender2).indicateParticipation([tokenAAddress]);
      expect(await lenderRegistry.getTotalPotentialLenders()).to.equal(1n);

      const after = await lenderRegistry.getPotentialLendersAvailabilityByToken(tokenAAddress);
      expect(after).to.have.lengthOf(1);
      expect(after[0].lender).to.equal(lender2.address);
      expect(after[0].availableAmount).to.equal(HUNDRED_TOKENS - 1n);
    });
  });

  describe("removal", function () {
    it("lender removes own participation", async function () {
      const { lenderRegistry, flashLoan, admin, lender1, tokenA } =
        await networkHelpers.loadFixture(deployFlashLoanFixture);
      const flashLoanAddress = await flashLoan.getAddress();
      const tokenAAddress = await tokenA.getAddress();

      await lenderRegistry.connect(admin).setPermissionlessParticipationEnabled(true);
      await lenderRegistry.connect(lender1).indicateParticipation([tokenAAddress]);
      await approve(tokenA, lender1, flashLoanAddress, HUNDRED_TOKENS);

      const before = await lenderRegistry.getPotentialLendersAvailabilityByToken(tokenAAddress);
      expect(before).to.have.lengthOf(1);

      await lenderRegistry.connect(lender1).removeParticipation([tokenAAddress]);

      const after = await lenderRegistry.getPotentialLendersAvailabilityByToken(tokenAAddress);
      expect(after).to.have.lengthOf(0);
    });

    it("silently skips non-existent participation", async function () {
      const { lenderRegistry, admin, lender1, tokenA } =
        await networkHelpers.loadFixture(deployFlashLoanFixture);
      const tokenAAddress = await tokenA.getAddress();

      await lenderRegistry.connect(admin).setPermissionlessParticipationEnabled(true);
      // Should not revert even though lender1 never indicated participation
      await lenderRegistry.connect(lender1).removeParticipation([tokenAAddress]);
    });

    it("bookkeeper removes participation for lenders", async function () {
      const { lenderRegistry, flashLoan, admin, bookKeeper, lender1, lender2, tokenA } =
        await networkHelpers.loadFixture(deployFlashLoanFixture);
      const flashLoanAddress = await flashLoan.getAddress();
      const tokenAAddress = await tokenA.getAddress();

      await lenderRegistry.connect(admin).setPermissionlessParticipationEnabled(true);
      await lenderRegistry.connect(lender1).indicateParticipation([tokenAAddress]);
      await lenderRegistry.connect(lender2).indicateParticipation([tokenAAddress]);
      await approve(tokenA, lender1, flashLoanAddress, HUNDRED_TOKENS);
      await approve(tokenA, lender2, flashLoanAddress, HUNDRED_TOKENS);

      await lenderRegistry.connect(bookKeeper).removeParticipationFor([
        {
          token: tokenAAddress,
          lenders: [lender1.address],
        },
      ]);

      const availability = await lenderRegistry.getPotentialLendersAvailabilityByToken(tokenAAddress);
      expect(availability).to.have.lengthOf(1);
      expect(availability[0].lender).to.equal(lender2.address);
    });

    it("restricts bookkeeper-managed removal", async function () {
      const { lenderRegistry, aclManager, lender1, lender2, tokenA } =
        await networkHelpers.loadFixture(deployFlashLoanFixture);
      const tokenAAddress = await tokenA.getAddress();

      await expect(lenderRegistry.connect(lender1).removeParticipationFor([
        {
          token: tokenAAddress,
          lenders: [lender2.address],
        },
      ])).to.be.revertedWithCustomError(aclManager, "NotBookKeeperRole")
        .withArgs(lender1.address);
    });

    it("removes token from potentialTokens when last lender removed", async function () {
      const { lenderRegistry, admin, lender1, lender2, tokenA } =
        await networkHelpers.loadFixture(deployFlashLoanFixture);
      const tokenAAddress = await tokenA.getAddress();

      await lenderRegistry.connect(admin).setPermissionlessParticipationEnabled(true);
      await lenderRegistry.connect(lender1).indicateParticipation([tokenAAddress]);
      await lenderRegistry.connect(lender2).indicateParticipation([tokenAAddress]);
      expect(await lenderRegistry.potentialTokens(tokenAAddress)).to.equal(true);

      await lenderRegistry.connect(lender1).removeParticipation([tokenAAddress]);
      expect(await lenderRegistry.potentialTokens(tokenAAddress)).to.equal(true);

      await lenderRegistry.connect(lender2).removeParticipation([tokenAAddress]);
      expect(await lenderRegistry.potentialTokens(tokenAAddress)).to.equal(false);

      const allAvailability = await lenderRegistry.getAllPotentialLendersAvailability();
      expect(allAvailability).to.have.lengthOf(0);
    });

    it("allows re-indicating participation after removal", async function () {
      const { lenderRegistry, flashLoan, admin, lender1, tokenA } =
        await networkHelpers.loadFixture(deployFlashLoanFixture);
      const flashLoanAddress = await flashLoan.getAddress();
      const tokenAAddress = await tokenA.getAddress();

      await lenderRegistry.connect(admin).setPermissionlessParticipationEnabled(true);
      await lenderRegistry.connect(lender1).indicateParticipation([tokenAAddress]);
      await approve(tokenA, lender1, flashLoanAddress, ethers.MaxUint256);
      await lenderRegistry.connect(lender1).removeParticipation([tokenAAddress]);

      expect(await lenderRegistry.potentialTokens(tokenAAddress)).to.equal(false);

      await lenderRegistry.connect(lender1).indicateParticipation([tokenAAddress]);
      expect(await lenderRegistry.potentialTokens(tokenAAddress)).to.equal(true);

      const availability = await lenderRegistry.getPotentialLendersAvailabilityByToken(tokenAAddress);
      expect(availability).to.have.lengthOf(1);
      expect(availability[0].lender).to.equal(lender1.address);
      expect(availability[0].availableAmount).to.equal(HUNDRED_TOKENS);
    });

    it("partial removal preserves remaining lenders with correct order", async function () {
      const { lenderRegistry, flashLoan, admin, lender1, lender2, lender3, tokenA } =
        await networkHelpers.loadFixture(deployFlashLoanFixture);
      const flashLoanAddress = await flashLoan.getAddress();
      const tokenAAddress = await tokenA.getAddress();

      await lenderRegistry.connect(admin).setPermissionlessParticipationEnabled(true);
      await lenderRegistry.connect(lender1).indicateParticipation([tokenAAddress]);
      await lenderRegistry.connect(lender2).indicateParticipation([tokenAAddress]);
      await lenderRegistry.connect(lender3).indicateParticipation([tokenAAddress]);
      await approve(tokenA, lender1, flashLoanAddress, HUNDRED_TOKENS);
      await approve(tokenA, lender2, flashLoanAddress, ethers.parseEther("50"));
      await approve(tokenA, lender3, flashLoanAddress, ethers.parseEther("75"));

      // Remove lender1 (first element)
      await lenderRegistry.connect(lender1).removeParticipation([tokenAAddress]);

      const availability = await lenderRegistry.getPotentialLendersAvailabilityByToken(tokenAAddress);
      expect(availability).to.have.lengthOf(2);
      expect(availability.map(({ lender }) => lender)).to.deep.equal([lender2.address, lender3.address]);
      expect(availability.map(({ availableAmount }) => availableAmount)).to.deep.equal([
        ethers.parseEther("50"),
        ethers.parseEther("75"),
      ]);
    });

    it("rejects zero address in removeParticipationFor", async function () {
      const { lenderRegistry, bookKeeper, tokenA } =
        await networkHelpers.loadFixture(deployFlashLoanFixture);
      const tokenAAddress = await tokenA.getAddress();

      await expect(lenderRegistry.connect(bookKeeper).removeParticipationFor([
        {
          token: tokenAAddress,
          lenders: [ZERO_ADDRESS],
        },
      ])).to.be.revertedWithCustomError(lenderRegistry, "InvalidZeroAddress");
    });
  });

  describe("view function resilience", function () {
    it("filters zero availability for reverting tokens instead of reverting", async function () {
      const { lenderRegistry, flashLoan, admin, lender1, lender2, tokenA } =
        await networkHelpers.loadFixture(deployFlashLoanFixture);
      const flashLoanAddress = await flashLoan.getAddress();
      const tokenAAddress = await tokenA.getAddress();

      // Deploy a reverting ERC20 and register participation for it
      const revertingToken = await ethers.deployContract("MockRevertingERC20");
      const revertingTokenAddress = await revertingToken.getAddress();

      // Register lender1 for both a normal token and the reverting token
      await lenderRegistry.connect(admin).setPermissionlessParticipationEnabled(true);
      await lenderRegistry.connect(lender1).indicateParticipation([tokenAAddress]);
      await lenderRegistry.connect(lender1).indicateParticipation([revertingTokenAddress]);
      await lenderRegistry.connect(lender2).indicateParticipation([revertingTokenAddress]);
      await approve(tokenA, lender1, flashLoanAddress, HUNDRED_TOKENS);

      // getAllPotentialLendersAvailability should not revert
      const allAvailability = await lenderRegistry.getAllPotentialLendersAvailability();
      expect(allAvailability).to.have.lengthOf(2);

      // Normal token should have correct availability
      expect(allAvailability[0].token).to.equal(tokenAAddress);
      expect([...allAvailability[0].availableAmounts]).to.deep.equal([HUNDRED_TOKENS]);

      // Reverting token has zero availability, so registered lenders are filtered out
      expect(allAvailability[1].token).to.equal(revertingTokenAddress);
      expect([...allAvailability[1].lenders]).to.deep.equal([]);
      expect([...allAvailability[1].availableAmounts]).to.deep.equal([]);

      // getPotentialLendersAvailabilityByToken should also not revert
      const tokenAvailability = await lenderRegistry.getPotentialLendersAvailabilityByToken(revertingTokenAddress);
      expect(tokenAvailability).to.have.lengthOf(0);
    });
  });
});
