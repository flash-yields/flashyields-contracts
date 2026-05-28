// SPDX-License-Identifier: MIT
pragma solidity ^0.8.27;

/// @title IFeeVerifier
/// @notice Interface for a contract that snapshots and verifies flash loan fee payments.
interface IFeeVerifier {
    /// @notice Thrown when a zero address is provided where a valid address is required.
    error InvalidZeroAddress();

    /// @notice Thrown when the configured fee exceeds 100% in basis points.
    error FeeBpsTooHigh();

    /// @notice Thrown when the maximum allowed oracle price age is zero.
    error InvalidMaxStaleness();

    /// @notice Thrown when paired array parameters have different lengths.
    error ArrayLengthMismatch();

    /// @notice Thrown when a USD price is zero or invalid.
    error InvalidUsdPrice();

    /// @notice Thrown when an oracle price is older than the configured maximum age.
    error StalePrice();

    /// @notice Thrown when a token needs a USD price but none has been set.
    /// @param token The token missing a USD price.
    error MissingTokenUsdPrice(address token);

    /// @notice Thrown when a token reports decimals too large for unit conversion.
    /// @param token The token with unsupported decimals.
    error TokenDecimalsTooHigh(address token);

    /// @notice Thrown when an aggregator proxy reports decimals too large for price normalization.
    /// @param token The token configured to use the aggregator proxy.
    /// @param aggregatorProxy The aggregator proxy with unsupported decimals.
    error AggregatorDecimalsTooHigh(address token, address aggregatorProxy);

    /// @notice Emitted when the fee recipient is updated.
    /// @param newFeeRecipient The new fee recipient address.
    event FeeRecipientUpdated(address indexed newFeeRecipient);

    /// @notice Emitted when the flash loan fee is updated.
    /// @param newFeeBps The new fee in basis points.
    event FlashLoanFeeBpsUpdated(uint256 newFeeBps);

    /// @notice Emitted when the maximum allowed oracle price age is updated.
    /// @param newMaxStaleness The new maximum price age, in seconds.
    event MaxStalenessUpdated(uint256 newMaxStaleness);

    /// @notice Emitted when a per-asset flash loan fee override is set.
    /// @param asset The ERC20 token address.
    /// @param newFeeBps The new fee in basis points for this asset.
    event AssetFlashLoanFeeBpsUpdated(address indexed asset, uint256 newFeeBps);

    /// @notice Emitted when a per-asset flash loan fee override is cleared.
    /// @param asset The ERC20 token address.
    event AssetFlashLoanFeeBpsCleared(address indexed asset);

    /// @notice Emitted when a borrowed asset's fee token override is set or reset.
    /// @param asset The borrowed ERC20 token address.
    /// @param newFeeToken The new configured fee token override. A zero address means the default.
    event AssetFeeTokenUpdated(address indexed asset, address indexed newFeeToken);

    /// @notice Emitted when a token's USD price aggregator proxy is updated.
    /// @param token The ERC20 token address.
    /// @param newAggregatorProxy The new aggregator proxy address.
    event TokenUsdPriceAggregatorProxyUpdated(address indexed token, address indexed newAggregatorProxy);

    /// @notice Emitted when a token's fallback USD price is cleared.
    /// @param token The ERC20 token address.
    event TokenUsdPriceCleared(address indexed token);

    /// @notice Returns the address that receives all flash loan fees.
    function feeRecipient() external view returns (address);

    /// @notice Updates the address that receives flash loan fees.
    /// @param newFeeRecipient The new fee recipient address.
    function setFeeRecipient(address newFeeRecipient) external;

    /// @notice Updates the flash loan fee in basis points.
    /// @param newFeeBps The new fee in basis points (must not exceed 100%).
    function setFlashLoanFeeBps(uint256 newFeeBps) external;

    /// @notice Sets flash loan fee overrides for multiple assets.
    /// @param assets The ERC20 token addresses to configure.
    /// @param newFeeBps The fee in basis points for each asset (must not exceed 100%).
    ///        A value of 0 sets an explicit 0-BPS override (no fee). To remove an override
    ///        and revert to the default fee, use `clearAssetFlashLoanFeeBps`.
    function setAssetFlashLoanFeeBps(address[] calldata assets, uint256[] calldata newFeeBps) external;

    /// @notice Clears per-asset flash loan fee overrides so the default fee applies.
    /// @param assets The ERC20 token addresses whose overrides should be cleared.
    function clearAssetFlashLoanFeeBps(address[] calldata assets) external;

    /// @notice Updates the maximum allowed oracle price age.
    /// @param newMaxStaleness The new maximum price age, in seconds.
    function setMaxStaleness(uint256 newMaxStaleness) external;

    /// @notice Sets the tokens used to pay fees for borrowed assets.
    /// @param assets The borrowed ERC20 token addresses to configure.
    /// @param feeTokens The ERC20 fee token address for each asset. Setting to zero or the asset resets to the default.
    ///        Non-default fee tokens must already have a valid aggregator or fresh fallback USD price.
    function setAssetFeeToken(address[] calldata assets, address[] calldata feeTokens) external;

    /// @notice Updates a token's fallback USD price for fee-token conversion.
    /// @param token The ERC20 token address.
    /// @param newUsdPrice The USD price per whole token, scaled by `USD_PRICE_DECIMALS`.
    function setTokenUsdPrice(address token, uint256 newUsdPrice) external;

    /// @notice Clears a token's fallback USD price and update timestamp.
    /// @param token The ERC20 token address.
    function clearTokenUsdPrice(address token) external;

    /// @notice Sets multiple token EACAggregatorProxy addresses.
    /// @param tokens The ERC20 token addresses.
    /// @param newAggregatorProxies The aggregator proxy addresses. A zero address unsets the proxy.
    function setTokenUsdPriceAggregatorProxy(
        address[] calldata tokens,
        address[] calldata newAggregatorProxies
    ) external;

    /// @notice Basis-point denominator used for fee calculations.
    function BPS_DENOMINATOR() external view returns (uint256);

    /// @notice Decimal scale used by stored USD prices and normalized aggregator prices.
    function USD_PRICE_DECIMALS() external view returns (uint256);

    /// @notice Flash loan fee charged on each borrowed amount, expressed in basis points.
    function flashLoanFeeBps() external view returns (uint256);

    /// @notice Maximum allowed oracle price age, in seconds.
    function maxStaleness() external view returns (uint256);

    /// @notice Per-asset flash loan fee overrides, expressed in basis points.
    /// Only meaningful when `assetFlashLoanFeeBpsIsSet(asset)` returns true; otherwise
    /// the default `flashLoanFeeBps` is used.
    function assetFlashLoanFeeBps(address asset) external view returns (uint256);

    /// @notice Whether a per-asset flash loan fee override is currently set.
    /// When false, the default `flashLoanFeeBps` is used for the asset.
    function assetFlashLoanFeeBpsIsSet(address asset) external view returns (bool);

    /// @notice Per-borrowed-token fee token overrides.
    /// A value of 0 means no override (use the borrowed token itself).
    function assetFeeTokens(address asset) external view returns (address);

    /// @notice Fallback token USD prices used for fee-token conversion.
    /// A value of 0 means the price has not been set.
    function tokenUsdPrices(address token) external view returns (uint256);

    /// @notice Last update timestamp for fallback token USD prices.
    /// A value of 0 means the price has not been set.
    function tokenUsdPriceUpdatedAt(address token) external view returns (uint256);

    /// @notice EACAggregatorProxy addresses used to read token USD prices.
    /// A value of 0 means the aggregator proxy has not been set.
    function tokenUsdPriceAggregatorProxies(address token) external view returns (address);

    /// @notice Returns the effective flash loan fee for a given asset.
    /// @param asset The ERC20 token address.
    /// @return The fee in basis points (per-asset override if set, otherwise the default).
    function getEffectiveFlashLoanFeeBps(address asset) external view returns (uint256);

    /// @notice Returns the token used to pay fees for a borrowed asset.
    /// @param asset The borrowed ERC20 token address.
    /// @return The configured fee token, or `asset` when no override is set.
    function getFeeToken(address asset) external view returns (address);

    /// @notice Returns the fee amount owed for a borrowed asset amount.
    /// @param asset The borrowed ERC20 token address.
    /// @param amount The borrowed amount.
    /// @return The fee amount denominated in `getFeeToken(asset)`.
    function getFeeAmount(address asset, uint256 amount) external view returns (uint256);

    /// @notice Computes and aggregates fees, and snapshots feeRecipient balances for each unique fee token.
    /// @param assets The ERC20 token addresses corresponding to each lender entry.
    /// @param amounts The loan amount for each lender entry.
    /// @return feeAssets The unique fee token addresses that have fees, returned with length `feeAssetCount`.
    /// @return feeRecipientBalancesBefore The fee recipient's balance of each unique fee asset before the loan.
    ///         Returned with length `feeAssetCount`.
    /// @return aggregatedFees The total aggregated fee for each unique fee asset, returned with length `feeAssetCount`.
    /// @return feeAssetCount The number of unique fee assets.
    function snapshotFees(
        address[] calldata assets,
        uint256[] calldata amounts
    ) external view returns (
        address[] memory feeAssets,
        uint256[] memory feeRecipientBalancesBefore,
        uint256[] memory aggregatedFees,
        uint256 feeAssetCount
    );

    /// @notice Verifies that the fee recipient received the expected fees for each asset.
    /// @param feeAssets The unique ERC20 token addresses used for fee payment.
    /// @param feeRecipientBalancesBefore The fee recipient's balance of each fee asset before the loan.
    /// @param aggregatedFees The total fee expected for each fee asset.
    /// @param feeAssetCount The number of unique fee assets to check.
    /// @return True if the fee recipient's current balance for each fee asset is at least
    ///         `feeRecipientBalancesBefore[i] + aggregatedFees[i]`.
    function verifyFees(
        address[] calldata feeAssets,
        uint256[] calldata feeRecipientBalancesBefore,
        uint256[] calldata aggregatedFees,
        uint256 feeAssetCount
    ) external view returns (bool);
}
