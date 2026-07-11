// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {FrameTxLib} from "./FrameTxLib.sol";

/// @title Simple8141Account
/// @notice Minimal EIP-8141 smart account with single-owner ECDSA validation.
///
/// @dev Supports two frame transaction patterns:
///
///   Example 1 — Simple Transaction:
///     Frame 0: VERIFY(sender, flags=3) → validate(signatureIndex) → APPROVE(both)
///     Frame 1: SENDER(target)  → execute(target, value, data)
///
///   Example 2 — Sponsored Transaction:
///     Frame 0: VERIFY(sender, flags=2) → validate(signatureIndex) → APPROVE(execution)
///     Frame 1: VERIFY(sponsor) → sponsor.validate()          → APPROVE(payment)
///     Frame 2: SENDER(erc20)   → token.transfer(sponsor, fee)
///     Frame 3: SENDER(target)  → execute(target, value, data)
contract Simple8141Account {
    address public owner;

    /// @dev EIP-8141 ENTRY_POINT address — the caller in VERIFY/DEFAULT frames.
    address internal constant ENTRY_POINT = 0x00000000000000000000000000000000000000AA;

    error InvalidCaller();
    error InvalidSignature();
    error InvalidApprovalScope();
    error ExecutionFailed();

    constructor(address _owner) {
        owner = _owner;
    }

    /// @notice Approve a protocol-verified transaction-level secp256k1 signature.
    /// @param signatureIndex Index into tx.signatures.
    /// @dev The protocol verifies the raw signature before execution. This function
    ///      checks that its metadata names this account's owner and uses the canonical
    ///      transaction sig hash, then approves the scope allowed by frame.flags.
    ///      This function does NOT return — APPROVE terminates execution like RETURN.
    function validate(uint256 signatureIndex) external view {
        if (msg.sender != ENTRY_POINT) revert InvalidCaller();
        if (signatureIndex >= FrameTxLib.signatureCount()) revert InvalidSignature();
        if (FrameTxLib.signatureScheme(signatureIndex) != FrameTxLib.SIGNATURE_SCHEME_SECP256K1) {
            revert InvalidSignature();
        }
        if (FrameTxLib.signatureSigner(signatureIndex) != owner) revert InvalidSignature();
        if (FrameTxLib.signatureMessage(signatureIndex) != bytes32(0)) revert InvalidSignature();

        uint8 scope = FrameTxLib.currentFrameAllowedScope();
        if (scope == 0) revert InvalidApprovalScope();
        FrameTxLib.approveEmpty(scope);
    }

    /// @notice Execution entry point, called in a SENDER frame.
    /// @param target Address to call
    /// @param value ETH value to send
    /// @param data Calldata for the target call
    /// @dev In a SENDER frame, msg.sender == tx.sender == address(this).
    function execute(address target, uint256 value, bytes calldata data) external payable {
        if (msg.sender != address(this)) revert InvalidCaller();

        (bool success,) = target.call{value: value}(data);
        if (!success) revert ExecutionFailed();
    }

    receive() external payable {}
}
