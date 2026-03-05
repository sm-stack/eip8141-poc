// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {FrameTxLib} from "../../FrameTxLib.sol";

/// @title MLDSA8141Account
/// @notice Post-quantum EIP-8141 smart account using ML-DSA-ETH (EIP-8051) signature verification.
///
/// @dev Uses the VERIFY_MLDSA_ETH precompile at address 0x13 (Keccak PRNG variant).
///
///   The expanded public key (20,512 bytes) is stored in sequential storage slots 0..640.
///   Layout: A_hat (16,384 B) + tr (32 B) + t1_NTT (4,096 B)
///
///   Precompile input format (22,964 bytes):
///     msg (32 B) + signature (2,420 B) + expanded_pk (20,512 B)
///
///   Frame transaction pattern:
///     Frame 0: VERIFY(account) → validate(signature, scope) → APPROVE
///     Frame 1: SENDER(target)  → execute(target, value, data)
contract MLDSA8141Account {
    /// @dev EIP-8141 ENTRY_POINT address — the caller in VERIFY/DEFAULT frames.
    address internal constant ENTRY_POINT = 0x00000000000000000000000000000000000000AA;

    /// @dev VERIFY_MLDSA_ETH precompile (EIP-8051, Keccak PRNG variant).
    address internal constant MLDSA_ETH = address(0x13);

    uint256 internal constant PK_SIZE = 20512;
    uint256 internal constant PK_SLOTS = 641;
    uint256 internal constant SIG_SIZE = 2420;
    uint256 internal constant PRECOMPILE_INPUT_SIZE = 22964; // 32 + 2420 + 20512

    error InvalidCaller();
    error InvalidSignature();
    error ExecutionFailed();

    /// @notice Deploy with the expanded ML-DSA public key.
    /// @param expandedPK The 20,512-byte expanded public key (A_hat + tr + t1_NTT).
    constructor(bytes memory expandedPK) {
        require(expandedPK.length == PK_SIZE);
        assembly {
            let src := add(expandedPK, 0x20) // skip length prefix
            for { let i := 0 } lt(i, 641) { i := add(i, 1) } {
                sstore(i, mload(add(src, mul(i, 32))))
            }
        }
    }

    /// @notice Validation entry point, called in a VERIFY frame.
    /// @param signature ML-DSA-ETH signature (2,420 bytes: c_tilde + z + h).
    /// @param scope Approval scope: 0=execution, 1=payment, 2=both.
    function validate(bytes calldata signature, uint8 scope) external view {
        if (msg.sender != ENTRY_POINT) revert InvalidCaller();
        if (signature.length != SIG_SIZE) revert InvalidSignature();

        bytes32 sigHash = FrameTxLib.sigHash();

        assembly {
            // Allocate precompile input buffer (22,964 bytes)
            let ptr := mload(0x40)

            // 1. Store sigHash as message (32 bytes)
            mstore(ptr, sigHash)

            // 2. Copy signature from calldata (2,420 bytes)
            calldatacopy(add(ptr, 32), signature.offset, 2420)

            // 3. Load expanded PK from storage (641 slots × 32 bytes)
            for { let i := 0 } lt(i, 641) { i := add(i, 1) } {
                mstore(add(add(ptr, 2452), mul(i, 32)), sload(i))
            }

            // 4. staticcall to VERIFY_MLDSA_ETH precompile (0x13)
            let ok := staticcall(gas(), 0x13, ptr, 22964, ptr, 32)

            // 5. Check call succeeded and result == 1 (valid signature)
            if iszero(ok) {
                mstore(0, 0x8baa579f) // InvalidSignature()
                revert(0x1c, 4)
            }
            if iszero(eq(mload(ptr), 1)) {
                mstore(0, 0x8baa579f) // InvalidSignature()
                revert(0x1c, 4)
            }
        }

        FrameTxLib.approveEmpty(scope);
    }

    /// @notice Execution entry point, called in a SENDER frame.
    /// @param target Address to call.
    /// @param value ETH value to send.
    /// @param data Calldata for the target call.
    function execute(address target, uint256 value, bytes calldata data) external {
        if (msg.sender != address(this)) revert InvalidCaller();

        (bool success,) = target.call{value: value}(data);
        if (!success) revert ExecutionFailed();
    }

    receive() external payable {}
}
