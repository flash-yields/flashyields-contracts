import { expect } from "chai";
import {
  DEFAULT_FEE_BPS,
  DEFAULT_MAX_STALENESS,
  HUNDRED_TOKENS,
  ZERO_ADDRESS,
  deployAggregator,
  deployFlashLoanFixture,
  deployToken,
  ethers,
  mint,
  networkHelpers,
} from "../fixtures/deploy.js";

describe("FeeVerifier", function () {
  describe("constructor", function () {
    it("validates constructor inputs", async function () {
      const { aclManager, feeRecipient, feeVerifier } = await networkHelpers.loadFixture(deployFlashLoanFixture);

      await expect(
        ethers.deployContract("FeeVerifier", [ZERO_ADDRESS, feeRecipient.address, DEFAULT_FEE_BPS, DEFAULT_MAX_STALENESS])
      ).to.be.revertedWithCustomError(feeVerifier, "InvalidZeroAddress");
      await expect(
        ethers.deployContract("FeeVerifier", [await aclManager.getAddress(), ZERO_ADDRESS, DEFAULT_FEE_BPS, DEFAULT_MAX_STALENESS])
      ).to.be.revertedWithCustomError(feeVerifier, "InvalidZeroAddress");
      await expect(
        ethers.deployContract("FeeVerifier", [await aclManager.getAddress(), feeRecipient.address, 10_001n, DEFAULT_MAX_STALENESS])
      ).to.be.revertedWithCustomError(feeVerifier, "FeeBpsTooHigh");
      await expect(
        ethers.deployContract("FeeVerifier", [await aclManager.getAddress(), feeRecipient.address, DEFAULT_FEE_BPS, 0n])
      ).to.be.revertedWithCustomError(feeVerifier, "InvalidMaxStaleness");
    });
  });

  describe("admin setters", function () {
    it("updates admin-controlled fee recipient and default fee", async function () {
      const { feeVerifier, admin, other } = await networkHelpers.loadFixture(deployFlashLoanFixture);

      await expect(feeVerifier.connect(admin).setFeeRecipient(other.address))
        .to.emit(feeVerifier, "FeeRecipientUpdated")
        .withArgs(other.address);
      expect(await feeVerifier.feeRecipient()).to.equal(other.address);

      await expect(feeVerifier.connect(admin).setFlashLoanFeeBps(25n))
        .to.emit(feeVerifier, "FlashLoanFeeBpsUpdated")
        .withArgs(25n);
      expect(await feeVerifier.flashLoanFeeBps()).to.equal(25n);

      await expect(feeVerifier.connect(admin).setFlashLoanFeeBps(10_001n))
        .to.be.revertedWithCustomError(feeVerifier, "FeeBpsTooHigh");
      await expect(feeVerifier.connect(admin).setFeeRecipient(ZERO_ADDRESS))
        .to.be.revertedWithCustomError(feeVerifier, "InvalidZeroAddress");
    });

    it("enforces configured ACL roles", async function () {
      const { feeVerifier, aclManager, other, tokenA, feeToken } = await networkHelpers.loadFixture(deployFlashLoanFixture);

      await expect(feeVerifier.connect(other).setFeeRecipient(other.address))
        .to.be.revertedWithCustomError(aclManager, "NotAdminRole")
        .withArgs(other.address);
      await expect(feeVerifier.connect(other).setMaxStaleness(2n))
        .to.be.revertedWithCustomError(aclManager, "NotAdminRole")
        .withArgs(other.address);
      await expect(feeVerifier.connect(other).setAssetFeeToken([await tokenA.getAddress()], [await feeToken.getAddress()]))
        .to.be.revertedWithCustomError(aclManager, "NotAdminRole")
        .withArgs(other.address);
      await expect(feeVerifier.connect(other).setFlashLoanFeeBps(25n))
        .to.be.revertedWithCustomError(aclManager, "NotAdminRole")
        .withArgs(other.address);
      await expect(feeVerifier.connect(other).setAssetFlashLoanFeeBps([await tokenA.getAddress()], [25n]))
        .to.be.revertedWithCustomError(aclManager, "NotAdminRole")
        .withArgs(other.address);
      await expect(feeVerifier.connect(other).clearAssetFlashLoanFeeBps([await tokenA.getAddress()]))
        .to.be.revertedWithCustomError(aclManager, "NotAdminRole")
        .withArgs(other.address);
      await expect(feeVerifier.connect(other).setTokenUsdPrice(await feeToken.getAddress(), 5_0000000000n))
        .to.be.revertedWithCustomError(aclManager, "NotBookKeeperRole")
        .withArgs(other.address);
      await expect(feeVerifier.connect(other).clearTokenUsdPrice(await feeToken.getAddress()))
        .to.be.revertedWithCustomError(aclManager, "NotBookKeeperRole")
        .withArgs(other.address);
    });

    it("sets per-asset fee overrides in batch", async function () {
      const { feeVerifier, admin, tokenA, tokenB } =
        await networkHelpers.loadFixture(deployFlashLoanFixture);
      const tokenAAddress = await tokenA.getAddress();
      const tokenBAddress = await tokenB.getAddress();

      expect(await feeVerifier.getEffectiveFlashLoanFeeBps(tokenAAddress)).to.equal(DEFAULT_FEE_BPS);
      expect(await feeVerifier.getEffectiveFlashLoanFeeBps(tokenBAddress)).to.equal(DEFAULT_FEE_BPS);
      await expect(
        feeVerifier.connect(admin).setAssetFlashLoanFeeBps(
          [tokenAAddress, tokenBAddress],
          [25n, 50n]
        )
      )
        .to.emit(feeVerifier, "AssetFlashLoanFeeBpsUpdated")
        .withArgs(tokenAAddress, 25n);
      expect(await feeVerifier.getEffectiveFlashLoanFeeBps(tokenAAddress)).to.equal(25n);
      expect(await feeVerifier.getEffectiveFlashLoanFeeBps(tokenBAddress)).to.equal(50n);
      expect(await feeVerifier.assetFlashLoanFeeBpsIsSet(tokenAAddress)).to.equal(true);
      expect(await feeVerifier.assetFlashLoanFeeBpsIsSet(tokenBAddress)).to.equal(true);

      await expect(feeVerifier.connect(admin).setAssetFlashLoanFeeBps([tokenAAddress], [1n, 2n]))
        .to.be.revertedWithCustomError(feeVerifier, "ArrayLengthMismatch");
      await expect(feeVerifier.connect(admin).setAssetFlashLoanFeeBps([ZERO_ADDRESS], [1n]))
        .to.be.revertedWithCustomError(feeVerifier, "InvalidZeroAddress");
      await expect(feeVerifier.connect(admin).setAssetFlashLoanFeeBps([tokenAAddress], [10_001n]))
        .to.be.revertedWithCustomError(feeVerifier, "FeeBpsTooHigh");
    });

    it("supports an explicit 0-BPS per-asset override", async function () {
      const { feeVerifier, admin, tokenA } = await networkHelpers.loadFixture(deployFlashLoanFixture);
      const tokenAAddress = await tokenA.getAddress();

      await expect(feeVerifier.connect(admin).setAssetFlashLoanFeeBps([tokenAAddress], [0n]))
        .to.emit(feeVerifier, "AssetFlashLoanFeeBpsUpdated")
        .withArgs(tokenAAddress, 0n);

      expect(await feeVerifier.assetFlashLoanFeeBpsIsSet(tokenAAddress)).to.equal(true);
      expect(await feeVerifier.getEffectiveFlashLoanFeeBps(tokenAAddress)).to.equal(0n);
      expect(await feeVerifier.getFeeAmount(tokenAAddress, HUNDRED_TOKENS)).to.equal(0n);
    });

    it("snapshots and verifies zero fees for a 0-BPS overridden asset", async function () {
      const { feeVerifier, admin, tokenA, feeRecipient } =
        await networkHelpers.loadFixture(deployFlashLoanFixture);
      const tokenAAddress = await tokenA.getAddress();

      await feeVerifier.connect(admin).setAssetFlashLoanFeeBps([tokenAAddress], [0n]);

      const [feeAssets, balancesBefore, aggregatedFees, feeAssetCount] =
        await feeVerifier.snapshotFees([tokenAAddress], [HUNDRED_TOKENS]);

      expect(feeAssetCount).to.equal(0n);
      expect(feeAssets).to.deep.equal([]);
      expect(balancesBefore).to.deep.equal([]);
      expect(aggregatedFees).to.deep.equal([]);

      const feeAssetArray = Array.from(feeAssets);
      const balancesBeforeArray = Array.from(balancesBefore);
      const aggregatedFeeArray = Array.from(aggregatedFees);

      // No balance change required for a 0-fee asset.
      expect(
        await feeVerifier.verifyFees(feeAssetArray, balancesBeforeArray, aggregatedFeeArray, feeAssetCount)
      ).to.equal(true);
    });

    it("clears per-asset fee overrides and restores the default fee", async function () {
      const { feeVerifier, admin, tokenA } = await networkHelpers.loadFixture(deployFlashLoanFixture);
      const tokenAAddress = await tokenA.getAddress();

      await feeVerifier.connect(admin).setAssetFlashLoanFeeBps([tokenAAddress], [0n]);
      expect(await feeVerifier.getEffectiveFlashLoanFeeBps(tokenAAddress)).to.equal(0n);

      await expect(feeVerifier.connect(admin).clearAssetFlashLoanFeeBps([tokenAAddress]))
        .to.emit(feeVerifier, "AssetFlashLoanFeeBpsCleared")
        .withArgs(tokenAAddress);

      expect(await feeVerifier.assetFlashLoanFeeBpsIsSet(tokenAAddress)).to.equal(false);
      expect(await feeVerifier.assetFlashLoanFeeBps(tokenAAddress)).to.equal(0n);
      expect(await feeVerifier.getEffectiveFlashLoanFeeBps(tokenAAddress)).to.equal(DEFAULT_FEE_BPS);
    });

    it("enforces validations and roles on clearAssetFlashLoanFeeBps", async function () {
      const { feeVerifier, aclManager, admin, other, tokenA } =
        await networkHelpers.loadFixture(deployFlashLoanFixture);
      const tokenAAddress = await tokenA.getAddress();

      await expect(feeVerifier.connect(other).clearAssetFlashLoanFeeBps([tokenAAddress]))
        .to.be.revertedWithCustomError(aclManager, "NotAdminRole")
        .withArgs(other.address);
      await expect(feeVerifier.connect(admin).clearAssetFlashLoanFeeBps([ZERO_ADDRESS]))
        .to.be.revertedWithCustomError(feeVerifier, "InvalidZeroAddress");
    });

    it("sets max staleness, fee-token overrides, fallback prices, and aggregators", async function () {
      const { feeVerifier, admin, bookKeeper, tokenA, tokenB, feeToken } =
        await networkHelpers.loadFixture(deployFlashLoanFixture);
      const tokenAAddress = await tokenA.getAddress();
      const tokenBAddress = await tokenB.getAddress();
      const feeTokenAddress = await feeToken.getAddress();
      const aggregator = await deployAggregator(200_000_000n);
      const aggregatorAddress = await aggregator.getAddress();

      await expect(feeVerifier.connect(admin).setMaxStaleness(3600n))
        .to.emit(feeVerifier, "MaxStalenessUpdated")
        .withArgs(3600n);
      await expect(feeVerifier.connect(admin).setMaxStaleness(0n))
        .to.be.revertedWithCustomError(feeVerifier, "InvalidMaxStaleness");

      await feeVerifier.connect(admin).setTokenUsdPriceAggregatorProxy(
        [feeTokenAddress, tokenAAddress, tokenBAddress],
        [aggregatorAddress, aggregatorAddress, aggregatorAddress]
      );
      const setFeeTokensTx = await feeVerifier.connect(admin).setAssetFeeToken(
        [tokenAAddress, tokenBAddress],
        [feeTokenAddress, tokenAAddress]
      );
      await expect(setFeeTokensTx).to.emit(feeVerifier, "AssetFeeTokenUpdated")
        .withArgs(tokenAAddress, feeTokenAddress);
      await expect(setFeeTokensTx).to.emit(feeVerifier, "AssetFeeTokenUpdated")
        .withArgs(tokenBAddress, tokenAAddress);
      expect(await feeVerifier.getFeeToken(tokenAAddress)).to.equal(feeTokenAddress);
      expect(await feeVerifier.getFeeToken(tokenBAddress)).to.equal(tokenAAddress);

      const resetFeeTokensTx = await feeVerifier.connect(admin).setAssetFeeToken(
        [tokenAAddress, tokenBAddress],
        [ZERO_ADDRESS, tokenBAddress]
      );
      await expect(resetFeeTokensTx).to.emit(feeVerifier, "AssetFeeTokenUpdated")
        .withArgs(tokenAAddress, ZERO_ADDRESS);
      await expect(resetFeeTokensTx).to.emit(feeVerifier, "AssetFeeTokenUpdated")
        .withArgs(tokenBAddress, ZERO_ADDRESS);
      expect(await feeVerifier.getFeeToken(tokenAAddress)).to.equal(tokenAAddress);
      expect(await feeVerifier.getFeeToken(tokenBAddress)).to.equal(tokenBAddress);
      await expect(feeVerifier.connect(admin).setAssetFeeToken([tokenAAddress], []))
        .to.be.revertedWithCustomError(feeVerifier, "ArrayLengthMismatch");
      await expect(feeVerifier.connect(admin).setAssetFeeToken([ZERO_ADDRESS], [feeTokenAddress]))
        .to.be.revertedWithCustomError(feeVerifier, "InvalidZeroAddress");

      expect(await feeVerifier.tokenUsdPriceUpdatedAt(feeTokenAddress)).to.equal(0);
      const setFeeTokenPriceTx = await feeVerifier.connect(bookKeeper).setTokenUsdPrice(feeTokenAddress, 5_0000000000n);
      const setFeeTokenPriceReceipt = await setFeeTokenPriceTx.wait();
      const setFeeTokenPriceBlock = await ethers.provider.getBlock(setFeeTokenPriceReceipt!.blockNumber);
      expect(await feeVerifier.tokenUsdPrices(feeTokenAddress)).to.equal(5_0000000000n);
      expect(await feeVerifier.tokenUsdPriceUpdatedAt(feeTokenAddress)).to.equal(
        BigInt(setFeeTokenPriceBlock!.timestamp)
      );
      await expect(feeVerifier.connect(bookKeeper).clearTokenUsdPrice(feeTokenAddress))
        .to.emit(feeVerifier, "TokenUsdPriceCleared")
        .withArgs(feeTokenAddress);
      expect(await feeVerifier.tokenUsdPrices(feeTokenAddress)).to.equal(0);
      expect(await feeVerifier.tokenUsdPriceUpdatedAt(feeTokenAddress)).to.equal(0);
      await feeVerifier.connect(bookKeeper).setTokenUsdPrice(ZERO_ADDRESS, 1n);
      expect(await feeVerifier.tokenUsdPrices(ZERO_ADDRESS)).to.equal(1n);
      await expect(feeVerifier.connect(bookKeeper).setTokenUsdPrice(feeTokenAddress, 0n))
        .to.be.revertedWithCustomError(feeVerifier, "InvalidUsdPrice");

      await expect(feeVerifier.connect(admin).setTokenUsdPriceAggregatorProxy([tokenAAddress], [aggregatorAddress]))
        .to.emit(feeVerifier, "TokenUsdPriceAggregatorProxyUpdated")
        .withArgs(tokenAAddress, aggregatorAddress);
      expect(await feeVerifier.tokenUsdPriceAggregatorProxies(tokenAAddress)).to.equal(aggregatorAddress);

      await expect(feeVerifier.connect(admin).setTokenUsdPriceAggregatorProxy([tokenAAddress], [ZERO_ADDRESS]))
        .to.emit(feeVerifier, "TokenUsdPriceAggregatorProxyUpdated")
        .withArgs(tokenAAddress, ZERO_ADDRESS);
      expect(await feeVerifier.tokenUsdPriceAggregatorProxies(tokenAAddress)).to.equal(ZERO_ADDRESS);

      await expect(feeVerifier.connect(admin).setTokenUsdPriceAggregatorProxy([tokenAAddress], []))
        .to.be.revertedWithCustomError(feeVerifier, "ArrayLengthMismatch");
      await expect(feeVerifier.connect(admin).setTokenUsdPriceAggregatorProxy([ZERO_ADDRESS], [aggregatorAddress]))
        .to.be.revertedWithCustomError(feeVerifier, "InvalidZeroAddress");
    });

    it("rejects stale or invalid aggregator proxies when setting token prices", async function () {
      const { feeVerifier, admin, tokenA } = await networkHelpers.loadFixture(deployFlashLoanFixture);
      const tokenAAddress = await tokenA.getAddress();

      const staleUpdatedAt = BigInt(await networkHelpers.time.latest()) - DEFAULT_MAX_STALENESS - 1n;
      const staleAggregator = await deployAggregator(100_000_000n, staleUpdatedAt);
      await expect(
        feeVerifier.connect(admin).setTokenUsdPriceAggregatorProxy([tokenAAddress], [await staleAggregator.getAddress()])
      ).to.be.revertedWithCustomError(feeVerifier, "StalePrice");
      expect(await feeVerifier.tokenUsdPriceAggregatorProxies(tokenAAddress)).to.equal(ZERO_ADDRESS);

      const zeroPriceAggregator = await deployAggregator(0n);
      await expect(
        feeVerifier.connect(admin).setTokenUsdPriceAggregatorProxy([tokenAAddress], [await zeroPriceAggregator.getAddress()])
      ).to.be.revertedWithCustomError(feeVerifier, "InvalidUsdPrice");
      expect(await feeVerifier.tokenUsdPriceAggregatorProxies(tokenAAddress)).to.equal(ZERO_ADDRESS);

      const negativePriceAggregator = await deployAggregator(-1n);
      await expect(
        feeVerifier.connect(admin).setTokenUsdPriceAggregatorProxy([tokenAAddress], [await negativePriceAggregator.getAddress()])
      ).to.be.revertedWithCustomError(feeVerifier, "InvalidUsdPrice");
      expect(await feeVerifier.tokenUsdPriceAggregatorProxies(tokenAAddress)).to.equal(ZERO_ADDRESS);

      const unsupportedDecimalsAggregator = await deployAggregator(100_000_000n, undefined, 19);
      await expect(
        feeVerifier.connect(admin).setTokenUsdPriceAggregatorProxy(
          [tokenAAddress],
          [await unsupportedDecimalsAggregator.getAddress()]
        )
      ).to.be.revertedWithCustomError(feeVerifier, "AggregatorDecimalsTooHigh")
        .withArgs(tokenAAddress, await unsupportedDecimalsAggregator.getAddress());
      expect(await feeVerifier.tokenUsdPriceAggregatorProxies(tokenAAddress)).to.equal(ZERO_ADDRESS);
    });

    it("rejects fee-token overrides without a valid fee-token price", async function () {
      const { feeVerifier, admin, bookKeeper, tokenA, feeToken } =
        await networkHelpers.loadFixture(deployFlashLoanFixture);
      const tokenAAddress = await tokenA.getAddress();
      const feeTokenAddress = await feeToken.getAddress();

      await expect(feeVerifier.connect(admin).setAssetFeeToken([tokenAAddress], [feeTokenAddress]))
        .to.be.revertedWithCustomError(feeVerifier, "MissingTokenUsdPrice")
        .withArgs(feeTokenAddress);

      await feeVerifier.connect(bookKeeper).setTokenUsdPrice(feeTokenAddress, 5_0000000000n);
      await networkHelpers.time.increase(Number(DEFAULT_MAX_STALENESS + 1n));

      await expect(feeVerifier.connect(admin).setAssetFeeToken([tokenAAddress], [feeTokenAddress]))
        .to.be.revertedWithCustomError(feeVerifier, "StalePrice");
      expect(await feeVerifier.getFeeToken(tokenAAddress)).to.equal(tokenAAddress);
    });
  });

  describe("fee calculation and verification", function () {
    it("rounds fees up in the borrowed token by default", async function () {
      const { feeVerifier, tokenA } = await networkHelpers.loadFixture(deployFlashLoanFixture);

      expect(await feeVerifier.getFeeAmount(await tokenA.getAddress(), 1n)).to.equal(1n);
      expect(await feeVerifier.getFeeAmount(await tokenA.getAddress(), HUNDRED_TOKENS)).to.equal(
        HUNDRED_TOKENS * DEFAULT_FEE_BPS / 10_000n
      );
    });

    it("converts fees to an override fee token with aggregator and fallback pricing", async function () {
      const { feeVerifier, admin, bookKeeper, tokenA, feeToken } =
        await networkHelpers.loadFixture(deployFlashLoanFixture);
      const tokenAAddress = await tokenA.getAddress();
      const feeTokenAddress = await feeToken.getAddress();
      const aggregator = await deployAggregator(200_000_000n);

      await feeVerifier.connect(admin).setTokenUsdPriceAggregatorProxy([tokenAAddress], [await aggregator.getAddress()]);
      await feeVerifier.connect(bookKeeper).setTokenUsdPrice(feeTokenAddress, 5_0000000000n);
      await feeVerifier.connect(admin).setAssetFeeToken([tokenAAddress], [feeTokenAddress]);

      expect(await feeVerifier.getFeeAmount(tokenAAddress, HUNDRED_TOKENS)).to.equal(ethers.parseEther("0.02"));
    });

    it("aggregates duplicate fee assets and verifies balances", async function () {
      const { feeVerifier, tokenA, tokenB, feeRecipient } =
        await networkHelpers.loadFixture(deployFlashLoanFixture);
      const tokenAAddress = await tokenA.getAddress();
      const tokenBAddress = await tokenB.getAddress();

      const [feeAssets, balancesBefore, aggregatedFees, feeAssetCount] =
        await feeVerifier.snapshotFees(
          [tokenAAddress, tokenAAddress, tokenBAddress],
          [ethers.parseEther("10"), 1n, ethers.parseUnits("10", 6)]
        );

      expect(feeAssetCount).to.equal(2n);
      expect(feeAssets).to.deep.equal([tokenAAddress, tokenBAddress]);
      expect(balancesBefore).to.have.length(2);
      const tenTokenFee = ethers.parseEther("10") * DEFAULT_FEE_BPS / 10_000n;
      const tokenBTenTokenFee = ethers.parseUnits("10", 6) * DEFAULT_FEE_BPS / 10_000n;
      expect(aggregatedFees).to.deep.equal([tenTokenFee + 1n, tokenBTenTokenFee]);
      const feeAssetArray = Array.from(feeAssets);
      const balancesBeforeArray = Array.from(balancesBefore);
      const aggregatedFeeArray = Array.from(aggregatedFees);
      expect(await feeVerifier.verifyFees(feeAssetArray, balancesBeforeArray, aggregatedFeeArray, feeAssetCount)).to.equal(false);

      await mint(tokenA, feeRecipient.address, tenTokenFee + 1n);
      await mint(tokenB, feeRecipient.address, tokenBTenTokenFee);
      expect(await feeVerifier.verifyFees(feeAssetArray, balancesBeforeArray, aggregatedFeeArray, feeAssetCount)).to.equal(true);
    });
  });

  describe("oracle edge cases", function () {
    it("rejects fee-token overrides without a valid borrowed-token price", async function () {
      const { feeVerifier, admin, bookKeeper, tokenA, feeToken } =
        await networkHelpers.loadFixture(deployFlashLoanFixture);
      const tokenAAddress = await tokenA.getAddress();

      await feeVerifier.connect(bookKeeper).setTokenUsdPrice(await feeToken.getAddress(), 5_0000000000n);

      await expect(feeVerifier.connect(admin).setAssetFeeToken([tokenAAddress], [await feeToken.getAddress()]))
        .to.be.revertedWithCustomError(feeVerifier, "MissingTokenUsdPrice")
        .withArgs(tokenAAddress);
      expect(await feeVerifier.getFeeToken(tokenAAddress)).to.equal(tokenAAddress);
    });

    it("rejects stale, zero, negative, and unsupported oracle prices", async function () {
      const { feeVerifier, admin, bookKeeper, tokenA, feeToken } =
        await networkHelpers.loadFixture(deployFlashLoanFixture);
      const tokenAAddress = await tokenA.getAddress();
      const feeTokenAddress = await feeToken.getAddress();
      const now = BigInt(await networkHelpers.time.latest());
      const aggregator = await deployAggregator(200_000_000n, now);

      await feeVerifier.connect(admin).setTokenUsdPriceAggregatorProxy([tokenAAddress], [await aggregator.getAddress()]);
      await feeVerifier.connect(bookKeeper).setTokenUsdPrice(feeTokenAddress, 5_0000000000n);
      await feeVerifier.connect(admin).setAssetFeeToken([tokenAAddress], [feeTokenAddress]);

      await aggregator.setLatestRoundData(1n, 200_000_000n, now, now - DEFAULT_MAX_STALENESS - 1n, 1n);
      await expect(feeVerifier.getFeeAmount(tokenAAddress, HUNDRED_TOKENS))
        .to.be.revertedWithCustomError(feeVerifier, "StalePrice");

      await aggregator.setLatestRoundData(1n, 0n, now, now, 1n);
      await expect(feeVerifier.getFeeAmount(tokenAAddress, HUNDRED_TOKENS))
        .to.be.revertedWithCustomError(feeVerifier, "InvalidUsdPrice");

      await aggregator.setLatestRoundData(1n, -1n, now, now, 1n);
      await expect(feeVerifier.getFeeAmount(tokenAAddress, HUNDRED_TOKENS))
        .to.be.revertedWithCustomError(feeVerifier, "InvalidUsdPrice");

      await aggregator.setLatestRoundData(1n, 1n, now, 0n, 1n);
      await expect(feeVerifier.getFeeAmount(tokenAAddress, HUNDRED_TOKENS))
        .to.be.revertedWithCustomError(feeVerifier, "InvalidUsdPrice");

      await aggregator.setDecimals(19);
      await aggregator.setLatestRoundData(1n, 1n, now, now, 1n);
      await expect(feeVerifier.getFeeAmount(tokenAAddress, HUNDRED_TOKENS))
        .to.be.revertedWithCustomError(feeVerifier, "AggregatorDecimalsTooHigh")
        .withArgs(tokenAAddress, await aggregator.getAddress());
    });

    it("rejects stale fallback fee-token prices", async function () {
      const { feeVerifier, admin, bookKeeper, tokenA, feeToken } =
        await networkHelpers.loadFixture(deployFlashLoanFixture);
      const tokenAAddress = await tokenA.getAddress();
      const feeTokenAddress = await feeToken.getAddress();

      const aggregator = await deployAggregator(200_000_000n);
      await feeVerifier.connect(admin).setTokenUsdPriceAggregatorProxy([tokenAAddress], [await aggregator.getAddress()]);
      await feeVerifier.connect(bookKeeper).setTokenUsdPrice(feeTokenAddress, 5_0000000000n);
      await feeVerifier.connect(admin).setAssetFeeToken([tokenAAddress], [feeTokenAddress]);
      await networkHelpers.time.increase(Number(DEFAULT_MAX_STALENESS + 1n));

      await expect(feeVerifier.getFeeAmount(tokenAAddress, HUNDRED_TOKENS))
        .to.be.revertedWithCustomError(feeVerifier, "StalePrice");
    });

    it("rejects token decimals above the supported unit conversion range", async function () {
      const { feeVerifier, admin, bookKeeper, feeToken } = await networkHelpers.loadFixture(deployFlashLoanFixture);
      const highDecimalsToken = await deployToken("High Decimals", "HIGH", 19);
      const tokenAddress = await highDecimalsToken.getAddress();
      const aggregator = await deployAggregator(100_000_000n);

      await feeVerifier.connect(admin).setTokenUsdPriceAggregatorProxy([tokenAddress], [await aggregator.getAddress()]);
      await feeVerifier.connect(bookKeeper).setTokenUsdPrice(await feeToken.getAddress(), 1_0000000000n);
      await feeVerifier.connect(admin).setAssetFeeToken([tokenAddress], [await feeToken.getAddress()]);

      await expect(feeVerifier.getFeeAmount(tokenAddress, HUNDRED_TOKENS))
        .to.be.revertedWithCustomError(feeVerifier, "TokenDecimalsTooHigh")
        .withArgs(tokenAddress);
    });
  });
});
