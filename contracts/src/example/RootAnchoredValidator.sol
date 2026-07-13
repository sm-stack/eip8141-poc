// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {FrameTxLib} from "../FrameTxLib.sol";

/// @title RootAnchoredValidator
/// @notice Privacy-style EIP-8272 validator that binds a VERIFY frame to one recent root.
contract RootAnchoredValidator {
    bytes32 public immutable expectedSourceId;
    uint64 public immutable expectedSlot;
    bytes32 public immutable expectedRoot;

    address internal constant ENTRY_POINT = 0x00000000000000000000000000000000000000AA;

    error InvalidCaller();
    error InvalidReferenceCount();
    error InvalidSourceId();
    error InvalidSlot();
    error InvalidRoot();
    error InvalidApprovalScope();

    constructor(bytes32 sourceId, uint64 slot, bytes32 root) {
        expectedSourceId = sourceId;
        expectedSlot = slot;
        expectedRoot = root;
    }

    receive() external payable {}

    function validate() external view {
        if (msg.sender != ENTRY_POINT) revert InvalidCaller();
        if (FrameTxLib.recentRootReferenceCount() != 1) revert InvalidReferenceCount();
        if (FrameTxLib.recentRootRefLoad(FrameTxLib.RECENT_ROOT_FIELD_SOURCE_ID, 0) != expectedSourceId) {
            revert InvalidSourceId();
        }
        if (uint256(FrameTxLib.recentRootRefLoad(FrameTxLib.RECENT_ROOT_FIELD_SLOT, 0)) != expectedSlot) {
            revert InvalidSlot();
        }
        if (FrameTxLib.recentRootRefLoad(FrameTxLib.RECENT_ROOT_FIELD_ROOT, 0) != expectedRoot) {
            revert InvalidRoot();
        }
        uint8 scope = FrameTxLib.currentFrameAllowedScope();
        if (scope == 0) revert InvalidApprovalScope();
        FrameTxLib.approveEmpty(scope);
    }
}
