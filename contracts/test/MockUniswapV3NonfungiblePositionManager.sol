// SPDX-License-Identifier: MIT
pragma solidity ^0.8.27;

import { IERC20 } from "../dependencies/openzeppelin-v5.0.1/token/ERC20/IERC20.sol";
import { SafeERC20 } from "../dependencies/openzeppelin-v5.0.1/token/ERC20/utils/SafeERC20.sol";
import { IUniswapV3NonfungiblePositionManager } from "../test/IUniswapV3NonfungiblePositionManager.sol";

/// @title MockUniswapV3NonfungiblePositionManager
/// @notice Test double for the Uniswap V3 position manager liquidity lifecycle.
contract MockUniswapV3NonfungiblePositionManager is IUniswapV3NonfungiblePositionManager {
    using SafeERC20 for IERC20;

    struct Position {
        address token0;
        address token1;
        uint128 liquidity;
        uint256 amount0;
        uint256 amount1;
        uint256 tokensOwed0;
        uint256 tokensOwed1;
    }

    uint256 public nextTokenId = 1;
    uint256 public createAndInitializeCalls;
    uint256 public createdPools;
    uint256 public mintCalls;
    uint256 public decreaseLiquidityCalls;
    uint256 public collectCalls;
    uint256 public burnCalls;

    mapping(bytes32 => address) public pools;
    mapping(uint256 => Position) public positions;

    function createAndInitializePoolIfNecessary(
        address token0,
        address token1,
        uint24 fee,
        uint160 sqrtPriceX96
    ) external payable returns (address pool) {
        createAndInitializeCalls++;
        bytes32 key = _poolKey(token0, token1, fee);
        pool = pools[key];

        if (pool == address(0)) {
            pool = address(uint160(uint256(keccak256(abi.encode(token0, token1, fee, sqrtPriceX96)))));
            pools[key] = pool;
            createdPools++;
        }
    }

    function mint(MintParams calldata params)
        external
        payable
        returns (uint256 tokenId, uint128 liquidity, uint256 amount0, uint256 amount1)
    {
        mintCalls++;
        amount0 = params.amount0Desired;
        amount1 = params.amount1Desired;
        if (amount0 < params.amount0Min || amount1 < params.amount1Min) revert("amount below min");

        uint256 liquidityAmount = amount0 < amount1 ? amount0 : amount1;
        liquidity = uint128(liquidityAmount);
        tokenId = nextTokenId++;

        IERC20(params.token0).safeTransferFrom(msg.sender, address(this), amount0);
        IERC20(params.token1).safeTransferFrom(msg.sender, address(this), amount1);

        positions[tokenId] = Position({
            token0: params.token0,
            token1: params.token1,
            liquidity: liquidity,
            amount0: amount0,
            amount1: amount1,
            tokensOwed0: 0,
            tokensOwed1: 0
        });
    }

    function decreaseLiquidity(DecreaseLiquidityParams calldata params)
        external
        payable
        returns (uint256 amount0, uint256 amount1)
    {
        decreaseLiquidityCalls++;
        Position storage position = positions[params.tokenId];
        uint128 liquidity = position.liquidity;
        if (params.liquidity > liquidity) revert("insufficient liquidity");

        amount0 = position.amount0 * params.liquidity / liquidity;
        amount1 = position.amount1 * params.liquidity / liquidity;
        if (amount0 < params.amount0Min || amount1 < params.amount1Min) revert("amount below min");

        position.liquidity = liquidity - params.liquidity;
        position.amount0 -= amount0;
        position.amount1 -= amount1;
        position.tokensOwed0 += amount0;
        position.tokensOwed1 += amount1;
    }

    function collect(CollectParams calldata params)
        external
        payable
        returns (uint256 amount0, uint256 amount1)
    {
        collectCalls++;
        Position storage position = positions[params.tokenId];

        amount0 = position.tokensOwed0 < params.amount0Max ? position.tokensOwed0 : params.amount0Max;
        amount1 = position.tokensOwed1 < params.amount1Max ? position.tokensOwed1 : params.amount1Max;

        position.tokensOwed0 -= amount0;
        position.tokensOwed1 -= amount1;

        IERC20(position.token0).safeTransfer(params.recipient, amount0);
        IERC20(position.token1).safeTransfer(params.recipient, amount1);
    }

    function burn(uint256 tokenId) external payable {
        burnCalls++;
        Position storage position = positions[tokenId];
        if (position.liquidity != 0 || position.tokensOwed0 != 0 || position.tokensOwed1 != 0) {
            revert("position not cleared");
        }

        delete positions[tokenId];
    }

    function _poolKey(address token0, address token1, uint24 fee) internal pure returns (bytes32) {
        return keccak256(abi.encode(token0, token1, fee));
    }
}
