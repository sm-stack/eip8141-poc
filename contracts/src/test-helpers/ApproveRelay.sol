// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

/// @title ApproveRelay
/// @notice Minimal contract that calls APPROVE on behalf of a caller.
///         Used to test that APPROVE from an inner call (ADDRESS != frame.target)
///         is correctly rejected by the protocol.
contract ApproveRelay {
    function relay(uint8 scope) external view {
        assembly {
            approve(0, 0, scope)
        }
    }
}
