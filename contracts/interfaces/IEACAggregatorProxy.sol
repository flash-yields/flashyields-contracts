// SPDX-License-Identifier: MIT
pragma solidity ^0.8.27;

/// @title IEACAggregatorProxy
/// @notice Minimal EACAggregatorProxy interface used to read token USD prices.
interface IEACAggregatorProxy {
    /// @notice Returns the decimal precision used by the aggregator answer.
    function decimals() external view returns (uint8);

    /// @notice Returns the latest round data used to derive the token USD price.
    function latestRoundData()
        external
        view
        returns (
            uint80 roundId,
            int256 answer,
            uint256 startedAt,
            uint256 updatedAt,
            uint80 answeredInRound
        );
}
