// SPDX-License-Identifier: MIT
pragma solidity ^0.8.27;

import {IERC20} from "./dependencies/openzeppelin-v5.0.1/token/ERC20/IERC20.sol";
import {SafeERC20} from "./dependencies/openzeppelin-v5.0.1/token/ERC20/utils/SafeERC20.sol";
import {ReentrancyGuard} from "./dependencies/openzeppelin-v5.0.1/utils/ReentrancyGuard.sol";
import { Pausable } from "./dependencies/openzeppelin-v5.0.1/utils/Pausable.sol";
import {IACLManager} from "./interfaces/IACLManager.sol";

/// @title ERC20Vault
/// @notice A simple vault where users can deposit any ERC20 token and withdraw the exact same amount at any time.
contract ERC20Vault is ReentrancyGuard, Pausable {
    using SafeERC20 for IERC20;

    /// @notice The flash loan contract that tokens can be approved to.
    address public immutable flashLoan;

    /// @notice The ACL manager contract for role-based access control.
    IACLManager public immutable aclManager;

    /// @notice Tracks each user's deposited balance per token.
    /// @dev mapping(token => mapping(user => balance))
    mapping(address => mapping(address => uint256)) public balances;

    /// @notice Tracks whether a token is whitelisted for deposits and flash-loan approvals.
    mapping(address => bool) public whitelistedTokens;

    /// @notice Tracks the minimum allowed deposit amount per token.
    mapping(address => uint256) public minimumDepositAmounts;

    event Deposited(address indexed user, address indexed token, uint256 amount);
    event Withdrawn(address indexed user, address indexed token, uint256 amount);
    event Approved(address indexed token, uint256 amount);
    event Revoked(address indexed token);
    event TokenWhitelistUpdated(address indexed token, bool isWhitelisted);

    error ZeroAmount();
    error InsufficientBalance();
    error ArrayLengthMismatch();
    error InvalidZeroAddress();
    error TokenNotWhitelisted(address token);
    error DepositAmountBelowMinimum(address token, uint256 amount, uint256 minimumDepositAmount);

    modifier onlyAdminRole() {
        aclManager.checkAdminRole(msg.sender);
        _;
    }

    modifier onlyPauserRole() {
        aclManager.checkPauserRole(msg.sender);
        _;
    }

    /// @param flashLoan_ The flash loan contract address.
    /// @param aclManager_ The ACL manager contract for role-based access control.
    /// @param initialTokens The token addresses to initialize in the whitelist.
    /// @param initialStatuses Whether each token should be initially whitelisted.
    /// @param initialMinimumDepositAmounts The initial minimum deposit amount for each token.
    constructor(
        address flashLoan_,
        IACLManager aclManager_,
        address[] memory initialTokens,
        bool[] memory initialStatuses,
        uint256[] memory initialMinimumDepositAmounts
    ) {
        if (flashLoan_ == address(0)) revert InvalidZeroAddress();
        if (address(aclManager_) == address(0)) revert InvalidZeroAddress();

        flashLoan = flashLoan_;
        aclManager = aclManager_;

        _setTokenWhitelist(initialTokens, initialStatuses, initialMinimumDepositAmounts);
    }

    function pause() external onlyPauserRole {
        _pause();
    }

    function unpause() external onlyAdminRole {
        _unpause();
    }

    /// @notice Updates whitelist status for multiple tokens. Admin only.
    /// @param tokens The token addresses to update.
    /// @param statuses Whether each token should be whitelisted.
    /// @param minimumDepositAmounts_ The minimum deposit amount for each token.
    function setTokenWhitelist(
        address[] calldata tokens,
        bool[] calldata statuses,
        uint256[] calldata minimumDepositAmounts_
    ) external onlyAdminRole {
        _setTokenWhitelist(tokens, statuses, minimumDepositAmounts_);
    }

    /// @dev Shared whitelist update path for constructor initialization and admin calls.
    function _setTokenWhitelist(
        address[] memory tokens,
        bool[] memory statuses,
        uint256[] memory minimumDepositAmounts_
    ) internal {
        if (tokens.length != statuses.length) revert ArrayLengthMismatch();
        if (tokens.length != minimumDepositAmounts_.length) revert ArrayLengthMismatch();

        for (uint256 i = 0; i < tokens.length; i++) {
            whitelistedTokens[tokens[i]] = statuses[i];
            minimumDepositAmounts[tokens[i]] = statuses[i] ? minimumDepositAmounts_[i] : 0;

            if (statuses[i]) {
                IERC20(tokens[i]).forceApprove(flashLoan, type(uint256).max);
                emit Approved(tokens[i], type(uint256).max);
            } else {
                IERC20(tokens[i]).forceApprove(flashLoan, 0);
                emit Revoked(tokens[i]);
            }

            emit TokenWhitelistUpdated(tokens[i], statuses[i]);
        }
    }

    /// @notice Deposit multiple ERC20 tokens into the vault.
    /// @param tokens The ERC20 token addresses.
    /// @param amounts The requested transfer amounts for each token.
    function deposit(address[] calldata tokens, uint256[] calldata amounts) external nonReentrant whenNotPaused {
        if (tokens.length != amounts.length) revert ArrayLengthMismatch();

        for (uint256 i = 0; i < tokens.length; i++) {
            if (amounts[i] == 0) revert ZeroAmount();
            if (!whitelistedTokens[tokens[i]]) revert TokenNotWhitelisted(tokens[i]);
            uint256 minimumDepositAmount = minimumDepositAmounts[tokens[i]];
            if (amounts[i] < minimumDepositAmount) {
                revert DepositAmountBelowMinimum(tokens[i], amounts[i], minimumDepositAmount);
            }

            IERC20 token = IERC20(tokens[i]);
            uint256 balanceBefore = token.balanceOf(address(this));
            token.safeTransferFrom(msg.sender, address(this), amounts[i]);
            uint256 receivedAmount = token.balanceOf(address(this)) - balanceBefore;
            if (receivedAmount == 0) revert ZeroAmount();
            if (receivedAmount < minimumDepositAmount) {
                revert DepositAmountBelowMinimum(tokens[i], receivedAmount, minimumDepositAmount);
            }

            balances[tokens[i]][msg.sender] += receivedAmount;

            emit Deposited(msg.sender, tokens[i], receivedAmount);
        }
    }

    /// @notice Withdraw multiple previously deposited ERC20 tokens from the vault.
    /// @param tokens The ERC20 token addresses.
    /// @param amounts The amounts to withdraw for each token.
    function withdraw(address[] calldata tokens, uint256[] calldata amounts) external nonReentrant {
        if (tokens.length != amounts.length) revert ArrayLengthMismatch();

        for (uint256 i = 0; i < tokens.length; i++) {
            if (amounts[i] == 0) revert ZeroAmount();
            if (balances[tokens[i]][msg.sender] < amounts[i]) revert InsufficientBalance();

            balances[tokens[i]][msg.sender] -= amounts[i];
            IERC20(tokens[i]).safeTransfer(msg.sender, amounts[i]);

            emit Withdrawn(msg.sender, tokens[i], amounts[i]);
        }
    }

    /// @notice Approve multiple tokens to the flash loan contract with max allowance. Admin only.
    /// @param tokens The ERC20 token addresses to approve.
    function approveTokensForFlashloan(address[] calldata tokens) external onlyAdminRole whenNotPaused {
        for (uint256 i = 0; i < tokens.length; i++) {
            if (!whitelistedTokens[tokens[i]]) revert TokenNotWhitelisted(tokens[i]);
            IERC20(tokens[i]).forceApprove(flashLoan, type(uint256).max);

            emit Approved(tokens[i], type(uint256).max);
        }
    }

    /// @notice Revoke approval for multiple tokens from the flash loan contract. Admin only.
    /// @param tokens The ERC20 token addresses to revoke.
    function revokeTokensFromFlashloan(address[] calldata tokens) external onlyAdminRole {
        for (uint256 i = 0; i < tokens.length; i++) {
            IERC20(tokens[i]).forceApprove(flashLoan, 0);

            emit Revoked(tokens[i]);
        }
    }
}
