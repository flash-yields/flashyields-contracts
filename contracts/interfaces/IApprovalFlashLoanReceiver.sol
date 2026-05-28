// SPDX-License-Identifier: MIT
pragma solidity ^0.8.27;

/// @title IApprovalFlashLoanReceiver
/// @notice Interface for contracts that receive approval-based flash loans.
interface IApprovalFlashLoanReceiver {
    /// @notice Receives borrowed assets and returns whether the operation succeeded.
    /// @dev The receiver must approve `msg.sender` to pull borrowed principal before returning.
    /// Fees must be paid directly to `feeRecipient`.
    /// @param lenders The lenders that must be repaid.
    /// @param assets The ERC20 token addresses received by the borrower.
    /// @param amounts The amount of each asset borrowed.
    /// @param feeAssets The unique ERC20 fee token addresses.
    /// @param aggregatedFees The total fee owed for each fee token.
    /// @param feeAssetCount The number of valid entries in `feeAssets` and `aggregatedFees`.
    /// @param feeRecipient The address that must receive all flash loan fees.
    /// @param initiator The account that initiated the flash loan.
    /// @param params Arbitrary data forwarded from the flash loan request.
    /// @return True when execution succeeds.
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
    ) external returns (bool);
}
