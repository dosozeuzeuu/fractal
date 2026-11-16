// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

/// @notice A DEX adapter the vault routes private swaps through. Allowlisted by the admin.
/// The vault sends `amountIn` of `tokenIn` (ETH as msg.value when tokenIn is address(0)) to the
/// adapter first, then calls `swap`. The adapter must send at least `minOut` of `tokenOut` (ETH when
/// address(0)) back to msg.sender. The vault measures what it received; the return value is advisory.
interface ISwapAdapter {
    function swap(address tokenIn, address tokenOut, uint256 amountIn, uint256 minOut, bytes calldata data)
        external
        payable
        returns (uint256 amountOut);
}
