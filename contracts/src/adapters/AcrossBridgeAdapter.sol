// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {ISwapAdapter} from "../interfaces/ISwapAdapter.sol";
import {IAcrossSpokePool} from "../interfaces/IAcrossSpokePool.sol";

/// @title AcrossBridgeAdapter
/// @notice Private bridge out: the vault sends ETH from a private balance here, and this adapter
///         deposits it into Across on Robinhood Chain for a recipient on another chain. On-chain, the
///         vault pays the bridge; nothing names the wallet whose notes were spent.
///
///         `data` is the first eleven arguments of SpokePool.depositV3, ABI-encoded as eleven words:
///         (depositor, recipient, inputToken, outputToken, inputAmount, outputAmount, destinationChainId,
///         exclusiveRelayer, quoteTimestamp, fillDeadline, exclusivityDeadline). It is bound into the
///         spender's proof. `depositor` is the refund address on Robinhood Chain if Across never fills;
///         `inputToken` must be WETH and `inputAmount` exactly the ETH the vault sends. The message is
///         always empty. Uses the vault's ISwapAdapter call shape with tokenIn = tokenOut = ETH and
///         holds no funds.
contract AcrossBridgeAdapter is ISwapAdapter {
    IAcrossSpokePool public immutable spokePool;
    address public immutable weth;
    address public immutable vault;

    error OnlyVault();
    error BadBridge();

    constructor(IAcrossSpokePool spokePool_, address weth_, address vault_) {
        spokePool = spokePool_;
        weth = weth_;
        vault = vault_;
    }

    function swap(address tokenIn, address tokenOut, uint256 amountIn, uint256, bytes calldata data)
        external
        payable
        returns (uint256)
    {
        if (msg.sender != vault) revert OnlyVault();
        if (tokenIn != address(0) || tokenOut != address(0) || msg.value != amountIn || amountIn == 0) revert BadBridge();
        if (data.length != 352) revert BadBridge();
        // Words: 0 depositor, 1 recipient, 2 inputToken, 3 outputToken, 4 inputAmount, 5 outputAmount,
        // 6 destinationChainId (7-10 pass through; the SpokePool validates them).
        uint256 outputAmount = _word(data, 5);
        if (
            _word(data, 0) == 0 || _word(data, 1) == 0 || _word(data, 2) != uint256(uint160(weth))
                || _word(data, 3) == 0 || _word(data, 4) != amountIn || outputAmount == 0 || outputAmount > amountIn
                || _word(data, 6) == block.chainid
        ) revert BadBridge();
        // `data` is already the head of depositV3's arguments; append the empty `message` (offset, length).
        (bool ok, bytes memory ret) = address(spokePool).call{value: amountIn}(
            abi.encodePacked(IAcrossSpokePool.depositV3.selector, data, uint256(0x180), uint256(0))
        );
        if (!ok) {
            assembly ("memory-safe") {
                revert(add(ret, 32), mload(ret))
            }
        }
        return 0;
    }

    function _word(bytes calldata d, uint256 i) private pure returns (uint256) {
        return uint256(bytes32(d[i * 32:i * 32 + 32]));
    }
}
