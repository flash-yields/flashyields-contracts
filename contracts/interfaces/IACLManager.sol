// SPDX-License-Identifier: MIT
pragma solidity ^0.8.27;

interface IACLManager {

    function checkAdminRole(address _account) external view;
    function checkTreasurerRole(address _account) external view;
    function checkTimelockRole(address _account) external view;
    function checkPauserRole(address _account) external view;
    function checkBookKeeperRole(address _account) external view;
    function checkPayouterRole(address _account) external view;
    function checkOtherRole1(address _account) external view;
    function checkOtherRole2(address _account) external view;
    function checkOtherRole3(address _account) external view;

}