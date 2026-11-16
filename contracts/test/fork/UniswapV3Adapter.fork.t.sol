// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Test, console2} from "forge-std/Test.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {UniswapV3Adapter, ISwapRouter02, IWETH} from "../../src/adapters/UniswapV3Adapter.sol";

/// @notice Swaps through the real Uniswap v3 deployment on Robinhood Chain mainnet (fork).
///   ROBINHOOD_RPC=https://rpc.mainnet.chain.robinhood.com forge test --match-path test/fork/*
/// Skips itself when ROBINHOOD_RPC is not set.
contract UniswapV3AdapterForkTest is Test {
    address constant ROUTER = 0xCaf681a66D020601342297493863E78C959E5cb2;
    address constant WETH = 0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73;
    address constant USDG = 0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168;

    UniswapV3Adapter adapter;
    bool live;

    receive() external payable {}

    function setUp() public {
        string memory rpc = vm.envOr("ROBINHOOD_RPC", string(""));
        if (bytes(rpc).length == 0) return;
        vm.createSelectFork(rpc);
        live = true;
        // This test contract plays the vault.
        adapter = new UniswapV3Adapter(ISwapRouter02(ROUTER), IWETH(WETH), address(this));
        vm.deal(address(this), 10 ether);
    }

    function _firstWorkingFee(address tokenIn, address tokenOut, uint256 amountIn) internal returns (uint24) {
        uint24[3] memory fees = [uint24(500), uint24(3000), uint24(10000)];
        for (uint256 i = 0; i < 3; i++) {
            uint256 snap = vm.snapshotState();
            try adapter.swap{value: tokenIn == address(0) ? amountIn : 0}(tokenIn, tokenOut, amountIn, 1, abi.encode(fees[i])) {
                vm.revertToState(snap);
                return fees[i];
            } catch {
                vm.revertToState(snap);
            }
        }
        revert("no WETH/USDG pool found at 0.05%, 0.3% or 1%");
    }

    function test_fork_ethToUsdgAndBack() public {
        if (!live) return;
        uint24 fee = _firstWorkingFee(address(0), USDG, 0.01 ether);
        uint256 out = adapter.swap{value: 0.01 ether}(address(0), USDG, 0.01 ether, 1, abi.encode(fee));
        console2.log("0.01 ETH -> USDG", out, "fee tier", fee);
        assertEq(IERC20(USDG).balanceOf(address(this)), out);
        assertEq(address(adapter).balance, 0, "adapter keeps nothing");

        IERC20(USDG).transfer(address(adapter), out);
        uint256 before = address(this).balance;
        uint256 back = adapter.swap(USDG, address(0), out, 1, abi.encode(fee));
        assertEq(address(this).balance - before, back);
        assertGt(back, 0);
    }

    function test_fork_onlyVault() public {
        if (!live) return;
        vm.prank(address(0xbeef));
        vm.expectRevert(UniswapV3Adapter.OnlyVault.selector);
        adapter.swap(address(0), USDG, 1, 1, abi.encode(uint24(500)));
    }
}
