// SPDX-License-Identifier: MIT
pragma solidity ^0.8.27;

import { IApprovalFlashLoan } from "./IApprovalFlashLoan.sol";
import { IACLManager } from "./IACLManager.sol";

/// @title ILenderRegistry
/// @notice Interface for the standalone registry that records potential lender participation.
interface ILenderRegistry {
    /// @notice Thrown when a zero address is provided where a valid address is required.
    error InvalidZeroAddress();
    /// @notice Thrown when a borrowed token is blacklisted.
    error TokenBlacklisted(address token);
    /// @notice Thrown when permissionless participation updates are disabled.
    error PermissionlessParticipationDisabled();

    /// @dev Token-level lender availability data returned by view helpers.
    struct TokenLenderAvailability {
        address token;
        address[] lenders;
        uint256[] availableAmounts;
    }

    /// @dev Per-lender availability data returned by token-specific view helpers.
    struct LenderAvailability {
        address lender;
        uint256 availableAmount;
    }

    /// @dev Token and lender list used for bookkeeper-managed participation updates.
    struct LenderParticipation {
        address token;
        address[] lenders;
    }

    /// @notice Emitted when permissionless self-service participation updates are enabled or disabled.
    /// @param isEnabled Whether any address can call self-service participation update functions.
    event PermissionlessParticipationUpdated(bool isEnabled);

    /// @notice Emitted when the active registry set is reset.
    /// @param registrySetId The new active registry set id.
    event RegistrySetReset(uint256 indexed registrySetId);

    function pause() external;

    function unpause() external;

    /// @notice Resets lender participation by moving registry logic to a fresh empty registry set.
    function resetRegistrySet() external;

    /// @notice Enables or disables any-address self-service participation updates.
    /// @param isEnabled Whether any address can call self-service participation update functions.
    function setPermissionlessParticipationEnabled(bool isEnabled) external;

    function indicateParticipation(address[] calldata tokens) external;

    function indicateParticipationFor(LenderParticipation[] calldata lenderParticipations) external;

    function removeParticipation(address[] calldata tokens) external;

    function removeParticipationFor(LenderParticipation[] calldata lenderParticipations) external;

    function getAllPotentialLendersAvailability() external view returns (TokenLenderAvailability[] memory tokenLenderAvailability);

    function getPotentialLendersAvailabilityByToken(address token) external view returns (LenderAvailability[] memory lenderAvailability);

    /// @notice Returns available amounts for a user-provided lender list and token.
    /// @param token The token address to query.
    /// @param lenders The lender addresses to query.
    function getAvailableAmountsByTokenAndLenders(address token, address[] calldata lenders)
        external
        view
        returns (uint256[] memory availableAmounts);

    /// @notice Returns the total number of lenders registered in the current registry set.
    function getTotalPotentialLenders() external view returns (uint256);

    /// @notice Returns whether the token has registered lenders and is not blacklisted.
    function potentialTokens(address token) external view returns (bool);

    function approvalFlashLoan() external view returns (IApprovalFlashLoan);

    function aclManager() external view returns (IACLManager);

    /// @notice Returns whether any address can call self-service participation update functions.
    function permissionlessParticipationEnabled() external view returns (bool);

    /// @notice Returns the active registry set id.
    function currentRegistrySetId() external view returns (uint256);
}
