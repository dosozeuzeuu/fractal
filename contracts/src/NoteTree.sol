// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {IPoseidon2} from "./interfaces/IPoseidon2.sol";

/// @title NoteTree
/// @notice Append-only incremental Merkle tree of note commitments, depth 24, Poseidon2 nodes.
///         Leaves are always inserted two at a time, so a pair shares one parent.
///         The last ROOT_HISTORY roots stay valid, so a proof built against a slightly
///         older root still verifies after other transactions land.
abstract contract NoteTree {
    uint256 public constant FIELD =
        21888242871839275222246405745257275088548364400416663434500807173575808495617;
    uint32 public constant DEPTH = 24;
    uint32 public constant ROOT_HISTORY = 64;
    uint32 public constant MAX_LEAVES = uint32(1) << DEPTH;

    /// @dev Set by the implementation's constructor (immutable), read by the proxy.
    IPoseidon2 internal immutable hasher;

    uint256[DEPTH] internal zeros;
    uint256[DEPTH] internal filledSubtrees;
    uint256[ROOT_HISTORY] public roots;
    uint32 public currentRootIndex;
    uint32 public nextIndex;

    error TreeFull();
    error NotAFieldElement();

    constructor(IPoseidon2 hasher_) {
        hasher = hasher_;
    }

    function _initTree() internal {
        uint256 z = 0;
        for (uint32 i = 0; i < DEPTH; i++) {
            zeros[i] = z;
            filledSubtrees[i] = z;
            z = hasher.hash_2(z, z);
        }
        roots[0] = z; // root of the empty tree
    }

    function _insertPair(uint256 leftLeaf, uint256 rightLeaf) internal returns (uint32 index) {
        if (leftLeaf >= FIELD || rightLeaf >= FIELD) revert NotAFieldElement();
        index = nextIndex;
        if (uint256(index) + 2 > MAX_LEAVES) revert TreeFull();

        uint256 current = hasher.hash_2(leftLeaf, rightLeaf); // level 1
        uint32 idx = index >> 1;
        for (uint32 level = 1; level < DEPTH; level++) {
            uint256 left;
            uint256 right;
            if (idx & 1 == 0) {
                left = current;
                right = zeros[level];
                filledSubtrees[level] = current;
            } else {
                left = filledSubtrees[level];
                right = current;
            }
            current = hasher.hash_2(left, right);
            idx >>= 1;
        }

        uint32 newRootIndex = (currentRootIndex + 1) % ROOT_HISTORY;
        currentRootIndex = newRootIndex;
        roots[newRootIndex] = current;
        nextIndex = index + 2;
    }

    function isKnownRoot(uint256 root) public view returns (bool) {
        if (root == 0) return false;
        uint32 i = currentRootIndex;
        do {
            if (roots[i] == root) return true;
            i = i == 0 ? ROOT_HISTORY - 1 : i - 1;
        } while (i != currentRootIndex);
        return false;
    }

    function getLastRoot() public view returns (uint256) {
        return roots[currentRootIndex];
    }

    function zeroAt(uint32 level) external view returns (uint256) {
        return zeros[level];
    }

    uint256[40] private __treeGap;
}
