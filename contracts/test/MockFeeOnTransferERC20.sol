// SPDX-License-Identifier: MIT
pragma solidity ^0.8.27;

import { ERC20 } from "../dependencies/openzeppelin-v5.0.1/token/ERC20/ERC20.sol";

/// @title MockFeeOnTransferERC20
/// @notice Mintable ERC20 that burns a configurable fee on transfers.
contract MockFeeOnTransferERC20 is ERC20 {
    uint256 private constant MAX_BPS = 10_000;

    uint8 private immutable _customDecimals;

    uint256 public immutable feeBps;

    error FeeBpsTooHigh();

    constructor(
        string memory name_,
        string memory symbol_,
        uint8 decimals_,
        uint256 feeBps_
    ) ERC20(name_, symbol_) {
        if (feeBps_ > MAX_BPS) revert FeeBpsTooHigh();

        _customDecimals = decimals_;
        feeBps = feeBps_;
    }

    function decimals() public view override returns (uint8) {
        return _customDecimals;
    }

    function mint(address account, uint256 amount) external {
        _mint(account, amount);
    }

    /// @inheritdoc ERC20
    function _update(address from, address to, uint256 value) internal override {
        if (from == address(0) || to == address(0) || feeBps == 0) {
            super._update(from, to, value);
            return;
        }

        uint256 fee = value * feeBps / MAX_BPS;
        uint256 receivedAmount = value - fee;

        super._update(from, to, receivedAmount);
        if (fee > 0) {
            super._update(from, address(0), fee);
        }
    }
}
