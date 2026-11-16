// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {ISwapAdapter} from "../../src/interfaces/ISwapAdapter.sol";

interface IMintable {
    function mint(address to, uint256 amount) external;
}

/// @dev Local-chain DEX stand-in: pays out at a fixed price (out = in * num / den), minting mock
///      tokens or paying ETH from its own balance. `broken` makes it revert, to test refunds.
contract MockSwapAdapter is ISwapAdapter {
    mapping(address => mapping(address => uint256[2])) public price; // tokenIn => tokenOut => [num, den]
    bool public broken;

    receive() external payable {}

    function setPrice(address tokenIn, address tokenOut, uint256 num, uint256 den) external {
        price[tokenIn][tokenOut] = [num, den];
    }

    function setBroken(bool b) external {
        broken = b;
    }

    function swap(address tokenIn, address tokenOut, uint256 amountIn, uint256 minOut, bytes calldata)
        external
        payable
        returns (uint256 amountOut)
    {
        require(!broken, "adapter broken");
        uint256[2] memory p = price[tokenIn][tokenOut];
        require(p[1] != 0, "no price");
        if (tokenIn == address(0)) require(msg.value == amountIn, "value");
        amountOut = amountIn * p[0] / p[1];
        require(amountOut >= minOut, "slippage");
        if (tokenOut == address(0)) {
            (bool ok,) = msg.sender.call{value: amountOut}("");
            require(ok, "eth out");
        } else {
            IMintable(tokenOut).mint(msg.sender, amountOut);
        }
        if (tokenIn != address(0)) IERC20(tokenIn).transfer(address(0xdead), amountIn);
    }
}
