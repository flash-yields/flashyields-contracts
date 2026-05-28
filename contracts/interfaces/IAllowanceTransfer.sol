// SPDX-License-Identifier: MIT
pragma solidity ^0.8.27;

/// @title IAllowanceTransfer
/// @notice Minimal interface for Uniswap Permit2 AllowanceTransfer functionality.
/// @dev Sourced from https://github.com/Uniswap/permit2
interface IAllowanceTransfer {
    /// @notice The permit data for a single token allowance.
    struct PermitDetails {
        address token;
        uint160 amount;
        uint48 expiration;
        uint48 nonce;
    }

    /// @notice The permit message signed by the token owner for a single token allowance.
    struct PermitSingle {
        PermitDetails details;
        address spender;
        uint256 sigDeadline;
    }

    /// @notice Returns the current allowance for a given owner, token, and spender.
    /// @param owner The token owner.
    /// @param token The token address.
    /// @param spender The spender address.
    /// @return amount The allowed amount.
    /// @return expiration The expiration timestamp.
    /// @return nonce The current nonce.
    function allowance(
        address owner,
        address token,
        address spender
    ) external view returns (uint160 amount, uint48 expiration, uint48 nonce);

    /// @notice Sets an on-chain allowance via a signed permit from the token owner.
    /// @param owner The token owner granting the allowance.
    /// @param permitSingle The permit data for a single token allowance.
    /// @param signature The EIP-712 signature from the owner.
    function permit(
        address owner,
        PermitSingle memory permitSingle,
        bytes calldata signature
    ) external;

    /// @notice Transfers tokens using the on-chain allowance set via permit.
    /// @param from The address to transfer from.
    /// @param to The address to transfer to.
    /// @param amount The amount to transfer (uint160).
    /// @param token The token to transfer.
    function transferFrom(
        address from,
        address to,
        uint160 amount,
        address token
    ) external;
}
