// SPDX-License-Identifier: MIT
pragma solidity ^0.8.27;

import { IERC20 } from "../dependencies/openzeppelin-v5.0.1/token/ERC20/IERC20.sol";
import { SafeERC20 } from "../dependencies/openzeppelin-v5.0.1/token/ERC20/utils/SafeERC20.sol";
import { Ownable } from "../dependencies/openzeppelin-v5.0.1/access/Ownable.sol";
import { ApprovalFlashLoan } from "../ApprovalFlashLoan.sol";
import { IApprovalFlashLoan } from "../interfaces/IApprovalFlashLoan.sol";
import { IApprovalFlashLoanReceiver } from "../interfaces/IApprovalFlashLoanReceiver.sol";
import { IUniswapV3NonfungiblePositionManager } from "../test/IUniswapV3NonfungiblePositionManager.sol";

/// @title FlashLoanReceiverWithUniswap
/// @notice Example receiver implementation for flash loans issued by {ApprovalFlashLoan}.
contract FlashLoanReceiverWithUniswap is Ownable, IApprovalFlashLoanReceiver {
    using SafeERC20 for IERC20;

    /// @notice Thrown when a caller other than the configured flash loan contract invokes the callback.
    error CallerNotFlashLoanContract();

    /// @notice Thrown when the flash loan was not initiated by this receiver contract.
    error InvalidInitiator();

    /// @notice Thrown when the Uniswap V3 mint returns no liquidity.
    error UniswapV3NoLiquidityMinted();

    /// @notice The flash loan contract that is allowed to invoke {executeOperation}.
    ApprovalFlashLoan public immutable flashLoanContract;

    /// @notice The Uniswap V3 position manager used for pool setup and liquidity round trips.
    IUniswapV3NonfungiblePositionManager public immutable uniswapV3PositionManager;

    /// @notice Default 0.3% Uniswap V3 fee tier.
    uint24 public constant DEFAULT_UNISWAP_V3_FEE = 3_000;

    /// @notice Default initial pool price of 1 token1 per token0 in Q64.96 format.
    uint160 public constant DEFAULT_UNISWAP_V3_SQRT_PRICE_X96 = 79_228_162_514_264_337_593_543_950_336;

    /// @notice Default lower tick for full-range 0.3% Uniswap V3 positions.
    int24 public constant DEFAULT_UNISWAP_V3_TICK_LOWER = -887_220;

    /// @notice Default upper tick for full-range 0.3% Uniswap V3 positions.
    int24 public constant DEFAULT_UNISWAP_V3_TICK_UPPER = 887_220;

    /// @notice Optional Uniswap V3 liquidity parameters forwarded through flash-loan params.
    /// @dev A zero value for fee, sqrtPriceX96, deadline, or both ticks applies the default.
    struct UniswapV3LiquidityParams {
        uint24 fee;
        uint160 sqrtPriceX96;
        int24 tickLower;
        int24 tickUpper;
        uint256 amount0Min;
        uint256 amount1Min;
        uint256 deadline;
    }

    /// @notice Stores the flash loan contract used for initiating loans and validating callbacks.
    /// @param flashLoanContractAddress The deployed {ApprovalFlashLoan} contract address.
    /// @param uniswapV3PositionManagerAddress The deployed Uniswap V3 position manager address.
    constructor(address flashLoanContractAddress, address uniswapV3PositionManagerAddress) Ownable(msg.sender) {
        flashLoanContract = ApprovalFlashLoan(flashLoanContractAddress);
        uniswapV3PositionManager = IUniswapV3NonfungiblePositionManager(uniswapV3PositionManagerAddress);
    }

    /// @notice Receives the borrowed assets and performs the receiver-side flash loan logic.
    /// @dev This example restricts the caller to the configured flash loan contract, approves
    /// principal for pull repayment, and forwards each fee token to the configured fee recipient.
    /// When at least two distinct assets are received, it creates or initializes the Uniswap V3
    /// pool for the first two distinct assets, mints liquidity, withdraws it, then repays.
    /// @param lenders The lenders that must be repaid.
    /// @param assets The ERC20 token addresses received by this contract.
    /// @param amounts The amount of each asset borrowed.
    /// @param feeAssets The unique ERC20 fee token addresses.
    /// @param aggregatedFees The total fee owed for each fee token.
    /// @param feeAssetCount The number of valid entries in `feeAssets` and `aggregatedFees`.
    /// @param feeRecipient The address that must receive all flash loan fees.
    /// @param initiator The account that initiated the flash loan.
    /// @param params Arbitrary data forwarded from the flash loan request.
    /// @return True when execution succeeds and repayment has been prepared.
    function executeOperation(
        address[] calldata lenders,
        address[] calldata assets,
        uint256[] calldata amounts,
        address[] calldata feeAssets,
        uint256[] calldata aggregatedFees,
        uint256 feeAssetCount,
        address feeRecipient,
        address initiator,
        bytes calldata params
    ) external override returns (bool) {
        if (msg.sender != address(flashLoanContract)) revert CallerNotFlashLoanContract();
        if (initiator != address(this)) revert InvalidInitiator();

        _provideAndWithdrawUniswapV3Liquidity(assets, amounts, params);

        _repayFlashLoan(lenders, assets, amounts, feeAssets, aggregatedFees, feeAssetCount, feeRecipient);

        return true;
    }

    /// @notice Initiates a flash loan using this contract as the receiver.
    /// @param lenders The lenders that will provide the assets.
    /// @param assets The ERC20 token addresses to borrow.
    /// @param amounts The amount of each asset to borrow.
    /// @param params Arbitrary data forwarded to {executeOperation}.
    function initiateFlashLoan(
        address[] calldata lenders,
        address[] calldata assets,
        uint256[] calldata amounts,
        bytes calldata params
    ) external onlyOwner {
        flashLoanContract.flashLoan(address(this), lenders, assets, amounts, params);
    }

    /// @notice Initiates a best-effort flash loan using this contract as the receiver.
    /// @param lenders The lenders that will provide the assets.
    /// @param assets The ERC20 token addresses to borrow.
    /// @param amounts The amount of each asset to borrow.
    /// @param params Arbitrary data forwarded to {executeOperation}.
    function initiateFlashLoanBestEffort(
        address[] calldata lenders,
        address[] calldata assets,
        uint256[] calldata amounts,
        bytes calldata params
    ) external onlyOwner {
        flashLoanContract.flashLoanBestEffort(address(this), lenders, assets, amounts, params);
    }

    /// @notice Initiates a Permit2 flash loan using this contract as the receiver.
    /// @param lenders The lenders that will provide the assets.
    /// @param assets The ERC20 token addresses to borrow.
    /// @param amounts The amount of each asset to borrow.
    /// @param permits Per-lender Permit2 signature data.
    /// @param params Arbitrary data forwarded to {executeOperation}.
    function initiateFlashLoanWithPermit2(
        address[] calldata lenders,
        address[] calldata assets,
        uint256[] calldata amounts,
        IApprovalFlashLoan.Permit2SignatureData[] calldata permits,
        bytes calldata params
    ) external onlyOwner {
        flashLoanContract.flashLoanWithPermit2(address(this), lenders, assets, amounts, permits, params);
    }

    /// @notice Initiates a best-effort flash loan using direct allowances and Permit2.
    /// @param lenders The lenders that will provide the assets.
    /// @param assets The ERC20 token addresses to borrow.
    /// @param amounts The amount of each asset to borrow.
    /// @param permits Per-lender Permit2 signature data. Empty signatures use direct allowance.
    /// @param params Arbitrary data forwarded to {executeOperation}.
    function initiateFlashLoanBestEffortMix(
        address[] calldata lenders,
        address[] calldata assets,
        uint256[] calldata amounts,
        IApprovalFlashLoan.Permit2SignatureData[] calldata permits,
        bytes calldata params
    ) external onlyOwner {
        flashLoanContract.flashLoanBestEffortMix(address(this), lenders, assets, amounts, permits, params);
    }

    /// @notice Allows this receiver to hold Uniswap V3 position NFTs during callback execution.
    function onERC721Received(address, address, uint256, bytes calldata) external pure returns (bytes4) {
        return this.onERC721Received.selector;
    }

    /// @dev Creates or initializes the V3 pool for the first two distinct assets, mints liquidity,
    /// then removes the whole position and collects all owed tokens back to this receiver.
    function _provideAndWithdrawUniswapV3Liquidity(
        address[] calldata assets,
        uint256[] calldata amounts,
        bytes calldata params
    ) internal {
        (
            address token0,
            address token1,
            uint256 amount0Desired,
            uint256 amount1Desired,
            bool hasPair
        ) = _findFirstUniswapPair(assets, amounts);

        if (!hasPair) {
            return;
        }

        UniswapV3LiquidityParams memory liquidityParams = _decodeUniswapV3LiquidityParams(params);
        IUniswapV3NonfungiblePositionManager positionManager = uniswapV3PositionManager;

        positionManager.createAndInitializePoolIfNecessary(
            token0,
            token1,
            liquidityParams.fee,
            liquidityParams.sqrtPriceX96
        );

        IERC20(token0).forceApprove(address(positionManager), amount0Desired);
        IERC20(token1).forceApprove(address(positionManager), amount1Desired);

        (uint256 tokenId, uint128 liquidity,,) = positionManager.mint(
            IUniswapV3NonfungiblePositionManager.MintParams({
                token0: token0,
                token1: token1,
                fee: liquidityParams.fee,
                tickLower: liquidityParams.tickLower,
                tickUpper: liquidityParams.tickUpper,
                amount0Desired: amount0Desired,
                amount1Desired: amount1Desired,
                amount0Min: liquidityParams.amount0Min,
                amount1Min: liquidityParams.amount1Min,
                recipient: address(this),
                deadline: liquidityParams.deadline
            })
        );

        IERC20(token0).forceApprove(address(positionManager), 0);
        IERC20(token1).forceApprove(address(positionManager), 0);

        if (liquidity == 0) revert UniswapV3NoLiquidityMinted();

        positionManager.decreaseLiquidity(
            IUniswapV3NonfungiblePositionManager.DecreaseLiquidityParams({
                tokenId: tokenId,
                liquidity: liquidity,
                amount0Min: 0,
                amount1Min: 0,
                deadline: liquidityParams.deadline
            })
        );
        positionManager.collect(
            IUniswapV3NonfungiblePositionManager.CollectParams({
                tokenId: tokenId,
                recipient: address(this),
                amount0Max: type(uint128).max,
                amount1Max: type(uint128).max
            })
        );
        positionManager.burn(tokenId);
    }

    /// @dev Returns the first two distinct assets and aggregates duplicate rows for that pair.
    function _findFirstUniswapPair(
        address[] calldata assets,
        uint256[] calldata amounts
    ) internal pure returns (
        address token0,
        address token1,
        uint256 amount0Desired,
        uint256 amount1Desired,
        bool hasPair
    ) {
        address firstAsset;
        address secondAsset;
        uint256 firstAssetAmount;
        uint256 secondAssetAmount;

        for (uint256 i = 0; i < assets.length; i++) {
            address asset = assets[i];

            if (firstAsset == address(0)) {
                firstAsset = asset;
                firstAssetAmount = amounts[i];
            } else if (asset == firstAsset) {
                firstAssetAmount += amounts[i];
            } else if (secondAsset == address(0)) {
                secondAsset = asset;
                secondAssetAmount = amounts[i];
            } else if (asset == secondAsset) {
                secondAssetAmount += amounts[i];
            }
        }

        if (secondAsset == address(0)) {
            return (address(0), address(0), 0, 0, false);
        }

        if (uint160(firstAsset) < uint160(secondAsset)) {
            return (firstAsset, secondAsset, firstAssetAmount, secondAssetAmount, true);
        }
        return (secondAsset, firstAsset, secondAssetAmount, firstAssetAmount, true);
    }

    /// @dev Decodes optional V3 parameters and applies defaults for omitted values.
    function _decodeUniswapV3LiquidityParams(
        bytes calldata params
    ) internal view returns (UniswapV3LiquidityParams memory liquidityParams) {
        if (params.length != 0) {
            liquidityParams = abi.decode(params, (UniswapV3LiquidityParams));
        }

        if (liquidityParams.fee == 0) {
            liquidityParams.fee = DEFAULT_UNISWAP_V3_FEE;
        }
        if (liquidityParams.sqrtPriceX96 == 0) {
            liquidityParams.sqrtPriceX96 = DEFAULT_UNISWAP_V3_SQRT_PRICE_X96;
        }
        if (liquidityParams.tickLower == 0 && liquidityParams.tickUpper == 0) {
            liquidityParams.tickLower = DEFAULT_UNISWAP_V3_TICK_LOWER;
            liquidityParams.tickUpper = DEFAULT_UNISWAP_V3_TICK_UPPER;
        }
        if (liquidityParams.deadline == 0) {
            liquidityParams.deadline = block.timestamp;
        }
    }

    /// @dev Approves lender principal for pull repayment and forwards fees to the fee recipient.
    function _repayFlashLoan(
        address[] calldata lenders,
        address[] calldata assets,
        uint256[] calldata amounts,
        address[] calldata feeAssets,
        uint256[] calldata aggregatedFees,
        uint256 feeAssetCount,
        address feeRecipient
    ) internal {
        for (uint256 i = 0; i < lenders.length; i++) {
            IERC20(assets[i]).safeIncreaseAllowance(address(flashLoanContract), amounts[i]);
        }

        for (uint256 i = 0; i < feeAssetCount; i++) {
            IERC20(feeAssets[i]).safeTransfer(feeRecipient, aggregatedFees[i]);
        }
    }
}
