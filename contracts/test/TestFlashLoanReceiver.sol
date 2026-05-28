// SPDX-License-Identifier: MIT
pragma solidity ^0.8.27;

import { IERC20 } from "../dependencies/openzeppelin-v5.0.1/token/ERC20/IERC20.sol";
import { SafeERC20 } from "../dependencies/openzeppelin-v5.0.1/token/ERC20/utils/SafeERC20.sol";
import { IApprovalFlashLoan } from "../interfaces/IApprovalFlashLoan.sol";
import { IApprovalFlashLoanReceiver } from "../interfaces/IApprovalFlashLoanReceiver.sol";

/// @title TestFlashLoanReceiver
/// @notice Configurable receiver used to exercise flash-loan success and failure paths.
contract TestFlashLoanReceiver is IApprovalFlashLoanReceiver {
    using SafeERC20 for IERC20;

    IApprovalFlashLoan public immutable flashLoan;

    bool public returnFalse;
    bool public skipPrincipalRepayment;
    bool public skipFeePayment;
    bool public attemptReenter;
    uint256 public principalUnderpay;
    uint256 public feeUnderpay;

    uint256 public calls;
    uint256 public lastLenderCount;
    uint256 public lastFeeAssetCount;
    address public lastInitiator;
    address public lastFeeRecipient;
    bytes32 public lastParamsHash;

    constructor(IApprovalFlashLoan flashLoan_) {
        flashLoan = flashLoan_;
    }

    function configure(
        bool returnFalse_,
        bool skipPrincipalRepayment_,
        bool skipFeePayment_,
        bool attemptReenter_,
        uint256 principalUnderpay_,
        uint256 feeUnderpay_
    ) external {
        returnFalse = returnFalse_;
        skipPrincipalRepayment = skipPrincipalRepayment_;
        skipFeePayment = skipFeePayment_;
        attemptReenter = attemptReenter_;
        principalUnderpay = principalUnderpay_;
        feeUnderpay = feeUnderpay_;
    }

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
    ) external returns (bool) {
        calls++;
        lastLenderCount = lenders.length;
        lastFeeAssetCount = feeAssetCount;
        lastInitiator = initiator;
        lastFeeRecipient = feeRecipient;
        lastParamsHash = keccak256(params);

        if (attemptReenter) {
            flashLoan.flashLoan(address(this), lenders, assets, amounts, params);
        }

        if (!skipPrincipalRepayment) {
            for (uint256 i = 0; i < lenders.length; i++) {
                uint256 repayment = amounts[i];
                if (i == 0 && principalUnderpay != 0) {
                    repayment -= principalUnderpay;
                }
                IERC20(assets[i]).safeIncreaseAllowance(address(flashLoan), repayment);
            }
        }

        if (!skipFeePayment) {
            for (uint256 i = 0; i < feeAssetCount; i++) {
                uint256 feePayment = aggregatedFees[i];
                if (i == 0 && feeUnderpay != 0) {
                    feePayment -= feeUnderpay;
                }
                IERC20(feeAssets[i]).safeTransfer(feeRecipient, feePayment);
            }
        }

        return !returnFalse;
    }
}
