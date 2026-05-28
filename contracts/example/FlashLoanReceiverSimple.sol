// SPDX-License-Identifier: MIT
pragma solidity ^0.8.27;

import { IERC20 } from "../dependencies/openzeppelin-v5.0.1/token/ERC20/IERC20.sol";
import { SafeERC20 } from "../dependencies/openzeppelin-v5.0.1/token/ERC20/utils/SafeERC20.sol";
import { Ownable } from "../dependencies/openzeppelin-v5.0.1/access/Ownable.sol";
import { ApprovalFlashLoan } from "../ApprovalFlashLoan.sol";
import { IApprovalFlashLoan } from "../interfaces/IApprovalFlashLoan.sol";
import { IApprovalFlashLoanReceiver } from "../interfaces/IApprovalFlashLoanReceiver.sol";
import { ILenderRegistry } from "../interfaces/ILenderRegistry.sol";

/// @title FlashLoanReceiverSimple
/// @notice Example receiver implementation for flash loans issued by {ApprovalFlashLoan}.
contract FlashLoanReceiverSimple is Ownable, IApprovalFlashLoanReceiver {
    using SafeERC20 for IERC20;

    /// @notice Thrown when a caller other than the configured flash loan contract invokes the callback.
    error CallerNotFlashLoanContract();

    /// @notice Thrown when the flash loan was not initiated by this receiver contract.
    error InvalidInitiator();

    /// @notice The flash loan contract that is allowed to invoke {executeOperation}.
    ApprovalFlashLoan public immutable flashLoanContract;

    /// @notice Stores the flash loan contract used for initiating loans and validating callbacks.
    /// @param flashLoanContractAddress The deployed {ApprovalFlashLoan} contract address.
    constructor(address flashLoanContractAddress) Ownable(msg.sender) {
        flashLoanContract = ApprovalFlashLoan(flashLoanContractAddress);
    }

    /// @notice Receives the borrowed assets and performs the receiver-side flash loan logic.
    /// @dev This example restricts the caller to the configured flash loan contract, approves
    /// principal for pull repayment, and forwards each fee token to the configured fee recipient.
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
        params;
        if (msg.sender != address(flashLoanContract)) revert CallerNotFlashLoanContract();
        if (initiator != address(this)) revert InvalidInitiator();

        // --- Your arbitrage / liquidation / collateral swap logic here ---
        // This contract now holds amounts[i] of each assets[i].
        // ...

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

    /// @notice Initiates a direct flash loan using all positive availability reported by a lender registry.
    /// @param lenderRegistry The registry used to discover lenders, assets, and available amounts.
    /// @param params Arbitrary data forwarded to {executeOperation}.
    function initiateFlashLoanFromRegistry(
        ILenderRegistry lenderRegistry,
        bytes calldata params
    ) external onlyOwner {
        ILenderRegistry.TokenLenderAvailability[] memory availability =
            lenderRegistry.getAllPotentialLendersAvailability();
        uint256 lenderCount;

        for (uint256 i = 0; i < availability.length; i++) {
            for (uint256 j = 0; j < availability[i].lenders.length; j++) {
                if (availability[i].availableAmounts[j] > 0) lenderCount++;
            }
        }

        address[] memory lenders = new address[](lenderCount);
        address[] memory assets = new address[](lenderCount);
        uint256[] memory amounts = new uint256[](lenderCount);
        uint256 loanIndex;

        for (uint256 i = 0; i < availability.length; i++) {
            for (uint256 j = 0; j < availability[i].lenders.length; j++) {
                uint256 availableAmount = availability[i].availableAmounts[j];
                if (availableAmount == 0) continue;

                lenders[loanIndex] = availability[i].lenders[j];
                assets[loanIndex] = availability[i].token;
                amounts[loanIndex] = availableAmount;
                loanIndex++;
            }
        }

        flashLoanContract.flashLoan(address(this), lenders, assets, amounts, params);
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
