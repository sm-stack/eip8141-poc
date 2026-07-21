// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {IPrivacyPoolVerifier} from "../interfaces/IPrivacyPoolVerifier.sol";

/// @notice Devnet verifier that requires the proof to encode every supplied public input.
contract ProofBoundPrivacyPoolVerifier is IPrivacyPoolVerifier {
    function verifyProof(bytes calldata proof, bytes32 root, bytes32 nullifierHash, bytes32 statementHash)
        external
        pure
        returns (bool)
    {
        return proof.length == 96 && keccak256(proof) == keccak256(abi.encode(root, nullifierHash, statementHash));
    }
}
