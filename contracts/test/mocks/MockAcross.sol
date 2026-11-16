// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {IAcrossMessageHandler} from "../../src/interfaces/IAcrossSpokePool.sol";

/// @dev Minimal WETH9.
contract MockWETH {
    mapping(address => uint256) public balanceOf;

    function deposit() external payable {
        balanceOf[msg.sender] += msg.value;
    }

    function withdraw(uint256 amount) external {
        balanceOf[msg.sender] -= amount;
        (bool ok,) = msg.sender.call{value: amount}("");
        require(ok, "weth: eth send");
    }

    function transfer(address to, uint256 amount) external returns (bool) {
        balanceOf[msg.sender] -= amount;
        balanceOf[to] += amount;
        return true;
    }
}

/// @dev Across SpokePool stand-in: records the last depositV3 (taking the ETH) and can play a relayer
///      filling to a message handler.
contract MockSpokePool {
    MockWETH public immutable weth;
    bool public broken;

    bytes public lastCall; // the full depositV3 calldata
    uint256 public lastValue;

    constructor(MockWETH weth_) {
        weth = weth_;
    }

    function setBroken(bool b) external {
        broken = b;
    }

    /// @dev Same selector and argument layout as SpokePool.depositV3; records the call instead.
    fallback() external payable {
        require(msg.sig == bytes4(keccak256(
            "depositV3(address,address,address,address,uint256,uint256,uint256,address,uint32,uint32,uint32,bytes)"
        )), "unknown call");
        require(!broken, "spoke broken");
        require(msg.value == _arg(4), "value");
        lastCall = msg.data;
        lastValue = msg.value;
    }

    function _arg(uint256 i) internal pure returns (uint256 v) {
        v = uint256(bytes32(msg.data[4 + i * 32:4 + i * 32 + 32]));
    }

    function arg(uint256 i) external view returns (uint256 v) {
        bytes memory c = lastCall;
        assembly ("memory-safe") {
            v := mload(add(add(c, 36), mul(i, 32)))
        }
    }

    /// @dev A relayer fill on this chain: WETH to the recipient, then the message call.
    function fill(address recipient, uint256 amount, bytes calldata message) external payable {
        require(msg.value == amount, "value");
        weth.deposit{value: amount}();
        weth.transfer(recipient, amount);
        IAcrossMessageHandler(recipient).handleV3AcrossMessage(address(weth), amount, msg.sender, message);
    }
}
