// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Base64} from "solady/utils/Base64.sol";

/// @notice Bounded, top-level ES256 assertion profile. Unknown JSON fields,
/// extensions and cross-origin ceremonies are intentionally unsupported.
library StrictWebAuthn {
    struct Assertion {
        bytes authenticatorData;
        bytes clientDataJSON;
        uint256 r;
        uint256 s;
    }

    uint256 internal constant P = 0xffffffff00000001000000000000000000000000ffffffffffffffffffffffff;
    uint256 internal constant B = 0x5ac635d8aa3a93e7b3ebbd55769886bc651d06b0cc53b0f63bce3c3e27d2604b;

    function validPublicKey(uint256 x, uint256 y) internal pure returns (bool) {
        if (x >= P || y >= P || (x == 0 && y == 0)) return false;
        return mulmod(y, y, P) == addmod(addmod(mulmod(mulmod(x, x, P), x, P), P - mulmod(3, x, P), P), B, P);
    }

    /// @notice Check the WebAuthn ceremony policy and return the digest the
    /// authenticator signed. The caller must separately establish that a P-256
    /// signature over `digest` exists: either with `verifyP256`, or by matching
    /// an EIP-8141 protocol-validated `P256` signature entry's explicit `msg`.
    function assertionDigest(
        bytes32 challenge,
        bytes32 rpIdHash,
        bytes32 suffixHash,
        bytes32 legacySuffixHash,
        bytes calldata authenticatorData,
        bytes calldata clientDataJSON
    ) internal view returns (bool ok, bytes32 digest) {
        // 32-byte RP hash + flags + 4-byte counter; no attestation or extensions.
        if (authenticatorData.length != 37 || clientDataJSON.length > 512) return (false, 0);
        if (bytes32(authenticatorData[:32]) != rpIdHash) return (false, 0);
        uint8 flags = uint8(authenticatorData[32]);
        if (flags & 5 != 5 || flags & 0xe2 != 0 || (flags & 0x10 != 0 && flags & 8 == 0)) return (false, 0);
        bytes memory prefix = abi.encodePacked(
            '{"type":"webauthn.get","challenge":"', Base64.encode(abi.encodePacked(challenge), true, true)
        );
        if (clientDataJSON.length <= prefix.length) return (false, 0);
        if (keccak256(clientDataJSON[:prefix.length]) != keccak256(prefix)) return (false, 0);
        bytes32 suffix = keccak256(clientDataJSON[prefix.length:]);
        if (suffix != suffixHash && suffix != legacySuffixHash) return (false, 0);
        return (true, sha256(abi.encodePacked(authenticatorData, sha256(clientDataJSON))));
    }

    function verify(
        bytes32 challenge,
        bytes32 rpIdHash,
        bytes32 suffixHash,
        bytes32 legacySuffixHash,
        Assertion calldata a,
        uint256 x,
        uint256 y
    ) internal view returns (bool) {
        (bool ok, bytes32 digest) =
            assertionDigest(challenge, rpIdHash, suffixHash, legacySuffixHash, a.authenticatorData, a.clientDataJSON);
        return ok && verifyP256(digest, a.r, a.s, x, y);
    }

    // In-EVM path, unused by PasskeyAccount8141 (which relies on the protocol
    // signature). No software fallback or code-identity read before the
    // precompile. Both high-S and low-S signatures are accepted, as specified
    // by EIP-7951; the EIP-8141 protocol scheme accepts low-S only.
    function verifyP256(bytes32 digest, uint256 r, uint256 s, uint256 x, uint256 y) internal view returns (bool valid) {
        assembly ("memory-safe") {
            let p := mload(0x40)
            mstore(p, digest)
            mstore(add(p, 32), r)
            mstore(add(p, 64), s)
            mstore(add(p, 96), x)
            mstore(add(p, 128), y)
            let ok := staticcall(gas(), 0x100, p, 160, p, 32)
            valid := and(and(ok, eq(returndatasize(), 32)), eq(mload(p), 1))
        }
    }
}
