// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

/// @title WebAuthn
/// @notice WebAuthn signature verification for passkeys
/// @dev Implements P256 (secp256r1) signature verification for WebAuthn
library WebAuthn {
    /// @notice WebAuthn authentication data
    struct WebAuthnAuth {
        bytes authenticatorData;
        bytes clientDataJSON;
        uint256 challengeIndex;
        uint256 typeIndex;
        uint256 r;
        uint256 s;
    }

    /// @notice P256 verification precompile address (RIP-7212)
    /// @dev Address 0x100 is reserved for P256VERIFY precompile
    address internal constant P256_VERIFIER = address(0x100);

    /// @notice Verify WebAuthn signature
    /// @param challenge The challenge (usually the message hash)
    /// @param requireUV Whether to require user verification
    /// @param webAuthnAuth The WebAuthn authentication data
    /// @param x The x-coordinate of the public key
    /// @param y The y-coordinate of the public key
    /// @return success True if the signature is valid
    function verify(
        bytes memory challenge,
        bool requireUV,
        WebAuthnAuth memory webAuthnAuth,
        uint256 x,
        uint256 y
    ) internal view returns (bool) {
        // 1. Verify authenticatorData flags
        if (requireUV) {
            // Bit 2 (0x04) = User Verified
            if (webAuthnAuth.authenticatorData.length < 37) return false;
            bytes1 flags = webAuthnAuth.authenticatorData[32];
            if ((flags & 0x04) != 0x04) return false;
        }

        // 2. Extract challenge from clientDataJSON
        if (!_verifyClientData(webAuthnAuth.clientDataJSON, challenge, webAuthnAuth.challengeIndex, webAuthnAuth.typeIndex)) {
            return false;
        }

        // 3. Construct the message to verify
        bytes32 clientDataHash = sha256(webAuthnAuth.clientDataJSON);
        bytes memory message = abi.encodePacked(webAuthnAuth.authenticatorData, clientDataHash);
        bytes32 messageHash = sha256(message);

        // 4. Verify P256 signature using precompile
        return _verifyP256Signature(messageHash, webAuthnAuth.r, webAuthnAuth.s, x, y);
    }

    /// @notice Verify client data JSON contains the expected challenge
    function _verifyClientData(
        bytes memory clientDataJSON,
        bytes memory challenge,
        uint256 challengeIndex,
        uint256 typeIndex
    ) private pure returns (bool) {
        // Verify type is "webauthn.get"
        bytes memory webauthnType = bytes('"type":"webauthn.get"');
        if (clientDataJSON.length < typeIndex + webauthnType.length) return false;

        for (uint256 i = 0; i < webauthnType.length; i++) {
            if (clientDataJSON[typeIndex + i] != webauthnType[i]) return false;
        }

        // Verify challenge
        // Challenge is base64url encoded in clientDataJSON
        bytes memory challengeBase64 = _base64UrlEncode(challenge);
        bytes memory challengeKey = bytes('"challenge":"');

        if (clientDataJSON.length < challengeIndex + challengeKey.length + challengeBase64.length) {
            return false;
        }

        // Check "challenge":"
        for (uint256 i = 0; i < challengeKey.length; i++) {
            if (clientDataJSON[challengeIndex + i] != challengeKey[i]) return false;
        }

        // Check base64url encoded challenge
        uint256 challengeStart = challengeIndex + challengeKey.length;
        for (uint256 i = 0; i < challengeBase64.length; i++) {
            if (clientDataJSON[challengeStart + i] != challengeBase64[i]) return false;
        }

        return true;
    }

    /// @notice Verify P256 signature using RIP-7212 precompile
    function _verifyP256Signature(
        bytes32 messageHash,
        uint256 r,
        uint256 s,
        uint256 x,
        uint256 y
    ) private view returns (bool) {
        // Use P256VERIFY precompile (RIP-7212) at address 0x100
        // Note: precompiles don't have code, so extcodesize check is skipped
        bytes memory input = abi.encodePacked(messageHash, r, s, x, y);
        (bool success, bytes memory result) = P256_VERIFIER.staticcall(input);
        if (success && result.length == 32) {
            return abi.decode(result, (uint256)) == 1;
        }
        return false;
    }

    /// @notice Base64URL encode (without padding)
    function _base64UrlEncode(bytes memory data) private pure returns (bytes memory) {
        bytes memory base64Chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";

        uint256 encodedLen = 4 * ((data.length + 2) / 3);
        bytes memory result = new bytes(encodedLen);

        uint256 i = 0;
        uint256 j = 0;

        while (i < data.length) {
            uint256 a = i < data.length ? uint8(data[i++]) : 0;
            uint256 b = i < data.length ? uint8(data[i++]) : 0;
            uint256 c = i < data.length ? uint8(data[i++]) : 0;

            uint256 triple = (a << 16) | (b << 8) | c;

            result[j++] = base64Chars[(triple >> 18) & 0x3F];
            result[j++] = base64Chars[(triple >> 12) & 0x3F];
            result[j++] = base64Chars[(triple >> 6) & 0x3F];
            result[j++] = base64Chars[triple & 0x3F];
        }

        // Remove padding (base64url doesn't use padding)
        uint256 paddingLen = (3 - (data.length % 3)) % 3;
        if (paddingLen > 0) {
            bytes memory trimmed = new bytes(encodedLen - paddingLen);
            for (uint256 k = 0; k < trimmed.length; k++) {
                trimmed[k] = result[k];
            }
            return trimmed;
        }

        return result;
    }

}
