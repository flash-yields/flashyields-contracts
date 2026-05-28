// SPDX-License-Identifier: MIT
pragma solidity ^0.8.27;

import { IERC20 } from "./dependencies/openzeppelin-v5.0.1/token/ERC20/IERC20.sol";
import { SafeERC20 } from "./dependencies/openzeppelin-v5.0.1/token/ERC20/utils/SafeERC20.sol";
import { ReentrancyGuard } from "./dependencies/openzeppelin-v5.0.1/utils/ReentrancyGuard.sol";
import { Pausable } from "./dependencies/openzeppelin-v5.0.1/utils/Pausable.sol";
import { IApprovalFlashLoanReceiver } from "./interfaces/IApprovalFlashLoanReceiver.sol";
import { IACLManager } from "./interfaces/IACLManager.sol";
import { IApprovalFlashLoan } from "./interfaces/IApprovalFlashLoan.sol";
import { IFeeVerifier } from "./interfaces/IFeeVerifier.sol";
import { IAllowanceTransfer } from "./interfaces/IAllowanceTransfer.sol";

/// @title ApprovalFlashLoan
/// @notice Executes flash loans funded by third-party lenders that pre-approve this contract.
/// @dev Each lender must approve this contract for the requested amount. After the callback, this
/// contract pulls lender principal back from the receiver, while fee payment to the configured fee
/// recipient must be completed before the loan finishes.
contract ApprovalFlashLoan is ReentrancyGuard, Pausable, IApprovalFlashLoan {
    using SafeERC20 for IERC20;

    IACLManager public immutable aclManager;

    /// @notice Contract used to verify that flash loan fees were paid to the fee recipient.
    IFeeVerifier public feeVerifier;

    /// @notice Canonical Permit2 contract used for allowance-based transfers.
    IAllowanceTransfer public immutable PERMIT2;

    /// @notice Tracks tokens that cannot be borrowed through this contract.
    mapping(address => bool) public blacklistedTokens;

    modifier onlyAdminRole() {
        aclManager.checkAdminRole(msg.sender);
        _;
    }

    modifier onlyTimelockRole() {
        aclManager.checkTimelockRole(msg.sender);
        _;
    }

    modifier onlyPauserRole() {
        aclManager.checkPauserRole(msg.sender);
        _;
    }

    /// @notice Sets the fee verifier, ACL manager, and Permit2 contract.
    /// @param aclManager_ The ACL manager contract for role-based access control.
    /// @param feeVerifier_ The contract used to snapshot and verify flash loan fee payments.
    /// @param permit2_ The canonical Permit2 contract for allowance-based transfers.
    constructor(IACLManager aclManager_, IFeeVerifier feeVerifier_, IAllowanceTransfer permit2_) {
        if (address(aclManager_) == address(0)) revert InvalidZeroAddress();
        if (address(feeVerifier_) == address(0)) revert InvalidZeroAddress();
        if (address(permit2_) == address(0)) revert InvalidZeroAddress();

        aclManager = aclManager_;
        feeVerifier = feeVerifier_;
        PERMIT2 = permit2_;
    }

    function pause() external onlyPauserRole {
        _pause();
    }

    function unpause() external onlyAdminRole {
        _unpause();
    }

    /// @notice Updates the fee verifier contract.
    /// @param newFeeVerifier The new fee verifier contract.
    function setFeeVerifier(IFeeVerifier newFeeVerifier) external onlyTimelockRole {
        if (address(newFeeVerifier) == address(0)) revert InvalidZeroAddress();
        feeVerifier = newFeeVerifier;
        emit FeeVerifierChanged(address(newFeeVerifier));
    }

    /// @notice Updates blacklist status for multiple borrowed tokens.
    /// @param tokens The token addresses to update.
    /// @param isBlacklisted Whether each token should be blacklisted.
    function setTokenBlacklist(address[] calldata tokens, bool[] calldata isBlacklisted) external onlyAdminRole {
        if (tokens.length != isBlacklisted.length) revert ArrayLengthMismatch();

        for (uint256 i = 0; i < tokens.length; i++) {
            address token = tokens[i];
            if (token == address(0)) revert InvalidZeroAddress();

            blacklistedTokens[token] = isBlacklisted[i];

            emit TokenBlacklistUpdated(token, isBlacklisted[i]);
        }
    }

    /// @notice Executes a flash loan and calls the receiver with the borrowed assets.
    /// @dev Reverts unless the receiver returns `true`, approves this contract to pull principal,
    /// each lender's balance is restored to its pre-loan level, and the configured fee recipient
    /// receives all loan fees.
    /// @param receiverAddress The contract that receives the assets and implements the callback.
    /// @param lenders The lenders that provide the requested assets.
    /// @param assets The ERC20 token addresses to borrow.
    /// @param amounts The amount of each asset to borrow.
    /// @param params Arbitrary data forwarded to the receiver callback.
    function flashLoan(
        address receiverAddress,
        address[] calldata lenders,
        address[] calldata assets,
        uint256[] calldata amounts,
        bytes calldata params
    ) external nonReentrant whenNotPaused {
        if (lenders.length == 0) revert EmptyArrays();
        if (assets.length != lenders.length || amounts.length != lenders.length) revert ArrayLengthMismatch();

        FlashLoanAccounting memory accounting = _validateAndSnapshot(lenders, assets, amounts);

        _transferLoanedAssets(receiverAddress, lenders, assets, amounts);

        if (!IApprovalFlashLoanReceiver(receiverAddress).executeOperation(
            lenders,
            assets,
            amounts,
            accounting.feeAssets,
            accounting.aggregatedFees,
            accounting.feeAssetCount,
            feeVerifier.feeRecipient(),
            msg.sender,
            params
        )) revert ReceiverExecutionFailed();

        _pullPrincipalRepayment(receiverAddress, lenders, assets, amounts);
        _verifyRepayment(lenders, assets, accounting);

        emit FlashLoan(
            receiverAddress,
            msg.sender,
            lenders,
            assets,
            amounts,
            accounting.feeAssets,
            accounting.aggregatedFees
        );
    }

    /// @notice Executes a flash loan using Permit2 AllowanceTransfer to pull funds from lenders.
    /// @dev Each lender must have approved the canonical Permit2 contract for the borrowed token.
    /// The flash loan initiator provides per-lender signatures that set an on-chain allowance in
    /// Permit2, which this contract then uses to pull the specified amounts.
    /// @param receiverAddress The contract that receives the assets and implements the callback.
    /// @param lenders The lenders that provide the requested assets.
    /// @param assets The ERC20 token addresses to borrow.
    /// @param amounts The amount of each asset to borrow.
    /// @param permits Per-lender Permit2 signature data (nonce, deadline, signature).
    /// @param params Arbitrary data forwarded to the receiver callback.
    function flashLoanWithPermit2(
        address receiverAddress,
        address[] calldata lenders,
        address[] calldata assets,
        uint256[] calldata amounts,
        Permit2SignatureData[] calldata permits,
        bytes calldata params
    ) external nonReentrant whenNotPaused {
        if (lenders.length == 0) revert EmptyArrays();
        if (
            assets.length != lenders.length ||
            amounts.length != lenders.length ||
            permits.length != lenders.length
        ) revert ArrayLengthMismatch();

        FlashLoanAccounting memory accounting = _validateAndSnapshotForPermit2(lenders, assets, amounts);

        _transferLoanedAssetsWithPermit2(receiverAddress, lenders, assets, amounts, permits);

        if (!IApprovalFlashLoanReceiver(receiverAddress).executeOperation(
            lenders,
            assets,
            amounts,
            accounting.feeAssets,
            accounting.aggregatedFees,
            accounting.feeAssetCount,
            feeVerifier.feeRecipient(),
            msg.sender,
            params
        )) revert ReceiverExecutionFailed();

        _pullPrincipalRepayment(receiverAddress, lenders, assets, amounts);
        _verifyRepayment(lenders, assets, accounting);

        emit FlashLoan(
            receiverAddress,
            msg.sender,
            lenders,
            assets,
            amounts,
            accounting.feeAssets,
            accounting.aggregatedFees
        );
    }

    /// @notice Executes a best-effort flash loan that skips lenders with insufficient allowance or balance.
    /// @dev Silently omits any lender whose allowance for this contract or live token balance is less
    /// than the requested amount. Reverts only when no lenders remain after filtering, the receiver
    /// returns `false`, or repayment is not completed.
    /// @param receiverAddress The contract that receives the assets and implements the callback.
    /// @param lenders The lenders that provide the requested assets.
    /// @param assets The ERC20 token addresses to borrow.
    /// @param amounts The amount of each asset to borrow.
    /// @param params Arbitrary data forwarded to the receiver callback.
    function flashLoanBestEffort(
        address receiverAddress,
        address[] calldata lenders,
        address[] calldata assets,
        uint256[] calldata amounts,
        bytes calldata params
    ) external nonReentrant whenNotPaused {
        if (lenders.length == 0) revert EmptyArrays();
        if (assets.length != lenders.length || amounts.length != lenders.length) revert ArrayLengthMismatch();

        BestEffortResult memory result = _filterValidateAndSnapshot(lenders, assets, amounts);

        if (result.lenders.length == 0) revert NoValidLenders();

        _transferLoanedAssetsFromMemory(receiverAddress, result.lenders, result.assets, result.amounts);

        if (!IApprovalFlashLoanReceiver(receiverAddress).executeOperation(
            result.lenders,
            result.assets,
            result.amounts,
            result.accounting.feeAssets,
            result.accounting.aggregatedFees,
            result.accounting.feeAssetCount,
            feeVerifier.feeRecipient(),
            msg.sender,
            params
        )) revert ReceiverExecutionFailed();

        _pullPrincipalRepayment(receiverAddress, result.lenders, result.assets, result.amounts);
        _verifyRepayment(result.lenders, result.assets, result.accounting);

        emit FlashLoan(
            receiverAddress,
            msg.sender,
            result.lenders,
            result.assets,
            result.amounts,
            result.accounting.feeAssets,
            result.accounting.aggregatedFees
        );
    }

    /// @notice Executes a best-effort flash loan using regular allowance and Permit2 AllowanceTransfer.
    /// @dev Silently omits any lender whose Permit2 signature is invalid, whose Permit2/underlying
    /// allowance or live token balance is less than the requested amount, or whose direct allowance
    /// or balance is insufficient when an empty signature is provided. Reverts only when no lenders
    /// remain after filtering, the receiver returns `false`, or repayment is not completed.
    /// @param receiverAddress The contract that receives the assets and implements the callback.
    /// @param lenders The lenders that provide the requested assets.
    /// @param assets The ERC20 token addresses to borrow.
    /// @param amounts The amount of each asset to borrow.
    /// @param permits Per-lender Permit2 signature data (nonce, deadline, signature). Empty
    /// signatures use the normal best-effort direct allowance flow for that entry.
    /// @param params Arbitrary data forwarded to the receiver callback.
    function flashLoanBestEffortMix(
        address receiverAddress,
        address[] calldata lenders,
        address[] calldata assets,
        uint256[] calldata amounts,
        Permit2SignatureData[] calldata permits,
        bytes calldata params
    ) external nonReentrant whenNotPaused {
        if (lenders.length == 0) revert EmptyArrays();
        if (
            assets.length != lenders.length ||
            amounts.length != lenders.length ||
            permits.length != lenders.length
        ) revert ArrayLengthMismatch();

        (BestEffortResult memory result, bool[] memory usePermit2) =
            _filterValidateAndSnapshotMix(lenders, assets, amounts, permits);

        if (result.lenders.length == 0) revert NoValidLenders();

        _transferLoanedAssetsFromMemoryMix(
            receiverAddress,
            result.lenders,
            result.assets,
            result.amounts,
            usePermit2
        );

        if (!IApprovalFlashLoanReceiver(receiverAddress).executeOperation(
            result.lenders,
            result.assets,
            result.amounts,
            result.accounting.feeAssets,
            result.accounting.aggregatedFees,
            result.accounting.feeAssetCount,
            feeVerifier.feeRecipient(),
            msg.sender,
            params
        )) revert ReceiverExecutionFailed();

        _pullPrincipalRepayment(receiverAddress, result.lenders, result.assets, result.amounts);
        _verifyRepayment(result.lenders, result.assets, result.accounting);

        emit FlashLoan(
            receiverAddress,
            msg.sender,
            result.lenders,
            result.assets,
            result.amounts,
            result.accounting.feeAssets,
            result.accounting.aggregatedFees
        );
    }

    /// @dev Validates loan inputs and snapshots balances for repayment checks.
    function _validateAndSnapshot(
        address[] calldata lenders,
        address[] calldata assets,
        uint256[] calldata amounts
    ) internal view returns (FlashLoanAccounting memory accounting) {
        accounting.lenderBalancesBefore = new uint256[](lenders.length);

        for (uint256 i = 0; i < lenders.length; i++) {
            if (amounts[i] == 0) revert AmountMustBePositive();
            if (blacklistedTokens[assets[i]]) revert TokenBlacklisted(assets[i]);

            IERC20 asset = IERC20(assets[i]);
            accounting.lenderBalancesBefore[i] = asset.balanceOf(lenders[i]);
        }

        (
            accounting.feeAssets,
            accounting.feeRecipientBalancesBefore,
            accounting.aggregatedFees,
            accounting.feeAssetCount
        ) = feeVerifier.snapshotFees(assets, amounts);
    }

    /// @dev Snapshots lender balances and computes fees for Permit2-based flash loans.
    /// Does not check ERC20 allowance since Permit2 uses signature-based authorization.
    function _validateAndSnapshotForPermit2(
        address[] calldata lenders,
        address[] calldata assets,
        uint256[] calldata amounts
    ) internal view returns (FlashLoanAccounting memory accounting) {
        accounting.lenderBalancesBefore = new uint256[](lenders.length);

        for (uint256 i = 0; i < lenders.length; i++) {
            if (amounts[i] == 0) revert AmountMustBePositive();
            if (blacklistedTokens[assets[i]]) revert TokenBlacklisted(assets[i]);
            if (amounts[i] > type(uint160).max) revert AmountExceedsPermit2Max();

            accounting.lenderBalancesBefore[i] = IERC20(assets[i]).balanceOf(lenders[i]);
        }

        (
            accounting.feeAssets,
            accounting.feeRecipientBalancesBefore,
            accounting.aggregatedFees,
            accounting.feeAssetCount
        ) = feeVerifier.snapshotFees(assets, amounts);
    }

    /// @dev Filters out lenders with insufficient allowance or balance, validates remaining inputs,
    /// and snapshots balances for repayment verification.
    function _filterValidateAndSnapshot(
        address[] calldata lenders,
        address[] calldata assets,
        uint256[] calldata amounts
    ) internal view returns (BestEffortResult memory result) {
        address[] memory validLenders = new address[](lenders.length);
        address[] memory validAssets = new address[](lenders.length);
        uint256[] memory validAmounts = new uint256[](lenders.length);
        uint256[] memory lenderBalancesBefore = new uint256[](lenders.length);
        uint256 validCount = 0;

        for (uint256 i = 0; i < lenders.length; i++) {
            if (amounts[i] == 0) revert AmountMustBePositive();
            if (blacklistedTokens[assets[i]]) {
                continue;
            }

            IERC20 asset = IERC20(assets[i]);
            if (asset.allowance(lenders[i], address(this)) < amounts[i]) {
                continue;
            }

            uint256 lenderBalance = asset.balanceOf(lenders[i]);
            if (lenderBalance < amounts[i]) {
                continue;
            }

            validLenders[validCount] = lenders[i];
            validAssets[validCount] = assets[i];
            validAmounts[validCount] = amounts[i];
            lenderBalancesBefore[validCount] = lenderBalance;
            validCount++;
        }

        if (validCount == lenders.length) {
            result.lenders = validLenders;
            result.assets = validAssets;
            result.amounts = validAmounts;
            result.accounting.lenderBalancesBefore = lenderBalancesBefore;
        } else {
            result.lenders = new address[](validCount);
            result.assets = new address[](validCount);
            result.amounts = new uint256[](validCount);
            result.accounting.lenderBalancesBefore = new uint256[](validCount);

            for (uint256 i = 0; i < validCount; i++) {
                result.lenders[i] = validLenders[i];
                result.assets[i] = validAssets[i];
                result.amounts[i] = validAmounts[i];
                result.accounting.lenderBalancesBefore[i] = lenderBalancesBefore[i];
            }
        }

        (
            result.accounting.feeAssets,
            result.accounting.feeRecipientBalancesBefore,
            result.accounting.aggregatedFees,
            result.accounting.feeAssetCount
        ) = feeVerifier.snapshotFees(result.assets, result.amounts);
    }

    /// @dev Filters out lenders without usable Permit2 authorization or direct allowance,
    /// validates remaining inputs, and snapshots balances for repayment verification.
    /// Empty Permit2 signatures are treated as normal direct-allowance best-effort entries.
    function _filterValidateAndSnapshotMix(
        address[] calldata lenders,
        address[] calldata assets,
        uint256[] calldata amounts,
        Permit2SignatureData[] calldata permits
    ) internal returns (BestEffortResult memory result, bool[] memory usePermit2) {
        address[] memory validLenders = new address[](lenders.length);
        address[] memory validAssets = new address[](lenders.length);
        uint256[] memory validAmounts = new uint256[](lenders.length);
        uint256[] memory lenderBalancesBefore = new uint256[](lenders.length);
        bool[] memory validUsePermit2 = new bool[](lenders.length);
        uint256 validCount = 0;

        for (uint256 i = 0; i < lenders.length; i++) {
            if (amounts[i] == 0) revert AmountMustBePositive();
            if (blacklistedTokens[assets[i]]) {
                continue;
            }

            IERC20 asset = IERC20(assets[i]);
            uint256 lenderBalance = asset.balanceOf(lenders[i]);
            if (lenderBalance < amounts[i]) {
                continue;
            }

            bool usePermit2ForThis;

            if (permits[i].signature.length == 0) {
                if (asset.allowance(lenders[i], address(this)) < amounts[i]) {
                    continue;
                }
            } else {
                if (asset.allowance(lenders[i], address(PERMIT2)) < amounts[i]) {
                    continue;
                }

                if (!_trySetPermit2Allowance(lenders[i], assets[i], amounts[i], permits[i])) {
                    continue;
                }

                usePermit2ForThis = true;
            }

            validLenders[validCount] = lenders[i];
            validAssets[validCount] = assets[i];
            validAmounts[validCount] = amounts[i];
            lenderBalancesBefore[validCount] = lenderBalance;
            validUsePermit2[validCount] = usePermit2ForThis;
            validCount++;
        }

        if (validCount == lenders.length) {
            result.lenders = validLenders;
            result.assets = validAssets;
            result.amounts = validAmounts;
            result.accounting.lenderBalancesBefore = lenderBalancesBefore;
            usePermit2 = validUsePermit2;
        } else {
            result.lenders = new address[](validCount);
            result.assets = new address[](validCount);
            result.amounts = new uint256[](validCount);
            result.accounting.lenderBalancesBefore = new uint256[](validCount);
            usePermit2 = new bool[](validCount);

            for (uint256 i = 0; i < validCount; i++) {
                result.lenders[i] = validLenders[i];
                result.assets[i] = validAssets[i];
                result.amounts[i] = validAmounts[i];
                result.accounting.lenderBalancesBefore[i] = lenderBalancesBefore[i];
                usePermit2[i] = validUsePermit2[i];
            }
        }

        (
            result.accounting.feeAssets,
            result.accounting.feeRecipientBalancesBefore,
            result.accounting.aggregatedFees,
            result.accounting.feeAssetCount
        ) = feeVerifier.snapshotFees(result.assets, result.amounts);
    }

    /// @dev Returns true when this contract has enough live Permit2 allowance, applying a
    /// provided Permit2 signature when needed.
    function _trySetPermit2Allowance(
        address lender,
        address asset,
        uint256 amount,
        Permit2SignatureData calldata permit
    ) internal returns (bool) {
        if (amount > type(uint160).max) {
            return false;
        }

        (uint160 currentAmount, uint48 currentExpiration,) =
            PERMIT2.allowance(lender, asset, address(this));

        if (currentAmount >= amount && currentExpiration >= block.timestamp) {
            return true;
        }

        if (
            permit.amount < amount ||
            permit.expiration < block.timestamp ||
            permit.sigDeadline < block.timestamp
        ) {
            return false;
        }

        try PERMIT2.permit(
            lender,
            IAllowanceTransfer.PermitSingle({
                details: IAllowanceTransfer.PermitDetails({
                    token: asset,
                    amount: permit.amount,
                    expiration: permit.expiration,
                    nonce: permit.nonce
                }),
                spender: address(this),
                sigDeadline: permit.sigDeadline
            }),
            permit.signature
        ) {
            return true;
        } catch {
            return false;
        }
    }

    /// @dev Transfers the requested assets from each lender to the receiver.
    function _transferLoanedAssets(
        address receiverAddress,
        address[] calldata lenders,
        address[] calldata assets,
        uint256[] calldata amounts
    ) internal {
        for (uint256 i = 0; i < lenders.length; i++) {
            IERC20(assets[i]).safeTransferFrom(lenders[i], receiverAddress, amounts[i]);
        }
    }

    /// @dev Transfers the requested assets from each lender to the receiver (memory array variant).
    function _transferLoanedAssetsFromMemory(
        address receiverAddress,
        address[] memory lenders,
        address[] memory assets,
        uint256[] memory amounts
    ) internal {
        for (uint256 i = 0; i < lenders.length; i++) {
            IERC20(assets[i]).safeTransferFrom(lenders[i], receiverAddress, amounts[i]);
        }
    }

    /// @dev Transfers the requested assets from each lender using direct allowance or prepared Permit2 allowance.
    function _transferLoanedAssetsFromMemoryMix(
        address receiverAddress,
        address[] memory lenders,
        address[] memory assets,
        uint256[] memory amounts,
        bool[] memory usePermit2
    ) internal {
        for (uint256 i = 0; i < lenders.length; i++) {
            if (usePermit2[i]) {
                PERMIT2.transferFrom(
                    lenders[i],
                    receiverAddress,
                    uint160(amounts[i]),
                    assets[i]
                );
            } else {
                IERC20(assets[i]).safeTransferFrom(lenders[i], receiverAddress, amounts[i]);
            }
        }
    }

    /// @dev Transfers the requested assets from each lender to the receiver via Permit2 AllowanceTransfer.
    /// First sets an on-chain allowance in Permit2 using the lender's signature, then pulls
    /// funds directly to the receiver using that allowance.
    function _transferLoanedAssetsWithPermit2(
        address receiverAddress,
        address[] calldata lenders,
        address[] calldata assets,
        uint256[] calldata amounts,
        Permit2SignatureData[] calldata permits
    ) internal {
        for (uint256 i = 0; i < lenders.length; i++) {
            (uint160 currentAmount, uint48 currentExpiration,) =
                PERMIT2.allowance(lenders[i], assets[i], address(this));

            if (currentAmount < amounts[i] || currentExpiration < block.timestamp) {
                PERMIT2.permit(
                    lenders[i],
                    IAllowanceTransfer.PermitSingle({
                        details: IAllowanceTransfer.PermitDetails({
                            token: assets[i],
                            amount: permits[i].amount,
                            expiration: permits[i].expiration,
                            nonce: permits[i].nonce
                        }),
                        spender: address(this),
                        sigDeadline: permits[i].sigDeadline
                    }),
                    permits[i].signature
                );
            }

            PERMIT2.transferFrom(
                lenders[i],
                receiverAddress,
                uint160(amounts[i]),
                assets[i]
            );
        }
    }

    /// @dev Pulls lender principal back from the receiver through plain ERC20 transfers.
    function _pullPrincipalRepayment(
        address receiverAddress,
        address[] memory lenders,
        address[] memory assets,
        uint256[] memory amounts
    ) internal {
        for (uint256 i = 0; i < lenders.length; i++) {
            IERC20(assets[i]).safeTransferFrom(receiverAddress, lenders[i], amounts[i]);
        }
    }

    /// @dev Verifies that each lender recovered its pre-loan balance and delegates fee
    /// verification to the fee verifier contract.
    function _verifyRepayment(
        address[] memory lenders,
        address[] memory assets,
        FlashLoanAccounting memory accounting
    ) internal view {
        for (uint256 i = 0; i < lenders.length; i++) {
            if (IERC20(assets[i]).balanceOf(lenders[i]) < accounting.lenderBalancesBefore[i]) {
                revert FlashLoanNotRepaid();
            }
        }

        if (!feeVerifier.verifyFees(
            accounting.feeAssets,
            accounting.feeRecipientBalancesBefore,
            accounting.aggregatedFees,
            accounting.feeAssetCount
        )) {
            revert FlashLoanNotRepaid();
        }
    }

}
