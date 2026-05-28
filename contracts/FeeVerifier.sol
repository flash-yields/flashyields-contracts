// SPDX-License-Identifier: MIT
pragma solidity ^0.8.27;

import { IERC20 } from "./dependencies/openzeppelin-v5.0.1/token/ERC20/IERC20.sol";
import { IERC20Metadata } from "./dependencies/openzeppelin-v5.0.1/token/ERC20/extensions/IERC20Metadata.sol";
import { Math } from "./dependencies/openzeppelin-v5.0.1/utils/math/Math.sol";
import { IACLManager } from "./interfaces/IACLManager.sol";
import { IEACAggregatorProxy } from "./interfaces/IEACAggregatorProxy.sol";
import { IFeeVerifier } from "./interfaces/IFeeVerifier.sol";

/// @title FeeVerifier
/// @notice Manages flash loan fee configuration, computes fees, snapshots balances,
/// and verifies that fees are correctly paid to the fee recipient.
contract FeeVerifier is IFeeVerifier {
    IACLManager public immutable aclManager;

    /// @notice Basis-point denominator used for fee calculations.
    uint256 public constant BPS_DENOMINATOR = 10_000;

    /// @notice Decimal scale used by stored USD prices and normalized aggregator prices.
    uint256 public constant USD_PRICE_DECIMALS = 10;

    /// @dev Highest ERC20 decimals value that can be converted to a token unit
    uint8 internal constant MAX_TOKEN_DECIMALS = 18;

    /// @dev Highest aggregator price decimals value supported for price normalization.
    uint8 internal constant MAX_ORACLE_PRICE_DECIMALS = 18;

    /// @notice Flash loan fee charged on each borrowed amount, expressed in basis points.
    uint256 public flashLoanFeeBps;

    /// @notice Maximum allowed oracle price age, in seconds.
    uint256 public maxStaleness;

    /// @notice Per-asset flash loan fee overrides, expressed in basis points.
    /// Only meaningful when `assetFlashLoanFeeBpsIsSet[asset]` is true; otherwise the
    /// default `flashLoanFeeBps` is used.
    mapping(address => uint256) public assetFlashLoanFeeBps;

    /// @notice Whether a per-asset flash loan fee override is currently set.
    /// When false, the default `flashLoanFeeBps` is used for the asset.
    mapping(address => bool) public assetFlashLoanFeeBpsIsSet;

    /// @notice Per-borrowed-token fee token overrides.
    /// A value of 0 means no override (use the borrowed token itself).
    mapping(address => address) public assetFeeTokens;

    /// @notice Fallback token USD prices used for fee-token conversion.
    /// A value of 0 means the price has not been set.
    mapping(address => uint256) public tokenUsdPrices;

    /// @notice Last update timestamp for fallback token USD prices.
    /// A value of 0 means the price has not been set.
    mapping(address => uint256) public tokenUsdPriceUpdatedAt;

    /// @notice EACAggregatorProxy addresses used to read token USD prices.
    /// A value of 0 means the aggregator proxy has not been set.
    mapping(address => address) public tokenUsdPriceAggregatorProxies;

    /// @notice Address that receives all flash loan fees.
    address public feeRecipient;

    modifier onlyAdminRole() {
        aclManager.checkAdminRole(msg.sender);
        _;
    }

    modifier onlyBookKeeperRole() {
        aclManager.checkBookKeeperRole(msg.sender);
        _;
    }

    /// @param aclManager_ The ACL manager contract for role-based access control.
    /// @param feeRecipient_ The initial address that receives flash loan fees.
    /// @param flashLoanFeeBps_ The fee in basis points charged on each borrowed amount.
    /// @param maxStaleness_ The maximum allowed oracle price age, in seconds.
    constructor(
        IACLManager aclManager_,
        address feeRecipient_,
        uint256 flashLoanFeeBps_,
        uint256 maxStaleness_
    ) {
        if (address(aclManager_) == address(0)) revert InvalidZeroAddress();
        if (feeRecipient_ == address(0)) revert InvalidZeroAddress();
        if (flashLoanFeeBps_ > BPS_DENOMINATOR) revert FeeBpsTooHigh();
        if (maxStaleness_ == 0) revert InvalidMaxStaleness();

        aclManager = aclManager_;
        feeRecipient = feeRecipient_;
        flashLoanFeeBps = flashLoanFeeBps_;
        maxStaleness = maxStaleness_;
    }

    /// @inheritdoc IFeeVerifier
    function setFeeRecipient(address newFeeRecipient) external onlyAdminRole {
        if (newFeeRecipient == address(0)) revert InvalidZeroAddress();

        feeRecipient = newFeeRecipient;

        emit FeeRecipientUpdated(newFeeRecipient);
    }

    /// @inheritdoc IFeeVerifier
    function setFlashLoanFeeBps(uint256 newFeeBps) external onlyAdminRole {
        if (newFeeBps > BPS_DENOMINATOR) revert FeeBpsTooHigh();

        flashLoanFeeBps = newFeeBps;

        emit FlashLoanFeeBpsUpdated(newFeeBps);
    }

    /// @inheritdoc IFeeVerifier
    function setAssetFlashLoanFeeBps(
        address[] calldata assets,
        uint256[] calldata newFeeBps
    ) external onlyAdminRole {
        if (assets.length != newFeeBps.length) revert ArrayLengthMismatch();

        for (uint256 i = 0; i < assets.length; i++) {
            address asset = assets[i];
            if (asset == address(0)) revert InvalidZeroAddress();

            uint256 newAssetFeeBps = newFeeBps[i];
            if (newAssetFeeBps > BPS_DENOMINATOR) revert FeeBpsTooHigh();

            assetFlashLoanFeeBps[asset] = newAssetFeeBps;
            assetFlashLoanFeeBpsIsSet[asset] = true;

            emit AssetFlashLoanFeeBpsUpdated(asset, newAssetFeeBps);
        }
    }

    /// @inheritdoc IFeeVerifier
    function clearAssetFlashLoanFeeBps(address[] calldata assets) external onlyAdminRole {
        for (uint256 i = 0; i < assets.length; i++) {
            address asset = assets[i];
            if (asset == address(0)) revert InvalidZeroAddress();

            delete assetFlashLoanFeeBps[asset];
            delete assetFlashLoanFeeBpsIsSet[asset];

            emit AssetFlashLoanFeeBpsCleared(asset);
        }
    }

    /// @inheritdoc IFeeVerifier
    function setMaxStaleness(uint256 newMaxStaleness) external onlyAdminRole {
        if (newMaxStaleness == 0) revert InvalidMaxStaleness();

        maxStaleness = newMaxStaleness;

        emit MaxStalenessUpdated(newMaxStaleness);
    }

    /// @inheritdoc IFeeVerifier
    function setAssetFeeToken(address[] calldata assets, address[] calldata feeTokens) external onlyAdminRole {
        if (assets.length != feeTokens.length) revert ArrayLengthMismatch();

        for (uint256 i = 0; i < assets.length; i++) {
            address asset = assets[i];
            if (asset == address(0)) revert InvalidZeroAddress();

            address newFeeToken = feeTokens[i] == asset ? address(0) : feeTokens[i];
            if (newFeeToken != address(0)) {
                _getFeeTokenUsdPrice(newFeeToken);
                _getBorrowedTokenUsdPrice(asset);
            }
            assetFeeTokens[asset] = newFeeToken;

            emit AssetFeeTokenUpdated(asset, newFeeToken);
        }
    }

    /// @inheritdoc IFeeVerifier
    function setTokenUsdPriceAggregatorProxy(
        address[] calldata tokens,
        address[] calldata newAggregatorProxies
    ) external onlyAdminRole {
        if (tokens.length != newAggregatorProxies.length) revert ArrayLengthMismatch();

        for (uint256 i = 0; i < tokens.length; i++) {
            address token = tokens[i];
            if (token == address(0)) revert InvalidZeroAddress();

            address newAggregatorProxy = newAggregatorProxies[i];
            if (newAggregatorProxy != address(0)) {
                _getAggregatorUsdPrice(token, newAggregatorProxy);
            }
            tokenUsdPriceAggregatorProxies[token] = newAggregatorProxy;

            emit TokenUsdPriceAggregatorProxyUpdated(token, newAggregatorProxy);
        }
    }

    /// @inheritdoc IFeeVerifier
    function setTokenUsdPrice(address token, uint256 newUsdPrice) external onlyBookKeeperRole {
        if (newUsdPrice == 0) revert InvalidUsdPrice();

        tokenUsdPrices[token] = newUsdPrice;
        tokenUsdPriceUpdatedAt[token] = block.timestamp;
    }

    /// @inheritdoc IFeeVerifier
    function clearTokenUsdPrice(address token) external onlyBookKeeperRole {
        delete tokenUsdPrices[token];
        delete tokenUsdPriceUpdatedAt[token];

        emit TokenUsdPriceCleared(token);
    }

    /// @inheritdoc IFeeVerifier
    function getEffectiveFlashLoanFeeBps(address asset) external view returns (uint256) {
        return _getFlashLoanFeeBps(asset);
    }

    /// @dev Returns the effective flash loan fee in basis points for the given asset.
    /// If a per-asset override has been explicitly set, returns it (including 0);
    /// otherwise, returns the default `flashLoanFeeBps`.
    function _getFlashLoanFeeBps(address asset) internal view returns (uint256) {
        if (assetFlashLoanFeeBpsIsSet[asset]) {
            return assetFlashLoanFeeBps[asset];
        }
        return flashLoanFeeBps;
    }

    /// @inheritdoc IFeeVerifier
    function getFeeToken(address asset) external view returns (address) {
        return _getFeeToken(asset);
    }

    /// @inheritdoc IFeeVerifier
    function getFeeAmount(address asset, uint256 amount) external view returns (uint256) {
        return _calculateFee(asset, amount, _getFeeToken(asset));
    }

    /// @dev Returns the effective fee token for the borrowed asset.
    function _getFeeToken(address asset) internal view returns (address) {
        address feeToken = assetFeeTokens[asset];
        if (feeToken != address(0)) {
            return feeToken;
        }
        return asset;
    }

    /// @inheritdoc IFeeVerifier
    function snapshotFees(
        address[] calldata assets,
        uint256[] calldata amounts
    ) external view returns (
        address[] memory feeAssets,
        uint256[] memory feeRecipientBalancesBefore,
        uint256[] memory aggregatedFees,
        uint256 feeAssetCount
    ) {
        address[] memory feeAssetsTemp = new address[](assets.length);
        uint256[] memory feeRecipientBalancesBeforeTemp = new uint256[](assets.length);
        uint256[] memory aggregatedFeesTemp = new uint256[](assets.length);
        feeAssetCount = 0;

        address _feeRecipient = feeRecipient;

        for (uint256 i = 0; i < assets.length; i++) {
            address feeAsset = _getFeeToken(assets[i]);
            uint256 fee = _calculateFee(assets[i], amounts[i], feeAsset);
            if (fee == 0) {
                continue;
            }

            uint256 feeAssetIndex = _findFeeAssetIndex(feeAssetsTemp, feeAssetCount, feeAsset);
            if (feeAssetIndex == feeAssetCount) {
                feeAssetsTemp[feeAssetIndex] = feeAsset;
                feeRecipientBalancesBeforeTemp[feeAssetIndex] = IERC20(feeAsset).balanceOf(_feeRecipient);
                feeAssetCount++;
            }
            aggregatedFeesTemp[feeAssetIndex] += fee;
        }

        if (feeAssetCount == assets.length) {
            feeAssets = feeAssetsTemp;
            feeRecipientBalancesBefore = feeRecipientBalancesBeforeTemp;
            aggregatedFees = aggregatedFeesTemp;
            return (feeAssets, feeRecipientBalancesBefore, aggregatedFees, feeAssetCount);
        }

        feeAssets = new address[](feeAssetCount);
        feeRecipientBalancesBefore = new uint256[](feeAssetCount);
        aggregatedFees = new uint256[](feeAssetCount);

        for (uint256 i = 0; i < feeAssetCount; i++) {
            feeAssets[i] = feeAssetsTemp[i];
            feeRecipientBalancesBefore[i] = feeRecipientBalancesBeforeTemp[i];
            aggregatedFees[i] = aggregatedFeesTemp[i];
        }
    }

    /// @inheritdoc IFeeVerifier
    function verifyFees(
        address[] calldata feeAssets,
        uint256[] calldata feeRecipientBalancesBefore,
        uint256[] calldata aggregatedFees,
        uint256 feeAssetCount
    ) external view returns (bool) {
        address _feeRecipient = feeRecipient;

        for (uint256 i = 0; i < feeAssetCount; i++) {
            if (
                IERC20(feeAssets[i]).balanceOf(_feeRecipient) <
                feeRecipientBalancesBefore[i] + aggregatedFees[i]
            ) {
                return false;
            }
        }
        return true;
    }

    /// @dev Calculates the fee amount denominated in the configured fee token.
    function _calculateFee(
        address asset,
        uint256 amount,
        address feeToken
    ) internal view returns (uint256) {
        uint256 feeInBorrowedToken = Math.mulDiv(
            amount,
            _getFlashLoanFeeBps(asset),
            BPS_DENOMINATOR,
            Math.Rounding.Ceil
        );

        if (feeToken == asset || feeInBorrowedToken == 0) {
            return feeInBorrowedToken;
        }

        return _convertFeeToToken(asset, feeToken, feeInBorrowedToken);
    }

    /// @dev Converts a fee from the borrowed token into the configured fee token through USD prices.
    function _convertFeeToToken(
        address borrowedToken,
        address feeToken,
        uint256 borrowedTokenFee
    ) internal view returns (uint256) {
        uint256 borrowedTokenUsdPrice = _getBorrowedTokenUsdPrice(borrowedToken);
        uint256 feeTokenUsdPrice = _getFeeTokenUsdPrice(feeToken);

        uint256 usdFee = Math.mulDiv(
            borrowedTokenFee,
            borrowedTokenUsdPrice,
            _tokenUnit(borrowedToken),
            Math.Rounding.Ceil
        );

        return Math.mulDiv(
            usdFee,
            _tokenUnit(feeToken),
            feeTokenUsdPrice,
            Math.Rounding.Ceil
        );
    }

    /// @dev Returns the borrowed token's USD price from its configured aggregator proxy.
    function _getBorrowedTokenUsdPrice(address token) internal view returns (uint256) {
        address aggregatorProxy = tokenUsdPriceAggregatorProxies[token];
        if (aggregatorProxy == address(0)) revert MissingTokenUsdPrice(token);

        return _getAggregatorUsdPrice(token, aggregatorProxy);
    }

    /// @dev Returns the fee token's USD price, falling back to stored prices when no aggregator is set.
    function _getFeeTokenUsdPrice(address token) internal view returns (uint256) {
        address aggregatorProxy = tokenUsdPriceAggregatorProxies[token];
        if (aggregatorProxy != address(0)) {
            return _getAggregatorUsdPrice(token, aggregatorProxy);
        }

        uint256 usdPrice = tokenUsdPrices[token];
        if (usdPrice == 0) revert MissingTokenUsdPrice(token);

        if (block.timestamp - tokenUsdPriceUpdatedAt[token] > maxStaleness) revert StalePrice();

        return usdPrice;
    }

    /// @dev Reads and normalizes the latest aggregator proxy price to `USD_PRICE_DECIMALS`.
    function _getAggregatorUsdPrice(address token, address aggregatorProxy) internal view returns (uint256) {
        IEACAggregatorProxy aggregator = IEACAggregatorProxy(aggregatorProxy);
        uint8 decimals = aggregator.decimals();
        if (decimals > MAX_ORACLE_PRICE_DECIMALS) {
            revert AggregatorDecimalsTooHigh(token, aggregatorProxy);
        }

        (, int256 answer,, uint256 updatedAt,) = aggregator.latestRoundData();
        if (answer <= 0 || updatedAt == 0) revert InvalidUsdPrice();
        if (block.timestamp - updatedAt > maxStaleness) revert StalePrice();

        return Math.mulDiv(
            uint256(answer),
            10 ** USD_PRICE_DECIMALS,
            10 ** decimals,
            Math.Rounding.Ceil
        );
    }

    /// @dev Returns one whole token in the token's smallest unit.
    function _tokenUnit(address token) internal view returns (uint256) {
        uint8 decimals = IERC20Metadata(token).decimals();
        if (decimals > MAX_TOKEN_DECIMALS) revert TokenDecimalsTooHigh(token);

        return 10 ** decimals;
    }

    /// @dev Returns the index of the unique-asset entry, or the current unique-asset count when not found.
    function _findFeeAssetIndex(
        address[] memory feeAssets,
        uint256 feeAssetCount,
        address asset
    ) internal pure returns (uint256) {
        for (uint256 i = 0; i < feeAssetCount; i++) {
            if (feeAssets[i] == asset) {
                return i;
            }
        }
        return feeAssetCount;
    }
}
