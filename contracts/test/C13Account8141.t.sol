// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;
import {TestBase} from "./TestBase.sol";
import {C13Account8141} from "../src/sphincs/C13Account8141.sol";
import {C13Verifier} from "../src/sphincs/C13Verifier.sol";
import {SphincsC13Asm} from "../sphincs/vendor/SphincsC13Reference.sol";

contract C13Account8141Test is TestBase {
    event log_named_uint(string key, uint256 value);
    C13Verifier v;
    SphincsC13Asm refV;
    C13Account8141 wallet;
    bytes32 seed;
    bytes32 root;
    bytes sig;
    bytes32 constant M = 0xdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef;

    function setUp() public {
        (seed, root, sig) = abi.decode(vm.readFileBinary("sphincs/fixtures/c13.bin"), (bytes32, bytes32, bytes));
        v = new C13Verifier();
        refV = new SphincsC13Asm();
        wallet = new C13Account8141(seed, root);
        vm.deal(address(wallet), 1 ether);
    }

    function test_validVectorAndGas() public {
        bytes memory x = sig;
        bytes32 a = seed;
        bytes32 b = root;
        assertTrue(refV.verify(a, b, M, x));
        assertTrue(v.verify(a, b, M, x));
        uint256 g = gasleft();
        bool ok = v.verify(a, b, M, x);
        g -= gasleft();
        assertTrue(ok);
        emit log_named_uint("optimized warm external verification", g);
        assertTrue(g < 70_000);
        assertTrue(address(v).code.length <= 24_576);
    }

    function _same(bytes32 a, bytes32 b, bytes32 m, bytes memory x) internal {
        bytes memory data = abi.encodeCall(v.verify, (a, b, m, x));
        (bool ok, bytes memory out) = address(v).staticcall(data);
        (bool rok, bytes memory rout) = address(refV).staticcall(data);
        assertEq(ok, rok);
        assertEq(keccak256(out), keccak256(rout));
    }

    function testFuzz_signatureMutationDifferential(uint16 offset, uint8 bit) public {
        bytes memory x = sig;
        x[uint256(offset) % x.length] ^= bytes1(uint8(1 << (bit % 8)));
        _same(seed, root, M, x);
        assertFalse(v.verify(seed, root, M, x));
    }

    function testFuzz_keysAndMessageDifferential(bytes32 a, bytes32 b, bytes32 m) public {
        _same(a, b, m, sig);
    }

    function testFuzz_canonicalKeysDifferential(bytes32 a, bytes32 b) public {
        _same(
            bytes32(uint256(a) & ~uint256(type(uint128).max)), bytes32(uint256(b) & ~uint256(type(uint128).max)), M, sig
        );
    }

    function testFuzz_lengthsDifferential(uint16 size) public {
        _same(seed, root, M, new bytes(uint256(size) % 4096));
    }

    function test_signerVectors() public {
        for (uint256 i; i < 4; i++) {
            string memory file = string.concat("sphincs/fixtures/vector-", vm.toString(i), ".json");
            string memory j = vm.readFile(file);
            bytes32 a = vm.parseJsonBytes32(j, ".seed");
            bytes32 b = vm.parseJsonBytes32(j, ".root");
            bytes32 m = vm.parseJsonBytes32(j, ".message");
            bytes memory x = vm.parseJsonBytes(j, ".signature");
            assertTrue(refV.verify(a, b, m, x));
            assertTrue(v.verify(a, b, m, x));
            _same(a, b, bytes32(uint256(m) ^ 1), x);
        }
    }

    function test_accessControlsAndRotation() public {
        vm.expectRevert(C13Account8141.Unauthorized.selector);
        wallet.rotateOwner(seed, root);
        vm.expectRevert(C13Account8141.Unauthorized.selector);
        wallet.execute(address(0xbeef), 0, "");
        vm.expectRevert(C13Account8141.Unauthorized.selector);
        wallet.validate(seed, root, 0, 1, sig);
        bytes32 before = wallet.ownerCommitment();
        bytes32 c = wallet.challenge(M, 0, 1);
        vm.prank(address(wallet));
        wallet.rotateOwner(seed, root);
        assertEq(wallet.ownerEpoch(), 1);
        assertTrue(wallet.ownerCommitment() != before);
        assertTrue(wallet.challenge(M, 1, 1) != c);
    }

    function test_rejectsNoncanonicalKeys() public {
        vm.expectRevert(C13Account8141.InvalidKey.selector);
        new C13Account8141(bytes32(uint256(seed) | 1), root);
        vm.expectRevert(C13Account8141.InvalidKey.selector);
        new C13Account8141(seed, 0);
        vm.prank(address(wallet));
        vm.expectRevert(C13Account8141.InvalidKey.selector);
        wallet.rotateOwner(seed, bytes32(uint256(root) | 1));
    }

    function test_domainSeparation() public {
        C13Account8141 other = new C13Account8141(seed, root);
        assertTrue(other.challenge(M, 0, 1) != wallet.challenge(M, 0, 1));
        assertTrue(wallet.challenge(M, 0, 1) != wallet.challenge(M, 0, 2));
    }

    function test_batchAtomicityAndCallbackAuthorization() public {
        C13Account8141.Call[] memory calls = new C13Account8141.Call[](2);
        calls[0] = C13Account8141.Call(address(0xbeef), 1, "");
        calls[1] = C13Account8141.Call(address(this), 0, abi.encodeCall(this.attack, ()));
        vm.prank(address(wallet));
        vm.expectRevert();
        wallet.executeBatch(calls);
        assertEq(address(0xbeef).balance, 0);
        assertEq(wallet.ownerEpoch(), 0);
    }

    function attack() external {
        wallet.rotateOwner(seed, root);
    }
}
