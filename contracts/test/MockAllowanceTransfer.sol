// SPDX-License-Identifier: MIT
pragma solidity ^0.8.27;

import { IERC20 } from "../dependencies/openzeppelin-v5.0.1/token/ERC20/IERC20.sol";
import { SafeERC20 } from "../dependencies/openzeppelin-v5.0.1/token/ERC20/utils/SafeERC20.sol";
import { IAllowanceTransfer } from "../interfaces/IAllowanceTransfer.sol";

/// @title MockAllowanceTransfer
/// @notice Permit2-compatible allowance transfer mock for isolated branch tests.
contract MockAllowanceTransfer is IAllowanceTransfer {
    using SafeERC20 for IERC20;

    struct StoredAllowance {
        uint160 amount;
        uint48 expiration;
        uint48 nonce;
    }

    mapping(address => mapping(address => mapping(address => StoredAllowance))) internal _allowances;

    bool public permitShouldRevert;
    bool public transferShouldRevert;

    error PermitRejected();
    error TransferRejected();
    error InsufficientPermit2Allowance();
    error Permit2AllowanceExpired();

    function setPermitShouldRevert(bool value) external {
        permitShouldRevert = value;
    }

    function setTransferShouldRevert(bool value) external {
        transferShouldRevert = value;
    }

    function setAllowance(
        address owner,
        address token,
        address spender,
        uint160 amount,
        uint48 expiration,
        uint48 nonce
    ) external {
        _allowances[owner][token][spender] = StoredAllowance(amount, expiration, nonce);
    }

    function allowance(
        address owner,
        address token,
        address spender
    ) external view returns (uint160 amount, uint48 expiration, uint48 nonce) {
        StoredAllowance memory stored = _allowances[owner][token][spender];
        return (stored.amount, stored.expiration, stored.nonce);
    }

    function permit(
        address owner,
        PermitSingle memory permitSingle,
        bytes calldata signature
    ) external {
        signature;
        if (permitShouldRevert) revert PermitRejected();

        PermitDetails memory details = permitSingle.details;
        _allowances[owner][details.token][permitSingle.spender] = StoredAllowance({
            amount: details.amount,
            expiration: details.expiration,
            nonce: details.nonce + 1
        });
    }

    function transferFrom(
        address from,
        address to,
        uint160 amount,
        address token
    ) external {
        if (transferShouldRevert) revert TransferRejected();

        StoredAllowance storage stored = _allowances[from][token][msg.sender];
        if (stored.expiration < block.timestamp) revert Permit2AllowanceExpired();
        if (stored.amount < amount) revert InsufficientPermit2Allowance();

        stored.amount -= amount;
        IERC20(token).safeTransferFrom(from, to, amount);
    }
}
