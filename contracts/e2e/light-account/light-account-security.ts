/**
 * E2E: LightAccount8141 Security Tests
 *
 * Tests for security fixes:
 * - K-06: Reject malleable (high-s) ECDSA signatures
 * - Wrong signer rejection
 *
 * Usage: cd contracts && npx tsx e2e/light-account/light-account-security.ts
 */

import {
  encodeFunctionData,
  hexToBytes,
  bytesToHex,
  type Hex,
  type Hash,
  type Address,
} from "viem";
import { secp256k1 } from "@noble/curves/secp256k1";
import { CHAIN_ID, DEV_KEY, SECOND_OWNER_KEY, DEAD_ADDR, FRAME_MODE_VERIFY, FRAME_MODE_SENDER } from "../helpers/config.js";
import { waitForReceipt } from "../helpers/client.js";
import { computeSigHash, encodeFrameTx, type FrameTxParams } from "../helpers/frame-tx.js";
import { printReceipt, verifyReceipt } from "../helpers/receipt.js";
import { walletAbi } from "../helpers/abis/light-account.js";
import { testHeader, testPassed, testFailed, summary, fatal, detail } from "../helpers/log.js";
import { deployLightAccountTestbed } from "./setup.js";

// secp256k1 curve order
const SECP256K1_N = 0xFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFEBAAEDCE6AF48A03BBFD25E8CD0364141n;

/** Build frame tx params for LightAccount wallet. */
async function buildFrameTxParams(
  publicClient: any,
  walletAddr: Address,
  senderCalldata: Hex,
): Promise<{ params: FrameTxParams; sigHash: Hex }> {
  const nonce = await publicClient.getTransactionCount({ address: walletAddr });
  const block = await publicClient.getBlock();
  const gasFeeCap = block.baseFeePerGas! + 2_000_000_000n;

  const params: FrameTxParams = {
    chainId: BigInt(CHAIN_ID),
    nonce: BigInt(nonce),
    sender: walletAddr,
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

/** Sign with secp256k1 and return r, s, v. */
function signRaw(sigHash: Hex, privKey: Hex) {
  const sig = secp256k1.sign(sigHash.slice(2), privKey.slice(2));
  return { r: sig.r, s: sig.s, v: sig.recovery };
}

/** Build a typed LightAccount signature: [0x00 (EOA type)] + [65-byte ECDSA sig]. */
function buildTypedSig(r: bigint, s: bigint, v: number): Uint8Array {
  const rHex = r.toString(16).padStart(64, "0");
  const sHex = s.toString(16).padStart(64, "0");
  const ecdsaSig = hexToBytes(("0x" + rHex + sHex + v.toString(16).padStart(2, "0")) as Hex);
  const typedSig = new Uint8Array(1 + ecdsaSig.length);
  typedSig[0] = 0x00; // SignatureType.EOA
  typedSig.set(ecdsaSig, 1);
  return typedSig;
}

/** Send a frame tx with typed signature. Expects failure. */
async function sendFrameTxExpectFail(
  publicClient: any,
  walletAddr: Address,
  params: FrameTxParams,
  typedSig: Uint8Array,
): Promise<boolean> {
  const validateCalldata = encodeFunctionData({
    abi: walletAbi,
    functionName: "validate",
    args: [bytesToHex(typedSig), 2],
  });
  params.frames[0].data = hexToBytes(validateCalldata);

  const rawTx = encodeFrameTx(params);
  try {
    const txHash = (await publicClient.request({
      method: "eth_sendRawTransaction" as any,
      params: [rawTx],
    })) as Hash;

    const receipt = await waitForReceipt(publicClient, txHash);
    if (receipt.status === "0x1") {
      if (receipt.frameReceipts?.[0]?.status === "0x0") {
        return true; // VERIFY failed as expected
      }
      return false; // Tx succeeded — security check failed
    }
    return true; // Tx failed as expected
  } catch (err: any) {
    detail(`Rejected: ${err.message?.slice(0, 80) || err}`);
    return true;
  }
}

async function main() {
  const ctx = await deployLightAccountTestbed();
  let passed = 0;
  let total = 0;

  const senderCalldata = encodeFunctionData({
    abi: walletAbi,
    functionName: "execute",
    args: [DEAD_ADDR, 0n, "0x"],
  });

  // ── Test 1: Reject malleable (high-s) ECDSA signature ───────────────
  testHeader(++total, "Reject malleable (high-s) ECDSA signature");
  {
    const { params, sigHash } = await buildFrameTxParams(ctx.publicClient, ctx.walletAddr, senderCalldata);
    const { r, s, v } = signRaw(sigHash, DEV_KEY);

    // Create high-s variant: s_high = n - s, v_flipped = 1 - v
    const sHigh = SECP256K1_N - s;
    const vFlipped = 1 - v;
    const malleableSig = buildTypedSig(r, sHigh, vFlipped);

    detail(`Original s:  0x${s.toString(16).slice(0, 16)}...`);
    detail(`Malleable s: 0x${sHigh.toString(16).slice(0, 16)}...`);

    const rejected = await sendFrameTxExpectFail(
      ctx.publicClient, ctx.walletAddr, params, malleableSig
    );
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
    const { params, sigHash } = await buildFrameTxParams(ctx.publicClient, ctx.walletAddr, senderCalldata);
    const { r, s, v } = signRaw(sigHash, SECOND_OWNER_KEY);
    const wrongSig = buildTypedSig(r, s, v);

    const rejected = await sendFrameTxExpectFail(
      ctx.publicClient, ctx.walletAddr, params, wrongSig
    );
    if (rejected) {
      passed++;
      testPassed("Wrong signer correctly rejected");
    } else {
      testFailed("Wrong signer was NOT rejected!");
    }
  }

  // ── Test 3: Valid signature still works (sanity check) ──────────────
  testHeader(++total, "Valid signature still accepted (sanity check)");
  {
    const { params, sigHash } = await buildFrameTxParams(ctx.publicClient, ctx.walletAddr, senderCalldata);
    const { r, s, v } = signRaw(sigHash, DEV_KEY);
    const validSig = buildTypedSig(r, s, v);

    const validateCalldata2 = encodeFunctionData({
      abi: walletAbi,
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
    verifyReceipt(receipt, ctx.walletAddr, { expectVerifyStatus: "0x4|0x2" });
    passed++;
    testPassed("Valid signature accepted");
  }

  summary("LightAccount Security", passed, total);
  if (passed < total) process.exit(1);
}

main().catch((err) => {
  fatal(err);
  process.exit(1);
});
