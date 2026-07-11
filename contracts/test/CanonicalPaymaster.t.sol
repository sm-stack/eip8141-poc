// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {CanonicalPaymaster} from "../src/CanonicalPaymaster.sol";
import {TestBase} from "./TestBase.sol";

contract CanonicalPaymasterTest is TestBase {
    CanonicalPaymaster internal paymaster;
    address internal signer;

    function setUp() public {
        signer = makeAddr("canonicalSigner");
        paymaster = new CanonicalPaymaster(signer);
        vm.deal(address(paymaster), 10 ether);
    }

    function test_constructorRejectsZeroSigner() public {
        vm.expectRevert(CanonicalPaymaster.InvalidSigner.selector);
        new CanonicalPaymaster(address(0));
    }

    function test_runtimeCodeIsSignerIndependent() public {
        CanonicalPaymaster other = new CanonicalPaymaster(makeAddr("otherSigner"));
        assertEq(address(paymaster).codehash, address(other).codehash);
    }

    function test_initiateWithdrawalRecordsPendingAmountAndDelay() public {
        vm.prank(signer);
        paymaster.initiateWithdrawal(3 ether);

        assertEq(paymaster.pendingWithdrawal(), 3 ether);
        assertEq(paymaster.pendingWithdrawalAvailableAt(), block.timestamp + paymaster.WITHDRAWAL_DELAY());
    }

    function test_initiateWithdrawalRejectsUnauthorizedAndInvalidAmounts() public {
        vm.expectRevert(CanonicalPaymaster.InvalidCaller.selector);
        paymaster.initiateWithdrawal(1 ether);

        vm.startPrank(signer);
        vm.expectRevert(CanonicalPaymaster.InvalidWithdrawalAmount.selector);
        paymaster.initiateWithdrawal(0);
        vm.expectRevert(CanonicalPaymaster.InvalidWithdrawalAmount.selector);
        paymaster.initiateWithdrawal(11 ether);
        vm.stopPrank();
    }

    function test_initiateWithdrawalRejectsSecondPendingRequest() public {
        vm.startPrank(signer);
        paymaster.initiateWithdrawal(1 ether);
        vm.expectRevert(CanonicalPaymaster.WithdrawalAlreadyPending.selector);
        paymaster.initiateWithdrawal(1 ether);
        vm.stopPrank();
    }

    function test_finalizeWithdrawalEnforcesDelayAndTransfersToSigner() public {
        vm.prank(signer);
        paymaster.initiateWithdrawal(3 ether);

        vm.prank(signer);
        vm.expectRevert(CanonicalPaymaster.WithdrawalNotReady.selector);
        paymaster.finalizeWithdrawal();

        uint256 signerBalance = signer.balance;
        vm.warp(block.timestamp + paymaster.WITHDRAWAL_DELAY());
        vm.prank(signer);
        paymaster.finalizeWithdrawal();

        assertEq(signer.balance, signerBalance + 3 ether);
        assertEq(paymaster.pendingWithdrawal(), 0);
        assertEq(paymaster.pendingWithdrawalAvailableAt(), 0);
    }

    function test_finalizeWithdrawalRejectsUnauthorizedAndMissingRequest() public {
        vm.expectRevert(CanonicalPaymaster.InvalidCaller.selector);
        paymaster.finalizeWithdrawal();

        vm.prank(signer);
        vm.expectRevert(CanonicalPaymaster.NoPendingWithdrawal.selector);
        paymaster.finalizeWithdrawal();
    }

    function test_validateRejectsNonEntryPoint() public {
        vm.expectRevert(CanonicalPaymaster.InvalidCaller.selector);
        paymaster.validate(0);
    }
}
