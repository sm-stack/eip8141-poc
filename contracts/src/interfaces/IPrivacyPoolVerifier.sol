// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

/// @title IPrivacyPoolVerifier
/// @notice Proof verifier interface used by the EIP-8141 privacy-pool PoC.
interface IPrivacyPoolVerifier {
    /// @dev The proof must bind root, nullifierHash, and the withdrawal statement hash.
    function verifyProof(bytes calldata proof, bytes32 root, bytes32 nullifierHash, bytes32 statementHash)
        external
        view
        returns (bool);
}
