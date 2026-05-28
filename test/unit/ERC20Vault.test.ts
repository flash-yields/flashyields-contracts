import { expect } from "chai";
import {
  HUNDRED_TOKENS,
  TOKEN_B_HUNDRED_TOKENS,
  ZERO_ADDRESS,
  approve,
  deployFlashLoanFixture,
  ethers,
  mint,
  networkHelpers,
} from "../fixtures/deploy.js";

describe("ERC20Vault", function () {
  it("validates constructor inputs", async function () {
    const { aclManager, flashLoan, tokenA, vault } = await networkHelpers.loadFixture(deployFlashLoanFixture);

    await expect(ethers.deployContract("ERC20Vault", [ZERO_ADDRESS, await aclManager.getAddress(), [], [], []]))
      .to.be.revertedWithCustomError(vault, "InvalidZeroAddress");
    await expect(ethers.deployContract("ERC20Vault", [await flashLoan.getAddress(), ZERO_ADDRESS, [], [], []]))
      .to.be.revertedWithCustomError(vault, "InvalidZeroAddress");
    await expect(ethers.deployContract("ERC20Vault", [
      await flashLoan.getAddress(),
      await aclManager.getAddress(),
      [await tokenA.getAddress()],
      [true],
      [],
    ])).to.be.revertedWithCustomError(vault, "ArrayLengthMismatch");
  });

  it("initializes token whitelist in the constructor", async function () {
    const { aclManager, flashLoan, tokenA } = await networkHelpers.loadFixture(deployFlashLoanFixture);
    const minimumDepositAmount = ethers.parseEther("10");

    const initializedVault = await ethers.deployContract("ERC20Vault", [
      await flashLoan.getAddress(),
      await aclManager.getAddress(),
      [await tokenA.getAddress()],
      [true],
      [minimumDepositAmount],
    ]);

    expect(await initializedVault.whitelistedTokens(await tokenA.getAddress())).to.equal(true);
    expect(await initializedVault.minimumDepositAmounts(await tokenA.getAddress())).to.equal(minimumDepositAmount);
    expect(await tokenA.allowance(await initializedVault.getAddress(), await flashLoan.getAddress()))
      .to.equal(ethers.MaxUint256);
  });

  it("deposits multiple tokens into the vault", async function () {
    const { vault, tokenA, tokenB, admin, other } = await networkHelpers.loadFixture(deployFlashLoanFixture);
    const amountA = ethers.parseEther("10");
    const amountB = ethers.parseUnits("5", 6);

    await mint(tokenA, other.address, HUNDRED_TOKENS);
    await mint(tokenB, other.address, TOKEN_B_HUNDRED_TOKENS);
    await approve(tokenA, other, await vault.getAddress(), HUNDRED_TOKENS);
    await approve(tokenB, other, await vault.getAddress(), TOKEN_B_HUNDRED_TOKENS);

    await vault.connect(admin).setTokenWhitelist(
      [await tokenA.getAddress(), await tokenB.getAddress()],
      [true, true],
      [0n, 0n],
    );

    await expect(vault.connect(other).deposit([await tokenA.getAddress(), await tokenB.getAddress()], [amountA, amountB]))
      .to.emit(vault, "Deposited")
      .withArgs(other.address, await tokenA.getAddress(), amountA);

    expect(await vault.balances(await tokenA.getAddress(), other.address)).to.equal(amountA);
    expect(await vault.balances(await tokenB.getAddress(), other.address)).to.equal(amountB);
  });

  it("records the actual received amount for fee-on-transfer token deposits", async function () {
    const { vault, admin, other } = await networkHelpers.loadFixture(deployFlashLoanFixture);
    const feeOnTransferToken = await ethers.deployContract("MockFeeOnTransferERC20", [
      "Fee Token",
      "FEE",
      18,
      1_000n,
    ]);
    const amount = ethers.parseEther("10");
    const receivedAmount = ethers.parseEther("9");
    const tokenAddress = await feeOnTransferToken.getAddress();

    await feeOnTransferToken.mint(other.address, amount);
    await feeOnTransferToken.connect(other).approve(await vault.getAddress(), amount);
    await vault.connect(admin).setTokenWhitelist([tokenAddress], [true], [0n]);

    await expect(vault.connect(other).deposit([tokenAddress], [amount]))
      .to.emit(vault, "Deposited")
      .withArgs(other.address, tokenAddress, receivedAmount);

    expect(await vault.balances(tokenAddress, other.address)).to.equal(receivedAmount);
    expect(await feeOnTransferToken.balanceOf(await vault.getAddress())).to.equal(receivedAmount);
  });

  it("rejects deposits below the token minimum deposit amount", async function () {
    const { vault, tokenA, admin, other } = await networkHelpers.loadFixture(deployFlashLoanFixture);
    const minimumDepositAmount = ethers.parseEther("10");
    const belowMinimumDepositAmount = minimumDepositAmount - 1n;

    await mint(tokenA, other.address, HUNDRED_TOKENS);
    await approve(tokenA, other, await vault.getAddress(), HUNDRED_TOKENS);
    await vault.connect(admin).setTokenWhitelist([await tokenA.getAddress()], [true], [minimumDepositAmount]);

    await expect(vault.connect(other).deposit([await tokenA.getAddress()], [belowMinimumDepositAmount]))
      .to.be.revertedWithCustomError(vault, "DepositAmountBelowMinimum")
      .withArgs(await tokenA.getAddress(), belowMinimumDepositAmount, minimumDepositAmount);

    await expect(vault.connect(other).deposit([await tokenA.getAddress()], [minimumDepositAmount]))
      .to.emit(vault, "Deposited")
      .withArgs(other.address, await tokenA.getAddress(), minimumDepositAmount);
  });

  it("rejects deposits when the actual received amount is below the token minimum deposit amount", async function () {
    const { vault, admin, other } = await networkHelpers.loadFixture(deployFlashLoanFixture);
    const feeOnTransferToken = await ethers.deployContract("MockFeeOnTransferERC20", [
      "Fee Token",
      "FEE",
      18,
      1_000n,
    ]);
    const amount = ethers.parseEther("10");
    const receivedAmount = ethers.parseEther("9");
    const tokenAddress = await feeOnTransferToken.getAddress();

    await feeOnTransferToken.mint(other.address, amount);
    await feeOnTransferToken.connect(other).approve(await vault.getAddress(), amount);
    await vault.connect(admin).setTokenWhitelist([tokenAddress], [true], [amount]);

    await expect(vault.connect(other).deposit([tokenAddress], [amount]))
      .to.be.revertedWithCustomError(vault, "DepositAmountBelowMinimum")
      .withArgs(tokenAddress, receivedAmount, amount);

    expect(await vault.balances(tokenAddress, other.address)).to.equal(0n);
    expect(await feeOnTransferToken.balanceOf(await vault.getAddress())).to.equal(0n);
  });

  it("withdraws deposited tokens and validates input amounts", async function () {
    const { vault, tokenA, admin, other } = await networkHelpers.loadFixture(deployFlashLoanFixture);
    const amount = ethers.parseEther("10");

    await mint(tokenA, other.address, HUNDRED_TOKENS);
    await approve(tokenA, other, await vault.getAddress(), HUNDRED_TOKENS);
    await vault.connect(admin).setTokenWhitelist([await tokenA.getAddress()], [true], [0n]);
    await vault.connect(other).deposit([await tokenA.getAddress()], [amount]);
    expect(await vault.balances(await tokenA.getAddress(), other.address)).to.equal(amount);

    await expect(vault.connect(other).withdraw([await tokenA.getAddress()], [amount]))
      .to.emit(vault, "Withdrawn")
      .withArgs(other.address, await tokenA.getAddress(), amount);
    expect(await vault.balances(await tokenA.getAddress(), other.address)).to.equal(0n);

    await expect(vault.connect(other).deposit([await tokenA.getAddress()], []))
      .to.be.revertedWithCustomError(vault, "ArrayLengthMismatch");
    await expect(vault.connect(other).deposit([await tokenA.getAddress()], [0n]))
      .to.be.revertedWithCustomError(vault, "ZeroAmount");
    await expect(vault.connect(other).withdraw([await tokenA.getAddress()], [0n]))
      .to.be.revertedWithCustomError(vault, "ZeroAmount");
    await expect(vault.connect(other).withdraw([await tokenA.getAddress()], [1n]))
      .to.be.revertedWithCustomError(vault, "InsufficientBalance");
  });

  it("approves and revokes flash-loan allowances through admin role", async function () {
    const { vault, flashLoan, tokenA, admin, other, aclManager } =
      await networkHelpers.loadFixture(deployFlashLoanFixture);

    await expect(vault.connect(other).approveTokensForFlashloan([await tokenA.getAddress()]))
      .to.be.revertedWithCustomError(aclManager, "NotAdminRole")
      .withArgs(other.address);

    await vault.connect(admin).setTokenWhitelist([await tokenA.getAddress()], [true], [0n]);
    expect(await tokenA.allowance(await vault.getAddress(), await flashLoan.getAddress())).to.equal(ethers.MaxUint256);

    // De-whitelist to revoke allowance, then re-whitelist to test approveTokensForFlashloan from zero
    await vault.connect(admin).setTokenWhitelist([await tokenA.getAddress()], [false], [0n]);
    expect(await tokenA.allowance(await vault.getAddress(), await flashLoan.getAddress())).to.equal(0n);

    await vault.connect(admin).setTokenWhitelist([await tokenA.getAddress()], [true], [0n]);
    await expect(vault.connect(admin).approveTokensForFlashloan([await tokenA.getAddress()]))
      .to.emit(vault, "Approved")
      .withArgs(await tokenA.getAddress(), ethers.MaxUint256);
    expect(await tokenA.allowance(await vault.getAddress(), await flashLoan.getAddress())).to.equal(ethers.MaxUint256);

    await expect(vault.connect(admin).revokeTokensFromFlashloan([await tokenA.getAddress()]))
      .to.emit(vault, "Revoked")
      .withArgs(await tokenA.getAddress());
    expect(await tokenA.allowance(await vault.getAddress(), await flashLoan.getAddress())).to.equal(0n);
  });

  it("allows the pauser role to pause and the admin role to unpause", async function () {
    const { vault, pauser, admin, other, aclManager } = await networkHelpers.loadFixture(deployFlashLoanFixture);

    expect(await vault.paused()).to.equal(false);
    await expect(vault.connect(other).pause())
      .to.be.revertedWithCustomError(aclManager, "NotPauserRole")
      .withArgs(other.address);

    await expect(vault.connect(pauser).pause()).to.emit(vault, "Paused").withArgs(pauser.address);
    expect(await vault.paused()).to.equal(true);
    await expect(vault.connect(pauser).pause()).to.be.revertedWithCustomError(vault, "EnforcedPause");

    await expect(vault.connect(other).unpause())
      .to.be.revertedWithCustomError(aclManager, "NotAdminRole")
      .withArgs(other.address);

    await expect(vault.connect(admin).unpause()).to.emit(vault, "Unpaused").withArgs(admin.address);
    expect(await vault.paused()).to.equal(false);
    await expect(vault.connect(admin).unpause()).to.be.revertedWithCustomError(vault, "ExpectedPause");
  });

  it("blocks vault actions and still allows certain actions while paused", async function () {
    const { vault, tokenA, admin, pauser, other } = await networkHelpers.loadFixture(deployFlashLoanFixture);
    const amount = ethers.parseEther("10");

    await mint(tokenA, other.address, HUNDRED_TOKENS);
    await approve(tokenA, other, await vault.getAddress(), HUNDRED_TOKENS);
    await vault.connect(admin).setTokenWhitelist([await tokenA.getAddress()], [true], [0n]);
    await vault.connect(other).deposit([await tokenA.getAddress()], [amount]);

    await vault.connect(pauser).pause();

    await expect(vault.connect(other).deposit([await tokenA.getAddress()], [amount]))
      .to.be.revertedWithCustomError(vault, "EnforcedPause");
    await expect(vault.connect(other).withdraw([await tokenA.getAddress()], [amount]))
      .to.emit(vault, "Withdrawn")
      .withArgs(other.address, await tokenA.getAddress(), amount);
    expect(await vault.balances(await tokenA.getAddress(), other.address)).to.equal(0n);
    await expect(vault.connect(admin).approveTokensForFlashloan([await tokenA.getAddress()]))
      .to.be.revertedWithCustomError(vault, "EnforcedPause");
    // paused contract can still go through revoke and token whitelist
    await expect(vault.connect(admin).revokeTokensFromFlashloan([await tokenA.getAddress()]))
      .to.emit(vault, "Revoked")
      .withArgs(await tokenA.getAddress());
    await vault.connect(admin).setTokenWhitelist([await tokenA.getAddress()], [true], [0n]);

    await expect(vault.connect(admin).unpause()).to.emit(vault, "Unpaused").withArgs(admin.address);
  });

  it("sets token whitelist, approves on whitelist, revokes on de-whitelist", async function () {
    const { vault, flashLoan, tokenA, tokenB, admin, other, aclManager } =
      await networkHelpers.loadFixture(deployFlashLoanFixture);

    // Non-admin cannot set whitelist
    await expect(vault.connect(other).setTokenWhitelist([await tokenA.getAddress()], [true], [0n]))
      .to.be.revertedWithCustomError(aclManager, "NotAdminRole")
      .withArgs(other.address);

    // Array length mismatch
    await expect(vault.connect(admin).setTokenWhitelist([await tokenA.getAddress()], [], []))
      .to.be.revertedWithCustomError(vault, "ArrayLengthMismatch");
    await expect(vault.connect(admin).setTokenWhitelist([await tokenA.getAddress()], [true], []))
      .to.be.revertedWithCustomError(vault, "ArrayLengthMismatch");

    expect(await vault.whitelistedTokens(await tokenA.getAddress())).to.equal(false);
    expect(await vault.whitelistedTokens(await tokenB.getAddress())).to.equal(false);

    // Whitelist tokenA and tokenB — should approve flash loan
    const minimumDepositAmountA = ethers.parseEther("1");
    const minimumDepositAmountB = ethers.parseUnits("1", 6);
    const whitelistTx = vault.connect(admin).setTokenWhitelist(
      [await tokenA.getAddress(), await tokenB.getAddress()],
      [true, true],
      [minimumDepositAmountA, minimumDepositAmountB],
    );
    await expect(whitelistTx)
      .to.emit(vault, "TokenWhitelistUpdated")
      .withArgs(await tokenA.getAddress(), true);
    await expect(whitelistTx)
      .to.emit(vault, "Approved")
      .withArgs(await tokenA.getAddress(), ethers.MaxUint256);
    await expect(whitelistTx)
      .to.emit(vault, "Approved")
      .withArgs(await tokenB.getAddress(), ethers.MaxUint256);

    expect(await vault.whitelistedTokens(await tokenA.getAddress())).to.equal(true);
    expect(await vault.whitelistedTokens(await tokenB.getAddress())).to.equal(true);
    expect(await vault.minimumDepositAmounts(await tokenA.getAddress())).to.equal(minimumDepositAmountA);
    expect(await vault.minimumDepositAmounts(await tokenB.getAddress())).to.equal(minimumDepositAmountB);
    expect(await tokenA.allowance(await vault.getAddress(), await flashLoan.getAddress())).to.equal(ethers.MaxUint256);
    expect(await tokenB.allowance(await vault.getAddress(), await flashLoan.getAddress())).to.equal(ethers.MaxUint256);

    // Remove from whitelist — should revoke approval
    const dewhitelistTx = vault.connect(admin).setTokenWhitelist([await tokenA.getAddress()], [false], [0n]);
    await expect(dewhitelistTx)
      .to.emit(vault, "TokenWhitelistUpdated")
      .withArgs(await tokenA.getAddress(), false);
    await expect(dewhitelistTx)
      .to.emit(vault, "Revoked")
      .withArgs(await tokenA.getAddress());

    expect(await vault.whitelistedTokens(await tokenA.getAddress())).to.equal(false);
    expect(await vault.whitelistedTokens(await tokenB.getAddress())).to.equal(true);
    expect(await vault.minimumDepositAmounts(await tokenA.getAddress())).to.equal(0n);
    expect(await vault.minimumDepositAmounts(await tokenB.getAddress())).to.equal(minimumDepositAmountB);
    expect(await tokenA.allowance(await vault.getAddress(), await flashLoan.getAddress())).to.equal(0n);
    expect(await tokenB.allowance(await vault.getAddress(), await flashLoan.getAddress())).to.equal(ethers.MaxUint256);
  });

  it("rejects deposits of non-whitelisted tokens", async function () {
    const { vault, tokenA, admin, other } =
      await networkHelpers.loadFixture(deployFlashLoanFixture);
    const amount = ethers.parseEther("10");

    await mint(tokenA, other.address, HUNDRED_TOKENS);
    await approve(tokenA, other, await vault.getAddress(), HUNDRED_TOKENS);

    // Deposit should fail when token is not whitelisted
    await expect(vault.connect(other).deposit([await tokenA.getAddress()], [amount]))
      .to.be.revertedWithCustomError(vault, "TokenNotWhitelisted")
      .withArgs(await tokenA.getAddress());

    // Whitelist the token, deposit should succeed
    await vault.connect(admin).setTokenWhitelist([await tokenA.getAddress()], [true], [0n]);
    await expect(vault.connect(other).deposit([await tokenA.getAddress()], [amount]))
      .to.emit(vault, "Deposited");
  });

  it("rejects flash-loan approval of non-whitelisted tokens", async function () {
    const { vault, tokenA, admin } =
      await networkHelpers.loadFixture(deployFlashLoanFixture);

    // Approve should fail when token is not whitelisted
    await expect(vault.connect(admin).approveTokensForFlashloan([await tokenA.getAddress()]))
      .to.be.revertedWithCustomError(vault, "TokenNotWhitelisted")
      .withArgs(await tokenA.getAddress());

    // Whitelist the token, approve should succeed
    await vault.connect(admin).setTokenWhitelist([await tokenA.getAddress()], [true], [0n]);
    await expect(vault.connect(admin).approveTokensForFlashloan([await tokenA.getAddress()]))
      .to.emit(vault, "Approved");
  });

  it("allows withdrawal of de-whitelisted tokens", async function () {
    const { vault, tokenA, admin, other } =
      await networkHelpers.loadFixture(deployFlashLoanFixture);
    const amount = ethers.parseEther("10");

    await mint(tokenA, other.address, HUNDRED_TOKENS);
    await approve(tokenA, other, await vault.getAddress(), HUNDRED_TOKENS);

    // Whitelist, deposit, then de-whitelist
    await vault.connect(admin).setTokenWhitelist([await tokenA.getAddress()], [true], [0n]);
    await vault.connect(other).deposit([await tokenA.getAddress()], [amount]);
    await vault.connect(admin).setTokenWhitelist([await tokenA.getAddress()], [false], [0n]);

    // Withdrawal should still succeed
    await expect(vault.connect(other).withdraw([await tokenA.getAddress()], [amount]))
      .to.emit(vault, "Withdrawn")
      .withArgs(other.address, await tokenA.getAddress(), amount);
  });
});
