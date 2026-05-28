// SPDX-License-Identifier: MIT
pragma solidity ^0.8.27;

interface IVotingEscrow {

    struct LockedBalance {
        int128 amount;
        uint256 end;
    }

    struct Point {
        int128 bias;
        int128 slope;
        uint256 ts;
        uint256 blk;
    }

    function create_lock(uint256 _value, uint256 _unlock_time) external;
    function increase_amount(uint256 _value) external;
    function create_lock_for(address _addr, uint256 _value, uint256 _unlock_time) external;
    function increase_amount_for(address _addr, uint256 _value) external;
    function increase_unlock_time(uint256 _unlock_time) external;
    function withdraw() external;
    function whitelist_contracts(address[30] memory contracts, bool[30] memory is_whitelists) external;

    // view
    function locked(address user) external view returns (LockedBalance memory);
    function point_history(uint256 epoch) external view returns (Point memory);
    function epoch() external view returns (uint256);
    function balanceOf(address addr) external view returns (uint256);
    function totalSupply() external view returns (uint256);
    function admin() external view returns (address);
}
