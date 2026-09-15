// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {TestBase} from "./TestBase.sol";
import {PasskeyAccount8141} from "../src/passkey/PasskeyAccount8141.sol";
import {StrictWebAuthn} from "../src/passkey/StrictWebAuthn.sol";
import {Base64} from "solady/utils/Base64.sol";

contract AssertionHarness {
    function verify(bytes32 challenge, StrictWebAuthn.Assertion calldata a, uint256 x, uint256 y)
        external
        view
        returns (bool)
    {
        return StrictWebAuthn.verify(
            challenge,
            sha256("wallet.example.com"),
            keccak256("\",\"origin\":\"https://wallet.example.com\",\"crossOrigin\":false}"),
            keccak256("\",\"origin\":\"https://wallet.example.com\"}"),
            a,
            x,
            y
        );
    }

    function validKey(uint256 x, uint256 y) external pure returns (bool) {
        return StrictWebAuthn.validPublicKey(x, y);
    }
}

contract RejectPasskeyCall {
    fallback() external payable {
        revert("recipient failure");
    }
}

contract CallbackPasskeyCall {
    PasskeyAccount8141 immutable wallet;

    constructor(PasskeyAccount8141 w) {
        wallet = w;
    }

    fallback() external payable {
        wallet.rotateOwner(1, 2);
    }
}

contract PasskeyAccount8141Test is TestBase {
    uint256 constant N = 0xffffffff00000000ffffffffffffffffbce6faada7179e84f3b9cac2fc632551;
    uint256 x;
    uint256 y;
    PasskeyAccount8141 wallet;
    AssertionHarness verifier;
    address constant GUARDIAN = address(0xbeef);
    bytes32 constant CHALLENGE = keccak256("transaction");

    function setUp() public {
        (x, y) = vm.publicKeyP256(1);
        wallet = new PasskeyAccount8141(
            x, y, sha256("wallet.example.com"), "https://wallet.example.com", GUARDIAN, 2 days
        );
        verifier = new AssertionHarness();
        vm.deal(address(wallet), 10 ether);
    }

    function _auth(bytes32 c) private returns (StrictWebAuthn.Assertion memory a) {
        a.authenticatorData = abi.encodePacked(sha256("wallet.example.com"), bytes1(0x05), uint32(0));
        a.clientDataJSON = abi.encodePacked(
            '{"type":"webauthn.get","challenge":"',
            Base64.encode(abi.encodePacked(c), true, true),
            '","origin":"https://wallet.example.com","crossOrigin":false}'
        );
        return _sign(a);
    }

    function _sign(StrictWebAuthn.Assertion memory a) private returns (StrictWebAuthn.Assertion memory) {
        (bytes32 r, bytes32 s) = vm.signP256(1, sha256(abi.encodePacked(a.authenticatorData, sha256(a.clientDataJSON))));
        a.r = uint256(r);
        a.s = uint256(s);
        return a;
    }

    function testFuzz_validChallenges(bytes32 c) public {
        assertTrue(verifier.verify(c, _auth(c), x, y));
    }

    function test_highSAndLowSAreBothValid() public {
        StrictWebAuthn.Assertion memory a = _auth(CHALLENGE);
        assertTrue(verifier.verify(CHALLENGE, a, x, y));
        a.s = N - a.s;
        assertTrue(verifier.verify(CHALLENGE, a, x, y));
    }

    function test_legacyClientDataAndBackedUpPasskey() public {
        StrictWebAuthn.Assertion memory a = _auth(CHALLENGE);
        a.clientDataJSON = abi.encodePacked(
            '{"type":"webauthn.get","challenge":"',
            Base64.encode(abi.encodePacked(CHALLENGE), true, true),
            '","origin":"https://wallet.example.com"}'
        );
        a.authenticatorData[32] = 0x1d;
        assertTrue(verifier.verify(CHALLENGE, _sign(a), x, y));
    }

    function testFuzz_flags(uint8 flags) public {
        StrictWebAuthn.Assertion memory a = _auth(CHALLENGE);
        a.authenticatorData[32] = bytes1(flags);
        bool expected = flags & 5 == 5 && flags & 0xe2 == 0 && (flags & 16 == 0 || flags & 8 != 0);
        assertEq(verifier.verify(CHALLENGE, _sign(a), x, y), expected);
    }

    function test_rejectsSignedWrongRpIdAndWrongChallenge() public {
        StrictWebAuthn.Assertion memory a = _auth(CHALLENGE);
        a.authenticatorData[0] ^= 0x01;
        assertFalse(verifier.verify(CHALLENGE, _sign(a), x, y));
        assertFalse(verifier.verify(bytes32(uint256(CHALLENGE) ^ 1), _auth(CHALLENGE), x, y));
    }

    function test_rejectsSignedJsonInjectionAndCrossOrigin() public {
        string[7] memory tails = [
            '","origin":"https://evil.example.com","crossOrigin":false}',
            '","origin":"https://wallet.example.com","crossOrigin":true}',
            '","origin":"https://wallet.example.com","crossOrigin":false,"challenge":"other"}',
            'X","origin":"https://wallet.example.com","crossOrigin":false}',
            '","origin":"https://wallet.example.com","crossOrigin":false}{}',
            '","origin":"https://wallet.example.com","origin":"https://evil.com"}',
            '","origin":"https://wallet.example.com","crossOrigin":false,"topOrigin":"https://evil.com"}'
        ];
        for (uint256 i; i < tails.length; ++i) {
            StrictWebAuthn.Assertion memory a = _auth(CHALLENGE);
            a.clientDataJSON = abi.encodePacked(
                '{"type":"webauthn.get","challenge":"', Base64.encode(abi.encodePacked(CHALLENGE), true, true), tails[i]
            );
            assertFalse(verifier.verify(CHALLENGE, _sign(a), x, y));
        }
        StrictWebAuthn.Assertion memory a = _auth(CHALLENGE);
        a.clientDataJSON[18] = "x";
        assertFalse(verifier.verify(CHALLENGE, _sign(a), x, y));
    }

    function test_rejectsLengthsAndInvalidCurveInputs() public {
        StrictWebAuthn.Assertion memory a = _auth(CHALLENGE);
        a.authenticatorData = new bytes(36);
        assertFalse(verifier.verify(CHALLENGE, _sign(a), x, y));
        a = _auth(CHALLENGE);
        a.authenticatorData = bytes.concat(a.authenticatorData, hex"00");
        assertFalse(verifier.verify(CHALLENGE, _sign(a), x, y));
        a = _auth(CHALLENGE);
        a.clientDataJSON = new bytes(513);
        assertFalse(verifier.verify(CHALLENGE, _sign(a), x, y));
        a = _auth(CHALLENGE);
        a.r = 0;
        assertFalse(verifier.verify(CHALLENGE, a, x, y));
        a.r = N;
        assertFalse(verifier.verify(CHALLENGE, a, x, y));
        a = _auth(CHALLENGE);
        a.s = N;
        assertFalse(verifier.verify(CHALLENGE, a, x, y));
        a = _auth(CHALLENGE);
        assertFalse(verifier.verify(CHALLENGE, a, 0, 0));
        assertFalse(verifier.verify(CHALLENGE, a, x, y ^ 1));
        assertFalse(verifier.validKey(type(uint256).max, y));
    }

    function test_precompileMissingOrMalformedFailsClosed() public {
        StrictWebAuthn.Assertion memory a = _auth(CHALLENGE);
        vm.mockCall(address(0x100), bytes(""), bytes(""));
        assertFalse(verifier.verify(CHALLENGE, a, x, y));
        vm.mockCall(address(0x100), bytes(""), hex"01");
        assertFalse(verifier.verify(CHALLENGE, a, x, y));
        vm.mockCall(address(0x100), bytes(""), abi.encode(uint256(2)));
        assertFalse(verifier.verify(CHALLENGE, a, x, y));
    }

    function test_ownerEpochPreventsRollbackReplay() public {
        bytes32 beforeHash = wallet.ownerCommitment();
        bytes32 beforeChallenge = wallet.challenge(CHALLENGE, 0, 1 ether);
        vm.prank(address(wallet));
        wallet.rotateOwner(x, y);
        assertEq(wallet.ownerEpoch(), 1);
        assertTrue(wallet.ownerCommitment() != beforeHash);
        assertTrue(wallet.challenge(CHALLENGE, 1, 1 ether) != beforeChallenge);
    }

    function test_domainBindsAccountChainEpoch() public {
        PasskeyAccount8141 other =
            new PasskeyAccount8141(x, y, sha256("wallet.example.com"), "https://wallet.example.com", address(0), 0);
        bytes32 c = wallet.challenge(CHALLENGE, 0, 1 ether);
        assertTrue(c != other.challenge(CHALLENGE, 0, 1 ether));
        vm.chainId(block.chainid + 1);
        assertTrue(c != wallet.challenge(CHALLENGE, 0, 1 ether));
    }

    function test_unauthorizedEntrypoints() public {
        vm.expectRevert(PasskeyAccount8141.Unauthorized.selector);
        wallet.execute(address(1), 0, "");
        vm.expectRevert(PasskeyAccount8141.Unauthorized.selector);
        wallet.rotateOwner(x, y);
        vm.expectRevert(PasskeyAccount8141.Unauthorized.selector);
        wallet.scheduleRecovery(x, y);
        vm.expectRevert(PasskeyAccount8141.Unauthorized.selector);
        wallet.cancelRecovery();
        StrictWebAuthn.Assertion memory a = _auth(CHALLENGE);
        vm.expectRevert(PasskeyAccount8141.Unauthorized.selector);
        wallet.validate(x, y, 0, 1 ether, a);
    }

    function test_delayedRecoveryAndExactKey() public {
        (uint256 nx, uint256 ny) = vm.publicKeyP256(2);
        vm.prank(GUARDIAN);
        wallet.scheduleRecovery(nx, ny);
        vm.expectRevert(PasskeyAccount8141.RecoveryNotReady.selector);
        wallet.finalizeRecovery(nx, ny);
        vm.prank(GUARDIAN);
        vm.expectRevert(PasskeyAccount8141.RecoveryUnavailable.selector);
        wallet.scheduleRecovery(x, y);
        vm.warp(wallet.recoveryReadyAt());
        vm.expectRevert(PasskeyAccount8141.InvalidKey.selector);
        wallet.finalizeRecovery(x, y);
        wallet.finalizeRecovery(nx, ny);
        assertEq(wallet.ownerEpoch(), 1);
        assertEq(wallet.ownerCommitment(), wallet.keyCommitment(nx, ny, 1));
        assertEq(wallet.pendingRecovery(), bytes32(0));
        vm.expectRevert(PasskeyAccount8141.RecoveryUnavailable.selector);
        wallet.finalizeRecovery(nx, ny);
    }

    function test_ownerCancellationAndRotationClearRecovery() public {
        vm.prank(GUARDIAN);
        wallet.scheduleRecovery(x, y);
        vm.prank(address(wallet));
        wallet.cancelRecovery();
        assertEq(wallet.pendingRecovery(), bytes32(0));
        vm.prank(GUARDIAN);
        wallet.scheduleRecovery(x, y);
        vm.prank(address(wallet));
        wallet.rotateOwner(x, y);
        assertEq(wallet.recoveryReadyAt(), 0);
    }

    function test_recoveryDisabledAndPolicyBounds() public {
        PasskeyAccount8141 w =
            new PasskeyAccount8141(x, y, sha256("wallet.example.com"), "https://wallet.example.com", address(0), 0);
        vm.prank(address(0));
        vm.expectRevert(PasskeyAccount8141.Unauthorized.selector);
        w.scheduleRecovery(x, y);
        vm.expectRevert(PasskeyAccount8141.InvalidPolicy.selector);
        new PasskeyAccount8141(x, y, bytes32(0), "https://wallet.example.com", GUARDIAN, 2 days);
        vm.expectRevert(PasskeyAccount8141.InvalidPolicy.selector);
        new PasskeyAccount8141(x, y, bytes32(uint256(1)), "http://wallet.example.com", GUARDIAN, 2 days);
        vm.expectRevert(PasskeyAccount8141.InvalidPolicy.selector);
        new PasskeyAccount8141(x, y, bytes32(uint256(1)), "https://wallet.example.com", GUARDIAN, 1 days);
        vm.expectRevert(PasskeyAccount8141.InvalidKey.selector);
        new PasskeyAccount8141(0, 0, bytes32(uint256(1)), "https://wallet.example.com", address(0), 0);
    }

    function test_atomicBatchAndCallbacksCannotManageOwner() public {
        RejectPasskeyCall rejector = new RejectPasskeyCall();
        PasskeyAccount8141.Call[] memory calls = new PasskeyAccount8141.Call[](2);
        calls[0] = PasskeyAccount8141.Call(address(0xcafe), 1 ether, "");
        calls[1] = PasskeyAccount8141.Call(address(rejector), 0, "");
        vm.prank(address(wallet));
        vm.expectRevert();
        wallet.executeBatch(calls);
        assertEq(address(0xcafe).balance, 0);
        CallbackPasskeyCall callback = new CallbackPasskeyCall(wallet);
        vm.prank(address(wallet));
        vm.expectRevert(PasskeyAccount8141.Unauthorized.selector);
        wallet.execute(address(callback), 0, "");
        vm.prank(address(wallet));
        wallet.execute(address(0xcafe), 1 ether, "");
        assertEq(address(0xcafe).balance, 1 ether);
    }
}
