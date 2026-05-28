// SPDX-License-Identifier: MIT
pragma solidity ^0.8.27;

/// @title MockRevertingERC20
/// @notice ERC20-like contract that always reverts on balanceOf and allowance, for testing try/catch.
contract MockRevertingERC20 {
    function balanceOf(address) external pure returns (uint256) {
        revert("MockRevertingERC20: balanceOf reverted");
    }

    function allowance(address, address) external pure returns (uint256) {
        revert("MockRevertingERC20: allowance reverted");
    }
}
