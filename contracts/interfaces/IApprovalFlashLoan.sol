// SPDX-License-Identifier: MIT
pragma solidity ^0.8.27;

import { IACLManager } from "./IACLManager.sol";
import { IFeeVerifier } from "./IFeeVerifier.sol";
import { IAllowanceTransfer } from "./IAllowanceTransfer.sol";

/// @title IApprovalFlashLoan
/// @notice Interface for the ApprovalFlashLoan contract.
interface IApprovalFlashLoan {
    /// @notice Thrown when no lenders are provided for a flash loan request.
    error EmptyArrays();
    /// @notice Thrown when lenders, assets, and amounts do not have matching lengths.
    error ArrayLengthMismatch();
    /// @notice Thrown when a requested flash loan amount is zero.
    error AmountMustBePositive();
    /// @notice Thrown when a zero address is provided where a valid address is required.
    error InvalidZeroAddress();
    /// @notice Thrown when a lender has not approved enough tokens for the requested loan amount.
    error InsufficientAllowanceFromLender();
    /// @notice Thrown when the receiver callback returns `false`.
    error ReceiverExecutionFailed();
    /// @notice Thrown when lender principal is not restored or the fee recipient is underpaid.
    error FlashLoanNotRepaid();
    /// @notice Thrown when all lenders are skipped due to insufficient allowance in a best-effort flash loan.
    error NoValidLenders();
    /// @notice Thrown when a requested amount exceeds the Permit2 uint160 maximum.
    error AmountExceedsPermit2Max();
    /// @notice Thrown when a borrowed token is blacklisted.
    error TokenBlacklisted(address token);

    /// @notice Emitted after a flash loan is executed and all lenders are repaid.
    /// @param receiver The contract that received the borrowed assets and executed the callback.
    /// @param initiator The account that initiated the flash loan.
    /// @param lenders The lenders that supplied the borrowed assets.
    /// @param assets The ERC20 tokens borrowed from each lender.
    /// @param amounts The principal amount borrowed for each asset.
    /// @param feeAssets The unique ERC20 fee token addresses.
    /// @param aggregatedFees The total fee owed for each fee token.
    event FlashLoan(
        address indexed receiver,
        address indexed initiator,
        address[] lenders,
        address[] assets,
        uint256[] amounts,
        address[] feeAssets,
        uint256[] aggregatedFees
    );
    /// @notice Emitted when the fee verifier contract is updated.
    /// @param newFeeVerifier The new fee verifier contract address.
    event FeeVerifierChanged(address indexed newFeeVerifier);
    /// @notice Emitted when a token blacklist status is updated.
    /// @param token The token whose blacklist status was updated.
    /// @param isBlacklisted Whether the token is blacklisted.
    event TokenBlacklistUpdated(address indexed token, bool isBlacklisted);

    /// @dev Bundles filtered arrays and accounting for best-effort flash loans.
    struct BestEffortResult {
        address[] lenders;
        address[] assets;
        uint256[] amounts;
        FlashLoanAccounting accounting;
    }

    /// @dev Per-lender Permit2 signature data for AllowanceTransfer.
    /// Empty signatures are treated as direct-allowance entries by `flashLoanBestEffortMix`.
    struct Permit2SignatureData {
        uint160 amount;
        uint48 expiration;
        uint48 nonce;
        uint256 sigDeadline;
        bytes signature;
    }

    /// @dev Tracks pre-loan balances and aggregate fees for repayment verification.
    struct FlashLoanAccounting {
        uint256[] lenderBalancesBefore;
        address[] feeAssets;
        uint256[] aggregatedFees;
        uint256[] feeRecipientBalancesBefore;
        uint256 feeAssetCount;
    }

    function pause() external;

    function unpause() external;

    function setFeeVerifier(IFeeVerifier newFeeVerifier) external;

    function setTokenBlacklist(address[] calldata tokens, bool[] calldata isBlacklisted) external;

    function flashLoan(
        address receiverAddress,
        address[] calldata lenders,
        address[] calldata assets,
        uint256[] calldata amounts,
        bytes calldata params
    ) external;

    function flashLoanBestEffort(
        address receiverAddress,
        address[] calldata lenders,
        address[] calldata assets,
        uint256[] calldata amounts,
        bytes calldata params
    ) external;

    function flashLoanWithPermit2(
        address receiverAddress,
        address[] calldata lenders,
        address[] calldata assets,
        uint256[] calldata amounts,
        Permit2SignatureData[] calldata permits,
        bytes calldata params
    ) external;

    function flashLoanBestEffortMix(
        address receiverAddress,
        address[] calldata lenders,
        address[] calldata assets,
        uint256[] calldata amounts,
        Permit2SignatureData[] calldata permits,
        bytes calldata params
    ) external;

    function aclManager() external view returns (IACLManager);

    function feeVerifier() external view returns (IFeeVerifier);

    function PERMIT2() external view returns (IAllowanceTransfer);

    function blacklistedTokens(address token) external view returns (bool);
}
