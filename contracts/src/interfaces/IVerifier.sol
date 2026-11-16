// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

/// @notice The Barretenberg-generated UltraHonk verifier of the `transact` circuit.
interface IVerifier {
    function verify(bytes calldata proof, bytes32[] calldata publicInputs) external view returns (bool);
}
