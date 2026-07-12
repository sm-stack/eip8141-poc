// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {FrameTxLib} from "../FrameTxLib.sol";

/// @title NullifierValidator
/// @notice EIP-8250 example that binds a transaction to a single-use nonce-key set.
/// @dev The expected hash is keccak256(bytes32(keyCount) || bytes32(key0) || ...).
contract NullifierValidator {
    uint256 public immutable expectedKeyCount;
    bytes32 public immutable expectedKeysHash;

    address internal constant ENTRY_POINT = 0x00000000000000000000000000000000000000AA;

    error InvalidCaller();
    error InvalidKeyCount();
    error InvalidKeysHash();
    error InvalidNonceSequence();
    error InvalidApprovalScope();

    constructor(uint256 keyCount, bytes32 keysHash) {
        if (keyCount == 0 || keyCount > 16) revert InvalidKeyCount();
        expectedKeyCount = keyCount;
        expectedKeysHash = keysHash;
    }

    function validate() external view {
        if (msg.sender != ENTRY_POINT) revert InvalidCaller();
        if (FrameTxLib.nonceKeyCount() != expectedKeyCount) revert InvalidKeyCount();
        if (FrameTxLib.nonceKeysHash() != expectedKeysHash) revert InvalidKeysHash();
        if (FrameTxLib.nonceSeq() != 0) revert InvalidNonceSequence();

        uint8 scope = FrameTxLib.currentFrameAllowedScope();
        if (scope == 0) revert InvalidApprovalScope();
        FrameTxLib.approveEmpty(scope);
    }
}
