// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {TestBase} from "./TestBase.sol";
import {PrivacyPool8141, IPoseidon2} from "../src/example/PrivacyPool8141.sol";
import {Groth16PrivacyPoolVerifier, IGroth16WithdrawalVerifier} from "../src/privacy/Groth16PrivacyPoolVerifier.sol";

contract PrivacyPool8141Test is TestBase {
    uint256 constant D = 1 ether;
    PrivacyPool8141 pool;
    Groth16PrivacyPoolVerifier verifier;
    IPoseidon2 hasher;
    string fixture;

    function setUp() public {
        fixture = vm.readFile("privacy-pool/build/fixture.json");
        hasher = IPoseidon2(_deploy(vm.parseJsonBytes(vm.readFile("privacy-pool/build/poseidon.json"), ".bytecode")));
        pool = PrivacyPool8141(
            _deploy(
                bytes.concat(
                    vm.parseJsonBytes(vm.readFile("privacy-pool/build/pool.json"), ".bytecode"), abi.encode(hasher, D)
                )
            )
        );
        verifier = new Groth16PrivacyPoolVerifier(
            IGroth16WithdrawalVerifier(
                _deploy(vm.parseJsonBytes(vm.readFile("privacy-pool/build/internal-verifier.json"), ".bytecode"))
            )
        );
        vm.deal(address(this), 20 ether);
    }

    function _deploy(bytes memory code) private returns (address target) {
        assembly { target := create(0, add(code, 32), mload(code)) }
        require(target != address(0), "fixture deployment failed");
    }

    function testFuzz_statementAndNonceHashesMatchAbiEncoding(
        PrivacyPool8141.WithdrawalIntent memory intent
    ) public {
        bytes32 expected = keccak256(abi.encode(
            pool.WITHDRAW_STATEMENT_TYPEHASH(), block.chainid, address(pool), D,
            intent.root, intent.nullifierHash, intent.recipient, intent.nonceSeq, intent.maxGasCharge
        ));
        assertEq(pool.withdrawStatementHash(intent), expected);
        uint256 key = uint256(keccak256(abi.encode(pool.NULLIFIER_DOMAIN(), intent.nullifierHash)));
        if (key == 0) key = 1;
        assertEq(pool.nullifierNonceKey(intent.nullifierHash), key);
        assertEq(pool.nullifierNonceKeysHash(intent.nullifierHash), keccak256(abi.encode(uint256(1), key)));
    }

    function test_realGroth16ProofAndReducedContext() public {
        bytes memory proof = vm.parseJsonBytes(fixture, ".proof");
        bytes32 root = vm.parseJsonBytes32(fixture, ".root");
        bytes32 nf = vm.parseJsonBytes32(fixture, ".nullifierHash");
        bytes32 context = vm.parseJsonBytes32(fixture, ".context");
        assertTrue(verifier.verifyProof(proof, root, nf, context));
        assertFalse(verifier.verifyProof(proof, root, nf, bytes32(uint256(context) + 1)));
        assertFalse(verifier.verifyProof(proof, root, nf, bytes32(uint256(context) ^ (uint256(1) << 255))));
        assertFalse(verifier.verifyProof(hex"00", root, nf, context));
        assertFalse(verifier.verifyProof(proof, bytes32(pool.FIELD()), nf, context));
        assertFalse(verifier.verifyProof(proof, root, bytes32(pool.FIELD()), context));
        assertFalse(verifier.verifyProof(bytes.concat(proof, bytes32(0)), root, nf, context));
    }

    function test_poseidonTreeMatchesCircuitAndSdkAtEveryInsertion() public {
        bytes32[] memory leaves = vm.parseJsonBytes32Array(fixture, ".commitments");
        bytes32[] memory roots = vm.parseJsonBytes32Array(fixture, ".roots");
        assertFalse(pool.acceptedRoots(pool.currentRoot()));
        for (uint256 i; i < leaves.length; ++i) {
            (uint64 index, bytes32 root) = pool.deposit{value: D}(leaves[i]);
            assertEq(index, i);
            assertEq(root, roots[i]);
            assertTrue(pool.acceptedRoots(root));
        }
        assertTrue(pool.acceptedRoots(roots[0]));
        assertEq(address(pool).balance, leaves.length * D);
    }

    function test_depositRejectsNoncanonicalAndDuplicateLeaves() public {
        uint256 field = pool.FIELD();
        vm.expectRevert(PrivacyPool8141.InvalidDepositValue.selector);
        pool.deposit{value: 1}(bytes32(uint256(1)));
        vm.expectRevert(PrivacyPool8141.InvalidCommitment.selector);
        pool.deposit{value: D}(bytes32(field));
        vm.expectRevert(PrivacyPool8141.InvalidCommitment.selector);
        pool.deposit{value: D}(0);
        pool.deposit{value: D}(bytes32(uint256(1)));
        vm.expectRevert(PrivacyPool8141.DuplicateCommitment.selector);
        pool.deposit{value: D}(bytes32(uint256(1)));
    }

    function test_retryChargesPriorAttemptCapWithoutChargingOtherNotes() public {
        uint256 currentCharge = 0.0002 ether;
        uint256 payout = pool.withdrawalAmount(2, currentCharge);
        assertEq(payout, D - 0.002 ether - currentCharge);
        vm.deal(address(pool), 2 * D - 0.002 ether - currentCharge);
        RejectEther recipient = new RejectEther();
        bytes32 nf = bytes32(uint256(7));
        vm.prank(address(pool));
        pool.executeWithdrawal(nf, address(recipient), 2, currentCharge);
        assertEq(address(recipient).balance, payout);
        assertEq(address(pool).balance, D);
        assertTrue(pool.nullifierSpent(nf));
        vm.prank(address(pool));
        vm.expectRevert(PrivacyPool8141.NullifierAlreadySpent.selector);
        pool.executeWithdrawal(nf, address(recipient), 2, currentCharge);
    }

    function test_retryBudgetAndCallerGuards() public {
        uint256 cap = pool.MAX_GAS_CHARGE();
        vm.expectRevert(PrivacyPool8141.RetryBudgetExhausted.selector);
        pool.withdrawalAmount(1000, 1);
        vm.expectRevert(PrivacyPool8141.GasChargeTooHigh.selector);
        pool.withdrawalAmount(0, cap + 1);
        vm.expectRevert(PrivacyPool8141.InvalidCaller.selector);
        pool.executeWithdrawal(0, address(1), 0, 1);
        PrivacyPool8141.WithdrawalIntent memory intent;
        vm.expectRevert(PrivacyPool8141.InvalidCaller.selector);
        pool.validateWithdrawal(hex"", intent);
    }

    function test_statementBindsRetryAndDeploymentButAllowsFeeEstimation() public {
        PrivacyPool8141.WithdrawalIntent memory intent;
        intent.recipient = address(123);
        intent.maxGasCharge = pool.MAX_GAS_CHARGE();
        bytes32 h = pool.withdrawStatementHash(intent);
        intent.gasCharge = 100;
        assertEq(h, pool.withdrawStatementHash(intent));
        intent.nonceSeq = 1;
        assertNotEq(h, pool.withdrawStatementHash(intent));
        intent.nonceSeq = 0;
        vm.chainId(block.chainid + 1);
        assertNotEq(h, pool.withdrawStatementHash(intent));
    }

    function testFuzz_retryConservation(uint64 sequence, uint256 charge) public {
        sequence = uint64(sequence % 999);
        charge = 1 + (charge % pool.MAX_GAS_CHARGE());
        uint256 amount = pool.withdrawalAmount(sequence, charge);
        assertEq(amount + uint256(sequence) * pool.MAX_GAS_CHARGE() + charge, D);
    }
}

contract RejectEther {
    receive() external payable {
        revert("reject callbacks");
    }
}
