// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

/// @title FrameTxLib
/// @notice Typed wrappers for the EIP-8141 frame transaction opcodes.
/// @dev These opcodes are only valid while executing a frame transaction on an
///      EVM with EIP-8141 enabled.
library FrameTxLib {
    // APPROVE scope bitmask values.
    uint8 internal constant SCOPE_PAYMENT = 0x01;
    uint8 internal constant SCOPE_EXECUTION = 0x02;
    uint8 internal constant SCOPE_EXECUTION_AND_PAYMENT = 0x03;

    uint8 internal constant FRAME_FLAG_SCOPE_MASK = 0x03;
    uint8 internal constant FRAME_FLAG_ATOMIC_BATCH = 0x04;

    address internal constant EXPIRY_VERIFIER = 0x0000000000000000000000000000000000008141;
    address internal constant NONCE_MANAGER = 0x0000000000000000000000000000000000008250;
    address internal constant RECENT_ROOT = 0x0000000000000000000000000000000000008272;

    // TXPARAM selectors.
    uint8 internal constant TX_PARAM_TYPE = 0x00;
    uint8 internal constant TX_PARAM_NONCE = 0x01;
    uint8 internal constant TX_PARAM_SENDER = 0x02;
    uint8 internal constant TX_PARAM_GAS_TIP_CAP = 0x03;
    uint8 internal constant TX_PARAM_GAS_FEE_CAP = 0x04;
    uint8 internal constant TX_PARAM_BLOB_FEE_CAP = 0x05;
    uint8 internal constant TX_PARAM_MAX_COST = 0x06;
    uint8 internal constant TX_PARAM_BLOB_HASH_COUNT = 0x07;
    uint8 internal constant TX_PARAM_SIG_HASH = 0x08;
    uint8 internal constant TX_PARAM_FRAME_COUNT = 0x09;
    uint8 internal constant TX_PARAM_FRAME_INDEX = 0x0a;
    uint8 internal constant TX_PARAM_SIGNATURE_COUNT = 0x0b;
    uint8 internal constant TX_PARAM_NONCE_KEY_0 = 0x0c;
    uint8 internal constant TX_PARAM_LEGACY_NONCE = 0x0d;
    uint8 internal constant TX_PARAM_NONCE_KEY_COUNT = 0x0e;
    uint8 internal constant TX_PARAM_NONCE_KEYS_HASH = 0x0f;
    uint8 internal constant TX_PARAM_RECENT_ROOT_REF_COUNT = 0x10;

    uint8 internal constant RECENT_ROOT_FIELD_SOURCE_ID = 0x00;
    uint8 internal constant RECENT_ROOT_FIELD_SLOT = 0x01;
    uint8 internal constant RECENT_ROOT_FIELD_ROOT = 0x02;

    // FRAMEPARAM selectors.
    uint8 internal constant FRAME_PARAM_TARGET = 0x00;
    uint8 internal constant FRAME_PARAM_GAS_LIMIT = 0x01;
    uint8 internal constant FRAME_PARAM_MODE = 0x02;
    uint8 internal constant FRAME_PARAM_FLAGS = 0x03;
    uint8 internal constant FRAME_PARAM_DATA_LENGTH = 0x04;
    uint8 internal constant FRAME_PARAM_STATUS = 0x05;
    uint8 internal constant FRAME_PARAM_ALLOWED_SCOPE = 0x06;
    uint8 internal constant FRAME_PARAM_ATOMIC_BATCH = 0x07;
    uint8 internal constant FRAME_PARAM_VALUE = 0x08;

    // SIGPARAM selectors.
    uint8 internal constant SIG_PARAM_SIGNER = 0x00;
    uint8 internal constant SIG_PARAM_SCHEME = 0x01;
    uint8 internal constant SIG_PARAM_MSG = 0x02;
    uint8 internal constant SIG_PARAM_SIGNATURE_LENGTH = 0x03;

    uint8 internal constant SIGNATURE_SCHEME_SECP256K1 = 0x00;
    uint8 internal constant SIGNATURE_SCHEME_P256 = 0x01;

    /// @notice APPROVE with return data from memory.
    function approveWithData(bytes memory data, uint8 scope) internal pure {
        assembly {
            approve(add(data, 0x20), mload(data), scope)
        }
    }

    /// @notice APPROVE with empty return data.
    function approveEmpty(uint8 scope) internal pure {
        assembly {
            approve(0, 0, scope)
        }
    }

    /// @notice Read a transaction parameter.
    function txParam(uint256 param) internal pure returns (bytes32 result) {
        assembly {
            result := txparam(param)
        }
    }

    /// @notice Read a frame parameter.
    function frameParam(uint256 param, uint256 frameIndex) internal pure returns (bytes32 result) {
        assembly {
            result := frameparam(param, frameIndex)
        }
    }

    /// @notice Load a 32-byte word from frame calldata.
    function frameDataLoad(uint256 offset, uint256 frameIndex) internal pure returns (bytes32 result) {
        assembly {
            result := framedataload(offset, frameIndex)
        }
    }

    /// @notice Copy frame calldata into memory.
    function frameDataCopy(uint256 memoryOffset, uint256 dataOffset, uint256 length, uint256 frameIndex) internal pure {
        assembly {
            framedatacopy(memoryOffset, dataOffset, length, frameIndex)
        }
    }

    /// @notice Read transaction-level signature metadata.
    function sigParam(uint256 param, uint256 signatureIndex) internal pure returns (bytes32 result) {
        assembly {
            result := sigparam(param, signatureIndex)
        }
    }

    /// @notice Read a field from an EIP-8272 recent-root reference.
    function recentRootRefLoad(uint256 field, uint256 referenceIndex) internal pure returns (bytes32 result) {
        assembly {
            result := recentrootrefload(field, referenceIndex)
        }
    }

    function sigHash() internal pure returns (bytes32) {
        return txParam(TX_PARAM_SIG_HASH);
    }

    function txSender() internal pure returns (address) {
        return address(uint160(uint256(txParam(TX_PARAM_SENDER))));
    }

    function nonce() internal pure returns (uint256) {
        return nonceSeq();
    }

    function nonceSeq() internal pure returns (uint256) {
        return uint256(txParam(TX_PARAM_NONCE));
    }

    function nonceKey0() internal pure returns (uint256) {
        return uint256(txParam(TX_PARAM_NONCE_KEY_0));
    }

    function legacyNonce() internal pure returns (uint256) {
        return uint256(txParam(TX_PARAM_LEGACY_NONCE));
    }

    function nonceKeyCount() internal pure returns (uint256) {
        return uint256(txParam(TX_PARAM_NONCE_KEY_COUNT));
    }

    function nonceKeysHash() internal pure returns (bytes32) {
        return txParam(TX_PARAM_NONCE_KEYS_HASH);
    }

    function recentRootReferenceCount() internal pure returns (uint256) {
        return uint256(txParam(TX_PARAM_RECENT_ROOT_REF_COUNT));
    }

    function frameCount() internal pure returns (uint256) {
        return uint256(txParam(TX_PARAM_FRAME_COUNT));
    }

    function currentFrameIndex() internal pure returns (uint256) {
        return uint256(txParam(TX_PARAM_FRAME_INDEX));
    }

    function signatureCount() internal pure returns (uint256) {
        return uint256(txParam(TX_PARAM_SIGNATURE_COUNT));
    }

    function maxCost() internal pure returns (uint256) {
        return uint256(txParam(TX_PARAM_MAX_COST));
    }

    function frameTarget(uint256 frameIndex) internal pure returns (address) {
        return address(uint160(uint256(frameParam(FRAME_PARAM_TARGET, frameIndex))));
    }

    function frameGasLimit(uint256 frameIndex) internal pure returns (uint256) {
        return uint256(frameParam(FRAME_PARAM_GAS_LIMIT, frameIndex));
    }

    function frameMode(uint256 frameIndex) internal pure returns (uint8) {
        return uint8(uint256(frameParam(FRAME_PARAM_MODE, frameIndex)));
    }

    function frameFlags(uint256 frameIndex) internal pure returns (uint8) {
        return uint8(uint256(frameParam(FRAME_PARAM_FLAGS, frameIndex)));
    }

    function frameDataSize(uint256 frameIndex) internal pure returns (uint256) {
        return uint256(frameParam(FRAME_PARAM_DATA_LENGTH, frameIndex));
    }

    /// @dev FRAMEPARAM status is only valid for an earlier frame.
    function frameStatus(uint256 frameIndex) internal pure returns (uint8) {
        return uint8(uint256(frameParam(FRAME_PARAM_STATUS, frameIndex)));
    }

    function frameAllowedScope(uint256 frameIndex) internal pure returns (uint8) {
        return uint8(uint256(frameParam(FRAME_PARAM_ALLOWED_SCOPE, frameIndex)));
    }

    function frameAtomicBatch(uint256 frameIndex) internal pure returns (bool) {
        return uint256(frameParam(FRAME_PARAM_ATOMIC_BATCH, frameIndex)) != 0;
    }

    function frameValue(uint256 frameIndex) internal pure returns (uint256) {
        return uint256(frameParam(FRAME_PARAM_VALUE, frameIndex));
    }

    function currentFrameMode() internal pure returns (uint8) {
        return frameMode(currentFrameIndex());
    }

    function currentFrameAllowedScope() internal pure returns (uint8) {
        return frameAllowedScope(currentFrameIndex());
    }

    function currentFrameValue() internal pure returns (uint256) {
        return frameValue(currentFrameIndex());
    }

    function frameData(uint256 frameIndex) internal pure returns (bytes memory result) {
        uint256 size = frameDataSize(frameIndex);
        result = new bytes(size);
        uint256 memoryOffset;
        assembly {
            memoryOffset := add(result, 0x20)
        }
        frameDataCopy(memoryOffset, 0, size, frameIndex);
    }

    function signatureSigner(uint256 signatureIndex) internal pure returns (address) {
        return address(uint160(uint256(sigParam(SIG_PARAM_SIGNER, signatureIndex))));
    }

    function signatureScheme(uint256 signatureIndex) internal pure returns (uint8) {
        return uint8(uint256(sigParam(SIG_PARAM_SCHEME, signatureIndex)));
    }

    /// @notice Return zero for a canonical sig-hash signature, or its explicit message.
    function signatureMessage(uint256 signatureIndex) internal pure returns (bytes32) {
        return sigParam(SIG_PARAM_MSG, signatureIndex);
    }

    function signatureLength(uint256 signatureIndex) internal pure returns (uint256) {
        return uint256(sigParam(SIG_PARAM_SIGNATURE_LENGTH, signatureIndex));
    }

    /// @notice Encode the expiry verifier deadline as canonical 8-byte big-endian data.
    function encodeExpiryDeadline(uint64 deadline) internal pure returns (bytes memory) {
        return abi.encodePacked(deadline);
    }
}
