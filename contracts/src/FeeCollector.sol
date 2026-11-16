// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Ownable2Step, Ownable} from "@openzeppelin/contracts/access/Ownable2Step.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";

/// @title FeeCollector
/// @notice Receives the vault's exit and swap fees (ETH and tokens) and unused gas. `collect(token)`
///         (callable by anyone) splits a token's balance in half: team, and the buyback sink. The sink
///         is a separate contract (for example one that buys and burns a token), so burn mechanics can
///         be added later without touching the vault.
contract FeeCollector is Ownable2Step {
    using SafeERC20 for IERC20;

    address public team;
    address public buybackSink;

    event Collected(address indexed token, uint256 toTeam, uint256 toBuyback);
    event TeamSet(address team);
    event BuybackSinkSet(address sink);

    error ZeroAddress();
    error TransferFailed();

    constructor(address owner_, address team_, address buybackSink_) Ownable(owner_) {
        if (team_ == address(0) || buybackSink_ == address(0)) revert ZeroAddress();
        team = team_;
        buybackSink = buybackSink_;
    }

    receive() external payable {}

    /// @param token The token to split, or address(0) for ETH.
    function collect(address token) external {
        uint256 balance = token == address(0) ? address(this).balance : IERC20(token).balanceOf(address(this));
        if (balance == 0) return;
        uint256 toTeam = balance / 2;
        uint256 toBuyback = balance - toTeam;
        if (token == address(0)) {
            (bool ok1,) = team.call{value: toTeam}("");
            (bool ok2,) = buybackSink.call{value: toBuyback}("");
            if (!ok1 || !ok2) revert TransferFailed();
        } else {
            IERC20(token).safeTransfer(team, toTeam);
            IERC20(token).safeTransfer(buybackSink, toBuyback);
        }
        emit Collected(token, toTeam, toBuyback);
    }

    function setTeam(address team_) external onlyOwner {
        if (team_ == address(0)) revert ZeroAddress();
        team = team_;
        emit TeamSet(team_);
    }

    function setBuybackSink(address sink) external onlyOwner {
        if (sink == address(0)) revert ZeroAddress();
        buybackSink = sink;
        emit BuybackSinkSet(sink);
    }
}
