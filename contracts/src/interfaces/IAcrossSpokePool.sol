// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

/// @notice The part of Across's SpokePool (V3) fractal uses. `depositV3` with `inputToken` = the
///         wrapped native token and msg.value = `inputAmount` bridges native ETH.
interface IAcrossSpokePool {
    function depositV3(
        address depositor,
        address recipient,
        address inputToken,
        address outputToken,
        uint256 inputAmount,
        uint256 outputAmount,
        uint256 destinationChainId,
        address exclusiveRelayer,
        uint32 quoteTimestamp,
        uint32 fillDeadline,
        uint32 exclusivityDeadline,
        bytes calldata message
    ) external payable;
}

/// @notice Called by the SpokePool on the destination chain after a fill that carries a message.
interface IAcrossMessageHandler {
    function handleV3AcrossMessage(address tokenSent, uint256 amount, address relayer, bytes calldata message) external;
}
