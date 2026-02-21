// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {IModule8141} from "./IModule8141.sol";

/// @title IPolicy8141
/// @notice Policy interface for Kernel8141 permission system.
/// @dev Policies enforce fine-grained constraints on permission-based validation.
///      EIP-8141 native: checkFrameTxPolicy can use FrameTxLib.frameDataLoad()
///      to read SENDER frame data (target, value, calldata) directly, which is
///      more powerful than Kernel v3's PackedUserOperation-based approach.
interface IPolicy8141 is IModule8141 {
    /// @notice Validate a frame transaction against this policy.
    /// @dev Called during permission-based VERIFY frame validation.
    ///      The policy can use FrameTxLib.frameDataLoad(senderFrameIndex, offset)
    ///      to read SENDER frame's target, value, and calldata.
    /// @param id The permission identifier (bytes32 for storage key derivation)
    /// @param account The smart account address being validated
    /// @param sigHash The canonical signature hash from TXPARAMLOAD(0x08)
    /// @param senderFrameIndex The index of the SENDER frame for cross-frame reading
    /// @return result 0 for success, 1 for failure (matches ERC-4337 convention)
    function checkFrameTxPolicy(bytes32 id, address account, bytes32 sigHash, uint256 senderFrameIndex)
        external
        payable
        returns (uint256 result);

    /// @notice Validate an ERC-1271 signature against this policy.
    /// @dev Called during permission-based ERC-1271 signature validation.
    /// @param id The permission identifier
    /// @param sender The address requesting the signature check
    /// @param hash The hash of the data that is signed
    /// @param sig The signature data
    /// @return result 0 for success, 1 for failure
    function checkSignaturePolicy(bytes32 id, address sender, bytes32 hash, bytes calldata sig)
        external
        view
        returns (uint256 result);
}
