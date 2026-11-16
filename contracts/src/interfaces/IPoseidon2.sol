// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

/// @notice Poseidon2 over BN254 (t=4), ABI-compatible with zemse/poseidon2-evm's Poseidon2Yul_BN254.
interface IPoseidon2 {
    function hash_1(uint256 x) external pure returns (uint256);
    function hash_2(uint256 x, uint256 y) external pure returns (uint256);
    function hash_3(uint256 x, uint256 y, uint256 z) external pure returns (uint256);
}

/// @notice 4-input Poseidon2 sponge (see Poseidon2Sponge.sol).
interface IPoseidon2Sponge {
    function hash_4(uint256 a, uint256 b, uint256 c, uint256 d) external pure returns (uint256);
}
