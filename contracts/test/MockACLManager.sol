// SPDX-License-Identifier: MIT
pragma solidity ^0.8.27;

import { IACLManager } from "../interfaces/IACLManager.sol";

/// @title MockACLManager
/// @notice Test ACL manager with individually configurable role checks.
contract MockACLManager is IACLManager {
    mapping(address => bool) public adminRole;
    mapping(address => bool) public treasurerRole;
    mapping(address => bool) public timelockRole;
    mapping(address => bool) public pauserRole;
    mapping(address => bool) public bookKeeperRole;
    mapping(address => bool) public payouterRole;
    mapping(address => bool) public otherRole1;
    mapping(address => bool) public otherRole2;
    mapping(address => bool) public otherRole3;

    error NotAdminRole(address account);
    error NotTreasurerRole(address account);
    error NotTimelockRole(address account);
    error NotPauserRole(address account);
    error NotBookKeeperRole(address account);
    error NotPayouterRole(address account);
    error NotOtherRole1(address account);
    error NotOtherRole2(address account);
    error NotOtherRole3(address account);

    function setAdminRole(address account, bool allowed) external {
        adminRole[account] = allowed;
    }

    function setTreasurerRole(address account, bool allowed) external {
        treasurerRole[account] = allowed;
    }

    function setTimelockRole(address account, bool allowed) external {
        timelockRole[account] = allowed;
    }

    function setPauserRole(address account, bool allowed) external {
        pauserRole[account] = allowed;
    }

    function setBookKeeperRole(address account, bool allowed) external {
        bookKeeperRole[account] = allowed;
    }

    function setPayouterRole(address account, bool allowed) external {
        payouterRole[account] = allowed;
    }

    function setOtherRole1(address account, bool allowed) external {
        otherRole1[account] = allowed;
    }

    function setOtherRole2(address account, bool allowed) external {
        otherRole2[account] = allowed;
    }

    function setOtherRole3(address account, bool allowed) external {
        otherRole3[account] = allowed;
    }

    function checkAdminRole(address account) external view {
        if (!adminRole[account]) revert NotAdminRole(account);
    }

    function checkTreasurerRole(address account) external view {
        if (!treasurerRole[account]) revert NotTreasurerRole(account);
    }

    function checkTimelockRole(address account) external view {
        if (!timelockRole[account]) revert NotTimelockRole(account);
    }

    function checkPauserRole(address account) external view {
        if (!pauserRole[account]) revert NotPauserRole(account);
    }

    function checkBookKeeperRole(address account) external view {
        if (!bookKeeperRole[account]) revert NotBookKeeperRole(account);
    }

    function checkPayouterRole(address account) external view {
        if (!payouterRole[account]) revert NotPayouterRole(account);
    }

    function checkOtherRole1(address account) external view {
        if (!otherRole1[account]) revert NotOtherRole1(account);
    }

    function checkOtherRole2(address account) external view {
        if (!otherRole2[account]) revert NotOtherRole2(account);
    }

    function checkOtherRole3(address account) external view {
        if (!otherRole3[account]) revert NotOtherRole3(account);
    }
}
