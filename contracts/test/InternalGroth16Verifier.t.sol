// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {TestBase} from "./TestBase.sol";
import {IGroth16WithdrawalVerifier} from "../src/privacy/Groth16PrivacyPoolVerifier.sol";

interface IInternalVerifierContinuation {
    function verifyAndContinue(
        uint256[2] calldata a,
        uint256[2][2] calldata b,
        uint256[2] calldata c,
        uint256[3] calldata inputs
    ) external view returns (bool valid, bytes32 beforeHash, bytes32 afterHash);
}

contract InternalGroth16VerifierTest is TestBase {
    uint256 constant FIELD = 21888242871839275222246405745257275088548364400416034343698204186575808495617;
    uint256 constant BASE_FIELD = 21888242871839275222246405745257275088696311157297823662689037894645226208583;
    IGroth16WithdrawalVerifier referenceVerifier;
    IGroth16WithdrawalVerifier internalVerifier;
    string fixture;

    struct Vector {
        uint256[2] a;
        uint256[2][2] b;
        uint256[2] c;
        uint256[3] inputs;
    }

    function setUp() public {
        fixture = vm.readFile("privacy-pool/build/fixture.json");
        referenceVerifier = IGroth16WithdrawalVerifier(_deploy("privacy-pool/build/verifier.json"));
        internalVerifier = IGroth16WithdrawalVerifier(_deploy("privacy-pool/build/internal-verifier.json"));
    }

    function _deploy(string memory path) private returns (address target) {
        bytes memory code = vm.parseJsonBytes(vm.readFile(path), ".bytecode");
        assembly { target := create(0, add(code, 32), mload(code)) }
        require(target != address(0), "verifier deployment failed");
    }

    function _vector(string memory prefix) private view returns (Vector memory v) {
        (v.a, v.b, v.c) = abi.decode(
            vm.parseJsonBytes(fixture, string.concat(prefix, ".proof")), (uint256[2], uint256[2][2], uint256[2])
        );
        v.inputs = [
            uint256(vm.parseJsonBytes32(fixture, string.concat(prefix, ".root"))),
            uint256(vm.parseJsonBytes32(fixture, string.concat(prefix, ".nullifierHash"))),
            uint256(vm.parseJsonBytes32(fixture, string.concat(prefix, ".context"))) % FIELD
        ];
    }

    function _same(Vector memory v) private returns (bool valid) {
        valid = referenceVerifier.verifyProof{gas: 1_000_000}(v.a, v.b, v.c, v.inputs);
        assertEq(internalVerifier.verifyProof{gas: 1_000_000}(v.a, v.b, v.c, v.inputs), valid);
    }

    function _continues(Vector memory v, bool expected) private {
        (bool valid, bytes32 beforeHash, bytes32 afterHash) = IInternalVerifierContinuation(address(internalVerifier))
        .verifyAndContinue{gas: 1_000_000}(
            v.a, v.b, v.c, v.inputs
        );
        assertEq(valid, expected);
        assertEq(beforeHash, keccak256(abi.encode(v.a, v.b, v.c, v.inputs)));
        assertEq(afterHash, beforeHash);
    }

    function test_validProofsMatchAndReturnToCaller() public {
        Vector memory v = _vector("");
        assertTrue(_same(v));
        _continues(v, true);
        for (uint256 i; i < 3; ++i) {
            v = _vector(string.concat(".vectors[", vm.toString(i), "]"));
            assertTrue(_same(v));
            _continues(v, true);
        }
    }

    function test_invalidPublicInputsReturnFalseWithoutTerminatingCaller() public {
        for (uint256 i; i < 3; ++i) {
            Vector memory v = _vector("");
            v.inputs[i] = (v.inputs[i] + 1) % FIELD;
            assertFalse(_same(v));
            _continues(v, false);
            v.inputs[i] = FIELD;
            assertFalse(_same(v));
            _continues(v, false);
            v.inputs[i] = type(uint256).max;
            assertFalse(_same(v));
            _continues(v, false);
        }
    }

    function test_invalidCurvePointAndInfinityReturnToCaller() public {
        Vector memory v = _vector("");
        v.a[0] = BASE_FIELD;
        assertFalse(_same(v));
        _continues(v, false);
        v = _vector("");
        v.b[0][0] = BASE_FIELD;
        assertFalse(_same(v));
        _continues(v, false);
        v = _vector("");
        v.c[0] = BASE_FIELD;
        assertFalse(_same(v));
        _continues(v, false);
        delete v.a;
        delete v.b;
        delete v.c;
        assertFalse(_same(v));
        _continues(v, false);
    }

    function test_insufficientGasCannotApprove() public {
        Vector memory v = _vector("");
        bytes memory data = abi.encodeCall(IGroth16WithdrawalVerifier.verifyProof, (v.a, v.b, v.c, v.inputs));
        uint256[3] memory budgets = [uint256(20_000), 50_000, 180_000];
        for (uint256 i; i < budgets.length; ++i) {
            (bool ok, bytes memory result) = address(internalVerifier).staticcall{gas: budgets[i]}(data);
            assertFalse(ok && result.length == 32 && abi.decode(result, (bool)));
        }
    }

    function testFuzz_matchesReferenceOnEveryProofAndPublicInputWord(uint8 index, uint256 value) public {
        Vector memory v = _vector("");
        uint256 i = uint256(index) % 11;
        if (i < 2) v.a[i] = value;
        else if (i < 6) v.b[(i - 2) / 2][(i - 2) % 2] = value;
        else if (i < 8) v.c[i - 6] = value;
        else v.inputs[i - 8] = value;
        bool valid = _same(v);
        _continues(v, valid);
    }
}
