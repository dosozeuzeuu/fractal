// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {LibPoseidon2Perm} from "./LibPoseidon2Perm.sol";

/// @notice 4-input Poseidon2 (BN254, t=4, rate 3) sponge, matching Noir's Poseidon2::hash(input, 4)
///         and Barretenberg's poseidon2Hash: absorb (a, b, c) with IV = 4 << 64 in the capacity
///         element, permute, absorb d, permute, output the first element.
///         Used for note commitments H(1, stub, amount, token); tree nodes use the Yul hash_2.
contract Poseidon2Sponge {
    uint256 internal constant PRIME = 0x30644e72e131a029b85045b68181585d2833e84879b9709143e1f593f0000001;

    function hash_4(uint256 a, uint256 b, uint256 c, uint256 d) external pure returns (uint256) {
        (uint256 s0, uint256 s1, uint256 s2, uint256 s3) = LibPoseidon2Perm.permute(a, b, c, 4 << 64);
        (s0,,,) = LibPoseidon2Perm.permute(addmod(s0, d, PRIME), s1, s2, s3);
        return s0;
    }
}
