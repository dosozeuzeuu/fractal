// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {ISwapAdapter} from "../interfaces/ISwapAdapter.sol";

interface IWETH {
    function deposit() external payable;
    function withdraw(uint256) external;
}

/// @dev Uniswap SwapRouter02 (no deadline field), deployed on Robinhood Chain at
///      0xcaf681a66d020601342297493863e78c959e5cb2.
interface ISwapRouter02 {
    struct ExactInputSingleParams {
        address tokenIn;
        address tokenOut;
        uint24 fee;
        address recipient;
        uint256 amountIn;
        uint256 amountOutMinimum;
        uint160 sqrtPriceLimitX96;
    }

    struct ExactInputParams {
        bytes path;
        address recipient;
        uint256 amountIn;
        uint256 amountOutMinimum;
    }

    function exactInputSingle(ExactInputSingleParams calldata params) external payable returns (uint256 amountOut);
    function exactInput(ExactInputParams calldata params) external payable returns (uint256 amountOut);
}

/// @title UniswapV3Adapter
/// @notice Swaps through Uniswap v3 for the vault. ETH is wrapped to WETH on the way in and unwrapped
///         on the way out. `data` is either abi.encode(uint24 fee) for a single pool, or a packed
///         multi-hop Uniswap path (tokenIn, fee, token, fee, ..., tokenOut) using WETH for ETH.
///         Holds no funds between calls; only the vault may call it.
contract UniswapV3Adapter is ISwapAdapter {
    using SafeERC20 for IERC20;

    ISwapRouter02 public immutable router;
    IWETH public immutable weth;
    address public immutable vault;

    error OnlyVault();
    error BadValue();
    error BadPath();
    error TransferFailed();

    constructor(ISwapRouter02 router_, IWETH weth_, address vault_) {
        router = router_;
        weth = weth_;
        vault = vault_;
    }

    receive() external payable {
        if (msg.sender != address(weth)) revert TransferFailed();
    }

    function swap(address tokenIn, address tokenOut, uint256 amountIn, uint256 minOut, bytes calldata data)
        external
        payable
        returns (uint256 amountOut)
    {
        if (msg.sender != vault) revert OnlyVault();
        address inToken = tokenIn == address(0) ? address(weth) : tokenIn;
        address outToken = tokenOut == address(0) ? address(weth) : tokenOut;
        if (tokenIn == address(0)) {
            if (msg.value != amountIn) revert BadValue();
            weth.deposit{value: amountIn}();
        } else if (msg.value != 0) {
            revert BadValue();
        }
        IERC20(inToken).forceApprove(address(router), amountIn);

        if (data.length == 32) {
            amountOut = router.exactInputSingle(
                ISwapRouter02.ExactInputSingleParams({
                    tokenIn: inToken,
                    tokenOut: outToken,
                    fee: abi.decode(data, (uint24)),
                    recipient: address(this),
                    amountIn: amountIn,
                    amountOutMinimum: minOut,
                    sqrtPriceLimitX96: 0
                })
            );
        } else {
            // path = tokenIn(20) | (fee(3) | token(20))+ ; first and last token must match the swap
            if (data.length < 43 || (data.length - 20) % 23 != 0) revert BadPath();
            if (address(bytes20(data[0:20])) != inToken) revert BadPath();
            if (address(bytes20(data[data.length - 20:])) != outToken) revert BadPath();
            amountOut = router.exactInput(
                ISwapRouter02.ExactInputParams({
                    path: data,
                    recipient: address(this),
                    amountIn: amountIn,
                    amountOutMinimum: minOut
                })
            );
        }
        IERC20(inToken).forceApprove(address(router), 0);

        if (tokenOut == address(0)) {
            weth.withdraw(amountOut);
            (bool ok,) = vault.call{value: amountOut}("");
            if (!ok) revert TransferFailed();
        } else {
            IERC20(outToken).safeTransfer(vault, amountOut);
        }
    }
}
