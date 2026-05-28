// SPDX-License-Identifier: MIT
pragma solidity ^0.8.27;

import { ERC20 } from "../dependencies/openzeppelin-v5.0.1/token/ERC20/ERC20.sol";

/// @title MockERC20Decimals
/// @notice Mintable ERC20 with configurable decimals for tests.
contract MockERC20Decimals is ERC20 {
    uint8 private immutable _customDecimals;

    constructor(string memory name_, string memory symbol_, uint8 decimals_) ERC20(name_, symbol_) {
        _customDecimals = decimals_;
    }

    function decimals() public view override returns (uint8) {
        return _customDecimals;
    }

    function mint(address account, uint256 amount) external {
        _mint(account, amount);
    }

    function burn(address account, uint256 amount) external {
        _burn(account, amount);
    }
}
