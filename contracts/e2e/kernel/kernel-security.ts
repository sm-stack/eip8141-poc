/**
 * E2E: Kernel8141 Security Tests
 *
 * Tests for security fixes:
 * - K-06: Reject malleable (high-s) ECDSA signatures
 * - Wrong signer rejection
 *
 * Usage: cd contracts && npx tsx e2e/kernel/kernel-security.ts
 */

import {
  encodeFunctionData,
  hexToBytes,
  bytesToHex,
  type Hex,
  type Hash,
  type Address,
} from "viem";
import { CHAIN_ID, DEV_KEY, SECOND_OWNER_KEY, DEAD_ADDR, FRAME_MODE_VERIFY, FRAME_MODE_SENDER } from "../helpers/config.js";
import { waitForReceipt } from "../helpers/client.js";
import { computeSigHash, encodeFrameTx, type FrameTxParams } from "../helpers/frame-tx.js";
import { signFrameHash } from "../helpers/signing.js";
import { verifyReceipt } from "../helpers/receipt.js";
import { kernelAbi } from "../helpers/abis/kernel.js";
import { printReceipt, testHeader, testPassed, testFailed, summary, fatal, detail } from "../helpers/log.js";
import { deployKernelTestbed, type KernelTestContext } from "./setup.js";
import { encodeExecMode, encodeSingleExec } from "../helpers/exec-encoding.js";

// secp256k1 curve order
const SECP256K1_N = 0xFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFEBAAEDCE6AF48A03BBFD25E8CD0364141n;

/** Build a frame tx and return the params + sigHash (without signing). */
async function buildFrameTxParams(
  ctx: KernelTestContext,
  senderCalldata: Hex,
): Promise<{ params: FrameTxParams; sigHash: Hex }> {
  const { publicClient, kernelAddr } = ctx;
  const kernelNonce = await publicClient.getTransactionCount({ address: kernelAddr });
  const block = await publicClient.getBlock();
  const gasFeeCap = block.baseFeePerGas! + 2_000_000_000n;

  const params: FrameTxParams = {
    chainId: BigInt(CHAIN_ID),
    nonce: BigInt(kernelNonce),
    sender: kernelAddr,
    gasTipCap: 1_000_000_000n,
    gasFeeCap,
    frames: [
      { mode: FRAME_MODE_VERIFY, target: null, gasLimit: 300_000n, data: new Uint8Array(0) },
      { mode: FRAME_MODE_SENDER, target: null, gasLimit: 500_000n, data: hexToBytes(senderCalldata) },
    ],
    blobFeeCap: 0n,
    blobHashes: [],
  };

  const sigHash = computeSigHash(params);
  return { params, sigHash };
}

/** Send a frame tx with a pre-built packed signature. Expects failure (revert/rejection). */
async function sendFrameTxExpectFail(
  ctx: KernelTestContext,
  params: FrameTxParams,
  packedSig: Uint8Array,
): Promise<boolean> {
  const validateCalldata = encodeFunctionData({
    abi: kernelAbi,
    functionName: "validate",
    args: [bytesToHex(packedSig), 2],
  });
  params.frames[0].data = hexToBytes(validateCalldata);

  const rawTx = encodeFrameTx(params);
  try {
    const txHash = (await ctx.publicClient.request({
      method: "eth_sendRawTransaction" as any,
      params: [rawTx],
    })) as Hash;

    // If tx was accepted, check receipt for failure
    const receipt = await waitForReceipt(ctx.publicClient, txHash);
    detail(`Receipt status: ${receipt.status}`);
    if (receipt.frameReceipts) {
      for (let i = 0; i < receipt.frameReceipts.length; i++) {
        detail(`  Frame[${i}] status: ${receipt.frameReceipts[i].status}`);
      }
    }

    // VERIFY frame must fail for the security check to pass
    const verifyStatus = receipt.frameReceipts?.[0]?.status;
    const senderStatus = receipt.frameReceipts?.[1]?.status;
    if (verifyStatus === "0x0") return true;
    if (senderStatus === "0x0") return true;
    if (receipt.status !== "0x1") return true;
    return false;
  } catch (err: any) {
    // Transaction rejected by node — expected behavior
    detail(`Rejected: ${err.message?.slice(0, 80) || err}`);
    return true;
  }
}

async function main() {
  const ctx = await deployKernelTestbed();
  let passed = 0;
  let total = 0;

  // Use a no-op SENDER call for all tests
  const execMode = encodeExecMode("0x00" as Hex, "0x00" as Hex);
  const senderCalldata = encodeFunctionData({
    abi: kernelAbi,
    functionName: "execute",
    args: [execMode, encodeSingleExec(DEAD_ADDR, 0n)],
  });

  // ── Test 1: Reject malleable (high-s) ECDSA signature ───────────────
  testHeader(++total, "Reject malleable (high-s) ECDSA signature");
  {
    const { params, sigHash } = await buildFrameTxParams(ctx, senderCalldata);

    // Sign normally (low-s, as @noble/curves enforces)
    const { r, s, v } = signFrameHash(sigHash, DEV_KEY);

    // Create high-s variant: s_high = n - s, v_flipped = 1 - v
    const sHigh = SECP256K1_N - s;
    const vFlipped = 1 - v;

    const rHex = r.toString(16).padStart(64, "0");
    const sHighHex = sHigh.toString(16).padStart(64, "0");
    const malleableSig = hexToBytes(
      ("0x" + rHex + sHighHex + vFlipped.toString(16).padStart(2, "0")) as Hex
    );

    detail(`Original s:  0x${s.toString(16).slice(0, 16)}...`);
    detail(`Malleable s: 0x${sHigh.toString(16).slice(0, 16)}...`);
    detail(`Half-n:      0x7fffffffffffffffffffffffffffffff5d576e73...`);

    const rejected = await sendFrameTxExpectFail(ctx, params, malleableSig);
    if (rejected) {
      passed++;
      testPassed("Malleable signature correctly rejected");
    } else {
      testFailed("Malleable signature was NOT rejected — K-06 fix missing!");
    }
  }

  // ── Test 2: Reject wrong signer ──────────────────────────────────────
  testHeader(++total, "Reject wrong signer");
  {
    const { params, sigHash } = await buildFrameTxParams(ctx, senderCalldata);

    // Sign with a different key (not the registered owner)
    const { packed: wrongSig } = signFrameHash(sigHash, SECOND_OWNER_KEY);

    const rejected = await sendFrameTxExpectFail(ctx, params, wrongSig);
    if (rejected) {
      passed++;
      testPassed("Wrong signer correctly rejected");
    } else {
      testFailed("Wrong signer was NOT rejected!");
    }
  }

  // ── Test 3: Valid signature still works ──────────────────────────────
  testHeader(++total, "Valid signature still accepted (sanity check)");
  {
    const { params, sigHash } = await buildFrameTxParams(ctx, senderCalldata);
    const { packed: validSig } = signFrameHash(sigHash, DEV_KEY);

    const validateCalldata2 = encodeFunctionData({
      abi: kernelAbi,
      functionName: "validate",
      args: [bytesToHex(validSig), 2],
    });
    params.frames[0].data = hexToBytes(validateCalldata2);

    const rawTx = encodeFrameTx(params);
    const txHash = (await ctx.publicClient.request({
      method: "eth_sendRawTransaction" as any,
      params: [rawTx],
    })) as Hash;
    const receipt = await waitForReceipt(ctx.publicClient, txHash);
    printReceipt(receipt);
    verifyReceipt(receipt, ctx.kernelAddr, { expectVerifyStatus: "0x4|0x2" });
    passed++;
    testPassed("Valid signature accepted");
  }

  summary("Kernel Security", passed, total);
  if (passed < total) process.exit(1);
}

main().catch((err) => {
  fatal(err);
  process.exit(1);
});
