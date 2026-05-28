// SPDX-License-Identifier: MIT
pragma solidity ^0.8.27;

library InputValidator {

	error IncorrectAddress();

	function validateAddr (address _inputAddr) internal pure {
		if (_inputAddr == address(0)) {
			revert IncorrectAddress();
		}
	}
}