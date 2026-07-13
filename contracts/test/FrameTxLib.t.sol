// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Test} from "forge-std/Test.sol";
import {FrameTxLib} from "../src/FrameTxLib.sol";

contract FrameTxLibHarness {
    function scopes() external pure returns (uint8 payment, uint8 execution, uint8 both) {
        return (FrameTxLib.SCOPE_PAYMENT, FrameTxLib.SCOPE_EXECUTION, FrameTxLib.SCOPE_EXECUTION_AND_PAYMENT);
    }

    function frameFlags() external pure returns (uint8 scopeMask, uint8 atomicBatch) {
        return (FrameTxLib.FRAME_FLAG_SCOPE_MASK, FrameTxLib.FRAME_FLAG_ATOMIC_BATCH);
    }

    function txParamSelectors() external pure returns (uint8[17] memory selectors) {
        selectors = [
            FrameTxLib.TX_PARAM_TYPE,
            FrameTxLib.TX_PARAM_NONCE,
            FrameTxLib.TX_PARAM_SENDER,
            FrameTxLib.TX_PARAM_GAS_TIP_CAP,
            FrameTxLib.TX_PARAM_GAS_FEE_CAP,
            FrameTxLib.TX_PARAM_BLOB_FEE_CAP,
            FrameTxLib.TX_PARAM_MAX_COST,
            FrameTxLib.TX_PARAM_BLOB_HASH_COUNT,
            FrameTxLib.TX_PARAM_SIG_HASH,
            FrameTxLib.TX_PARAM_FRAME_COUNT,
            FrameTxLib.TX_PARAM_FRAME_INDEX,
            FrameTxLib.TX_PARAM_SIGNATURE_COUNT,
            FrameTxLib.TX_PARAM_NONCE_KEY_0,
            FrameTxLib.TX_PARAM_LEGACY_NONCE,
            FrameTxLib.TX_PARAM_NONCE_KEY_COUNT,
            FrameTxLib.TX_PARAM_NONCE_KEYS_HASH,
            FrameTxLib.TX_PARAM_RECENT_ROOT_REF_COUNT
        ];
    }

    function frameParamSelectors() external pure returns (uint8[9] memory selectors) {
        selectors = [
            FrameTxLib.FRAME_PARAM_TARGET,
            FrameTxLib.FRAME_PARAM_GAS_LIMIT,
            FrameTxLib.FRAME_PARAM_MODE,
            FrameTxLib.FRAME_PARAM_FLAGS,
            FrameTxLib.FRAME_PARAM_DATA_LENGTH,
            FrameTxLib.FRAME_PARAM_STATUS,
            FrameTxLib.FRAME_PARAM_ALLOWED_SCOPE,
            FrameTxLib.FRAME_PARAM_ATOMIC_BATCH,
            FrameTxLib.FRAME_PARAM_VALUE
        ];
    }

    function sigParamSelectors() external pure returns (uint8[4] memory selectors) {
        selectors = [
            FrameTxLib.SIG_PARAM_SIGNER,
            FrameTxLib.SIG_PARAM_SCHEME,
            FrameTxLib.SIG_PARAM_MSG,
            FrameTxLib.SIG_PARAM_SIGNATURE_LENGTH
        ];
    }

    function expiryVerifier() external pure returns (address) {
        return FrameTxLib.EXPIRY_VERIFIER;
    }

    function encodeExpiryDeadline(uint64 deadline) external pure returns (bytes memory) {
        return FrameTxLib.encodeExpiryDeadline(deadline);
    }
}

contract FrameTxLibTest is Test {
    FrameTxLibHarness internal harness;

    function setUp() public {
        harness = new FrameTxLibHarness();
    }

    function test_scopeBitmaskValues() public {
        (uint8 payment, uint8 execution, uint8 both) = harness.scopes();
        assertEq(payment, 0x01);
        assertEq(execution, 0x02);
        assertEq(both, 0x03);
    }

    function test_atomicBatchFlag() public {
        (uint8 scopeMask, uint8 atomicBatch) = harness.frameFlags();
        assertEq(scopeMask, 0x03);
        assertEq(atomicBatch, 0x04);
        assertEq(scopeMask & atomicBatch, 0);
    }

    function test_txParamSelectorsAreContiguous() public {
        uint8[17] memory selectors = harness.txParamSelectors();
        for (uint8 i; i < selectors.length; ++i) {
            assertEq(selectors[i], i);
        }
    }

    function test_senderValueFrameParamSelector() public {
        uint8[9] memory selectors = harness.frameParamSelectors();
        for (uint8 i; i < selectors.length; ++i) {
            assertEq(selectors[i], i);
        }
        assertEq(selectors[8], FrameTxLib.FRAME_PARAM_VALUE);
    }

    function test_sigParamSelectorsAreContiguous() public {
        uint8[4] memory selectors = harness.sigParamSelectors();
        for (uint8 i; i < selectors.length; ++i) {
            assertEq(selectors[i], i);
        }
    }

    function test_expiryVerifierAndDeadlineEncoding() public {
        assertEq(harness.expiryVerifier(), 0x0000000000000000000000000000000000008141);
        bytes memory encoded = harness.encodeExpiryDeadline(0x0102030405060708);
        assertEq(encoded.length, 8);
        assertEq(encoded, hex"0102030405060708");
    }

    function test_nonceManagerAddress() public {
        assertEq(FrameTxLib.NONCE_MANAGER, 0x0000000000000000000000000000000000008250);
    }

    function test_recentRootConstants() public {
        assertEq(FrameTxLib.RECENT_ROOT, 0x0000000000000000000000000000000000008272);
        assertEq(FrameTxLib.RECENT_ROOT_FIELD_SOURCE_ID, 0);
        assertEq(FrameTxLib.RECENT_ROOT_FIELD_SLOT, 1);
        assertEq(FrameTxLib.RECENT_ROOT_FIELD_ROOT, 2);
    }
}
