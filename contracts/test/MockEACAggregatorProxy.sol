// SPDX-License-Identifier: MIT
pragma solidity ^0.8.27;

import { IEACAggregatorProxy } from "../interfaces/IEACAggregatorProxy.sol";

/// @title MockEACAggregatorProxy
/// @notice Configurable Chainlink-style aggregator proxy for tests.
contract MockEACAggregatorProxy is IEACAggregatorProxy {
    uint8 private _decimals;
    uint80 private _roundId;
    int256 private _answer;
    uint256 private _startedAt;
    uint256 private _updatedAt;
    uint80 private _answeredInRound;

    constructor(uint8 decimals_, int256 answer_, uint256 updatedAt_) {
        _decimals = decimals_;
        _roundId = 1;
        _answer = answer_;
        _startedAt = updatedAt_;
        _updatedAt = updatedAt_;
        _answeredInRound = 1;
    }

    function setDecimals(uint8 decimals_) external {
        _decimals = decimals_;
    }

    function setLatestRoundData(
        uint80 roundId_,
        int256 answer_,
        uint256 startedAt_,
        uint256 updatedAt_,
        uint80 answeredInRound_
    ) external {
        _roundId = roundId_;
        _answer = answer_;
        _startedAt = startedAt_;
        _updatedAt = updatedAt_;
        _answeredInRound = answeredInRound_;
    }

    function decimals() external view returns (uint8) {
        return _decimals;
    }

    function latestRoundData()
        external
        view
        returns (
            uint80 roundId,
            int256 answer,
            uint256 startedAt,
            uint256 updatedAt,
            uint80 answeredInRound
        )
    {
        return (_roundId, _answer, _startedAt, _updatedAt, _answeredInRound);
    }
}
