// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {IPrivacyPoolVerifier} from "../interfaces/IPrivacyPoolVerifier.sol";

interface IGroth16WithdrawalVerifier {
    function verifyProof(
        uint256[2] calldata a,
        uint256[2][2] calldata b,
        uint256[2] calldata c,
        uint256[3] calldata inputs
    ) external view returns (bool);
}

// External-call adapter for tooling and reference tests. The production pool
// uses the generated internal verifier and does not include this call path.
library Groth16ProofLib {
    uint256 internal constant FIELD = 21888242871839275222246405745257275088548364400416034343698204186575808495617;

    function verify(
        IGroth16WithdrawalVerifier target,
        bytes calldata proof,
        bytes32 root,
        bytes32 nullifierHash,
        bytes32 statementHash
    ) internal view returns (bool) {
        if (proof.length != 256 || uint256(root) >= FIELD || uint256(nullifierHash) >= FIELD) {
            return false;
        }
        // A/B/C are already ABI words. Copy once instead of decoding three
        // arrays and allocating/encoding them again for the self-call.
        uint256 selector = uint32(IGroth16WithdrawalVerifier.verifyProof.selector);
        bool valid;
        assembly ("memory-safe") {
            let p := mload(0x40)
            mstore(p, shl(224, selector))
            calldatacopy(add(p, 4), proof.offset, 256)
            mstore(add(p, 260), root)
            mstore(add(p, 292), nullifierHash)
            mstore(add(p, 324), mod(statementHash, FIELD))
            let success := staticcall(gas(), target, p, 356, p, 32)
            valid := and(success, and(eq(returndatasize(), 32), eq(mload(p), 1)))
            mstore(0x40, add(p, 384))
        }
        return valid;
    }
}

/// @notice Standalone adapter for tooling/tests. The deployed pool embeds the
/// verifier instead: external code calls would start the revalidation watershed.
contract Groth16PrivacyPoolVerifier is IPrivacyPoolVerifier {
    IGroth16WithdrawalVerifier public immutable groth16;

    constructor(IGroth16WithdrawalVerifier target) {
        require(address(target).code.length != 0, "missing verifier code");
        groth16 = target;
    }

    function verifyProof(bytes calldata proof, bytes32 root, bytes32 nullifierHash, bytes32 statementHash)
        external
        view
        returns (bool)
    {
        return Groth16ProofLib.verify(groth16, proof, root, nullifierHash, statementHash);
    }
}
