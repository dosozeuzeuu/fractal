// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {IAcrossMessageHandler} from "./interfaces/IAcrossSpokePool.sol";

interface IWETH9 {
    function withdraw(uint256) external;
}

interface IShieldVault {
    function shield(uint256 stub, bytes calldata ciphertext) external payable;
}

/// @title AcrossDepositHandler
/// @notice Private bridge in: someone bridges ETH to Robinhood Chain through Across with this contract
///         as the recipient and `message = abi.encode(stub, ciphertext)`. When a relayer fills, the
///         SpokePool hands over WETH and calls this handler, which unwraps it and shields exactly the
///         filled amount into the vault as the depositor's note. The depositor's Robinhood Chain address
///         never appears: the vault sees this handler as the shielder.
///
///         If shielding fails (vault paused, cap reached), the call reverts, the fill fails, and
///         Across refunds the depositor on the origin chain after the deposit's fill deadline.
///         Holds nothing between calls.
contract AcrossDepositHandler is IAcrossMessageHandler {
    address public immutable spokePool;
    IWETH9 public immutable weth;
    IShieldVault public immutable vault;

    error OnlySpokePool();
    error BadToken();
    error BadSender();

    constructor(address spokePool_, IWETH9 weth_, IShieldVault vault_) {
        spokePool = spokePool_;
        weth = weth_;
        vault = vault_;
    }

    function handleV3AcrossMessage(address tokenSent, uint256 amount, address, bytes calldata message) external {
        if (msg.sender != spokePool) revert OnlySpokePool();
        if (tokenSent != address(weth)) revert BadToken();
        (uint256 stub, bytes memory ciphertext) = abi.decode(message, (uint256, bytes));
        weth.withdraw(amount);
        vault.shield{value: amount}(stub, ciphertext);
    }

    receive() external payable {
        if (msg.sender != address(weth)) revert BadSender();
    }
}
