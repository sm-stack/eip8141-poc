// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {TestBase} from "./TestBase.sol";
import {PrivacyPool8141} from "../src/example/PrivacyPool8141.sol";
import {MockPrivacyPoolVerifier} from "../src/test-helpers/MockPrivacyPoolVerifier.sol";

contract PrivacyPool8141Test is TestBase {
    uint256 internal constant DENOMINATION = 1 ether;

    MockPrivacyPoolVerifier internal verifier;
    PrivacyPool8141 internal pool;

    function setUp() public {
        verifier = new MockPrivacyPoolVerifier();
        pool = new PrivacyPool8141(verifier, DENOMINATION, 20);
    }

    function test_constructorInitializesRootSourceAndEmptyTree() public {
        assertEq(pool.denomination(), DENOMINATION);
        assertEq(pool.levels(), 20);
        assertEq(pool.EXECUTE_GAS_LIMIT(), 200_000);
        assertEq(pool.rootSourceId(), keccak256(abi.encodePacked(address(pool), pool.ROOT_SALT())));
        assertNotEq(pool.currentRoot(), bytes32(0));
    }

    function test_constructorRejectsInvalidConfiguration() public {
        vm.expectRevert(PrivacyPool8141.InvalidVerifier.selector);
        new PrivacyPool8141(MockPrivacyPoolVerifier(address(1)), DENOMINATION, 20);

        vm.expectRevert(PrivacyPool8141.InvalidDenomination.selector);
        new PrivacyPool8141(verifier, 0, 20);

        vm.expectRevert(PrivacyPool8141.InvalidTreeLevels.selector);
        new PrivacyPool8141(verifier, DENOMINATION, 0);

        vm.expectRevert(PrivacyPool8141.InvalidTreeLevels.selector);
        new PrivacyPool8141(verifier, DENOMINATION, 33);
    }

    function test_depositInsertsCommitmentAndPublishesRoot() public {
        bytes32 commitment = keccak256("note-1");
        bytes32 previousRoot = pool.currentRoot();

        vm.expectEmit(true, true, false, false, address(pool));
        emit PrivacyPool8141.Deposit(commitment, 0, bytes32(0));
        (uint64 leafIndex, bytes32 root) = pool.deposit{value: DENOMINATION}(commitment);

        assertEq(leafIndex, 0);
        assertEq(root, pool.currentRoot());
        assertNotEq(root, previousRoot);
        assertEq(pool.nextLeafIndex(), 1);
        assertTrue(pool.commitments(commitment));
        assertEq(address(pool).balance, DENOMINATION);
    }

    function test_depositRejectsWrongValueAndDuplicateCommitment() public {
        bytes32 commitment = keccak256("note-1");

        vm.expectRevert(PrivacyPool8141.InvalidDepositValue.selector);
        pool.deposit{value: DENOMINATION - 1}(commitment);

        pool.deposit{value: DENOMINATION}(commitment);
        vm.expectRevert(PrivacyPool8141.DuplicateCommitment.selector);
        pool.deposit{value: DENOMINATION}(commitment);
    }

    function test_depositRevertsAtomicallyWhenRootPublicationFails() public {
        bytes32 commitment = keccak256("note-1");
        vm.etch(address(0x8272), hex"60006000fd");

        vm.expectRevert(PrivacyPool8141.RootPublicationFailed.selector);
        pool.deposit{value: DENOMINATION}(commitment);

        assertEq(pool.nextLeafIndex(), 0);
        assertFalse(pool.commitments(commitment));
        assertEq(address(pool).balance, 0);
    }

    function test_depositRejectsWhenTreeIsFull() public {
        PrivacyPool8141 smallPool = new PrivacyPool8141(verifier, DENOMINATION, 1);
        smallPool.deposit{value: DENOMINATION}(keccak256("note-1"));
        smallPool.deposit{value: DENOMINATION}(keccak256("note-2"));

        vm.expectRevert(PrivacyPool8141.TreeFull.selector);
        smallPool.deposit{value: DENOMINATION}(keccak256("note-3"));
    }

    function test_executeWithdrawalPaysRecipientWithoutCallingIt() public {
        RejectEther recipient = new RejectEther();
        PrivacyPool8141.WithdrawalIntent memory intent = _intent(address(recipient), 0.12 ether);

        vm.deal(address(pool), DENOMINATION - intent.gasCharge);
        vm.prank(address(pool));
        pool.executeWithdrawal(intent.nullifierHash, intent.recipient, DENOMINATION - intent.gasCharge);

        assertTrue(pool.nullifierSpent(intent.nullifierHash));
        assertEq(address(recipient).balance, DENOMINATION - intent.gasCharge);
        assertEq(address(pool).balance, 0);
    }

    function test_executeWithdrawalRejectsReplay() public {
        PrivacyPool8141.WithdrawalIntent memory intent = _intent(makeAddr("recipient"), 0.1 ether);
        vm.deal(address(pool), 2 ether);

        vm.prank(address(pool));
        pool.executeWithdrawal(intent.nullifierHash, intent.recipient, DENOMINATION - intent.gasCharge);

        vm.prank(address(pool));
        vm.expectRevert(PrivacyPool8141.NullifierAlreadySpent.selector);
        pool.executeWithdrawal(intent.nullifierHash, intent.recipient, DENOMINATION - intent.gasCharge);
    }

    function test_executeWithdrawalRejectsExternalCallerAndExcessiveGasCharge() public {
        PrivacyPool8141.WithdrawalIntent memory intent = _intent(makeAddr("recipient"), 0.1 ether);
        vm.expectRevert(PrivacyPool8141.InvalidCaller.selector);
        pool.executeWithdrawal(intent.nullifierHash, intent.recipient, DENOMINATION - intent.gasCharge);

        vm.prank(address(pool));
        vm.expectRevert(PrivacyPool8141.GasChargeTooHigh.selector);
        pool.executeWithdrawal(intent.nullifierHash, intent.recipient, 0);
    }

    function test_nullifierNonceDomainIsDeterministicAndNonzero() public {
        bytes32 nullifierHash = keccak256("nullifier");
        uint256 key = pool.nullifierNonceKey(nullifierHash);
        assertNotEq(key, 0);
        assertEq(pool.nullifierNonceKeysHash(nullifierHash), keccak256(abi.encode(uint256(1), key)));
    }

    function test_statementHashBindsAuthorizationButNotExactGasTerms() public {
        PrivacyPool8141.WithdrawalIntent memory first = _intent(makeAddr("alice"), 0.1 ether);
        PrivacyPool8141.WithdrawalIntent memory second = _intent(makeAddr("bob"), 0.1 ether);
        assertNotEq(pool.withdrawStatementHash(first), pool.withdrawStatementHash(second));

        second = _intent(first.recipient, first.gasCharge);
        second.maxGasCharge += 1;
        assertNotEq(pool.withdrawStatementHash(first), pool.withdrawStatementHash(second));

        second = _intent(first.recipient, first.gasCharge + 1);
        second.maxPriorityFeePerGas += 1;
        second.maxFeePerGas += 1;
        assertEq(pool.withdrawStatementHash(first), pool.withdrawStatementHash(second));

        bytes32 original = pool.withdrawStatementHash(first);
        vm.chainId(block.chainid + 1);
        assertNotEq(pool.withdrawStatementHash(first), original);
    }

    function test_validateWithdrawalRejectsNonEntryPointBeforeFrameOpcodes() public {
        PrivacyPool8141.WithdrawalIntent memory intent = _intent(makeAddr("recipient"), 0.1 ether);
        vm.expectRevert(PrivacyPool8141.InvalidCaller.selector);
        pool.validateWithdrawal(hex"1234", intent);
    }

    function test_validateWithdrawalRejectsExecutionFailuresBeforeApproval() public {
        PrivacyPool8141.WithdrawalIntent memory intent = _intent(address(0), 0.1 ether);
        vm.prank(address(0xAA));
        vm.expectRevert(PrivacyPool8141.InvalidRecipient.selector);
        pool.validateWithdrawal(hex"1234", intent);

        intent.recipient = makeAddr("recipient");
        intent.maxGasCharge = 0;
        vm.prank(address(0xAA));
        vm.expectRevert(PrivacyPool8141.GasChargeTooHigh.selector);
        pool.validateWithdrawal(hex"1234", intent);

        intent.maxGasCharge = DENOMINATION;
        vm.prank(address(0xAA));
        vm.expectRevert(PrivacyPool8141.GasChargeTooHigh.selector);
        pool.validateWithdrawal(hex"1234", intent);

        intent.maxGasCharge = 0.2 ether;
        intent.gasCharge = 0;
        vm.prank(address(0xAA));
        vm.expectRevert(PrivacyPool8141.GasChargeTooHigh.selector);
        pool.validateWithdrawal(hex"1234", intent);

        intent.gasCharge = DENOMINATION;
        vm.prank(address(0xAA));
        vm.expectRevert(PrivacyPool8141.GasChargeTooHigh.selector);
        pool.validateWithdrawal(hex"1234", intent);

        intent.gasCharge = 0.1 ether;
        vm.deal(address(pool), DENOMINATION);
        vm.prank(address(pool));
        pool.executeWithdrawal(intent.nullifierHash, intent.recipient, DENOMINATION - intent.gasCharge);

        vm.prank(address(0xAA));
        vm.expectRevert(PrivacyPool8141.NullifierAlreadySpent.selector);
        pool.validateWithdrawal(hex"1234", intent);
    }

    function _intent(address recipient, uint256 gasCharge)
        private
        view
        returns (PrivacyPool8141.WithdrawalIntent memory intent)
    {
        intent = PrivacyPool8141.WithdrawalIntent({
            root: pool.currentRoot(),
            rootSlot: 7,
            nullifierHash: keccak256("nullifier"),
            recipient: recipient,
            nonceSeq: 0,
            maxGasCharge: 0.2 ether,
            gasCharge: gasCharge,
            verifyGasLimit: 400_000,
            maxPriorityFeePerGas: 1 gwei,
            maxFeePerGas: 2 gwei
        });
    }
}

contract RejectEther {
    receive() external payable {
        revert();
    }
}
