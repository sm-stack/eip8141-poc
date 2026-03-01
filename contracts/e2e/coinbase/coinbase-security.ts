/**
 * E2E: CoinbaseSmartWallet8141 Security Tests
 *
 * Tests for security fixes:
 * - K-06: Reject malleable (high-s) ECDSA signatures
 * - C-02: Reject address(0) owner during initialization
 * - Wrong signer rejection
 *
 * Usage: cd contracts && npx tsx e2e/coinbase/coinbase-security.ts
 */

import {
  encodeAbiParameters,
  parseAbiParameters,
  encodeFunctionData,
  hexToBytes,
  bytesToHex,
  type Hex,
  type Hash,
  type Address,
} from "viem";
import { secp256k1 } from "@noble/curves/secp256k1";
import { CHAIN_ID, DEV_KEY, SECOND_OWNER_KEY, DEAD_ADDR, FRAME_MODE_VERIFY, FRAME_MODE_SENDER } from "../helpers/config.js";
import { createTestClients, waitForReceipt, fundAccount } from "../helpers/client.js";
import { loadBytecode, deployContract } from "../helpers/deploy.js";
import { computeSigHash, encodeFrameTx, type FrameTxParams } from "../helpers/frame-tx.js";
import { verifyReceipt } from "../helpers/receipt.js";
import { walletAbi, factoryAbi } from "../helpers/abis/coinbase.js";
import { printReceipt, testHeader, testPassed, testFailed, summary, fatal, banner, sectionHeader, detail, success } from "../helpers/log.js";
import { deployCoinbaseTestbed } from "./setup.js";

// secp256k1 curve order
const SECP256K1_N = 0xFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFEBAAEDCE6AF48A03BBFD25E8CD0364141n;

/** Build frame tx params for Coinbase wallet. */
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

/** Sign with secp256k1 and return { r, s, v } as bigint/number. */
function signRaw(sigHash: Hex, privKey: Hex) {
  const sig = secp256k1.sign(sigHash.slice(2), privKey.slice(2));
  return { r: sig.r, s: sig.s, v: sig.recovery };
}

/** Pack (r, s, v) into 65-byte signature. */
function packSig(r: bigint, s: bigint, v: number): Uint8Array {
  const rHex = r.toString(16).padStart(64, "0");
  const sHex = s.toString(16).padStart(64, "0");
  return hexToBytes(("0x" + rHex + sHex + v.toString(16).padStart(2, "0")) as Hex);
}

/** Send a frame tx with a pre-built ECDSA sig for Coinbase wallet. Expects failure. */
async function sendFrameTxExpectFail(
  publicClient: any,
  walletAddr: Address,
  params: FrameTxParams,
  ownerIndex: number,
  ecdsaSig: Uint8Array,
): Promise<boolean> {
  const signatureWrapper = encodeAbiParameters(
    parseAbiParameters("uint256, bytes"),
    [BigInt(ownerIndex), bytesToHex(ecdsaSig)]
  );
  const validateCalldata = encodeFunctionData({
    abi: walletAbi,
    functionName: "validate",
    args: [signatureWrapper, 2],
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
  const ctx = await deployCoinbaseTestbed();
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

    // Create high-s variant
    const sHigh = SECP256K1_N - s;
    const vFlipped = 1 - v;
    const malleableSig = packSig(r, sHigh, vFlipped);

    detail(`Original s:  0x${s.toString(16).slice(0, 16)}...`);
    detail(`Malleable s: 0x${sHigh.toString(16).slice(0, 16)}...`);

    const rejected = await sendFrameTxExpectFail(
      ctx.publicClient, ctx.walletAddr, params, 0, malleableSig
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
    const wrongSig = packSig(r, s, v);

    const rejected = await sendFrameTxExpectFail(
      ctx.publicClient, ctx.walletAddr, params, 0, wrongSig
    );
    if (rejected) {
      passed++;
      testPassed("Wrong signer correctly rejected");
    } else {
      testFailed("Wrong signer was NOT rejected!");
    }
  }

  // ── Test 3: Reject address(0) owner during factory initialization ───
  testHeader(++total, "Reject address(0) owner during initialization (C-02)");
  {
    const { publicClient, walletClient } = ctx;

    // Deploy fresh impl + factory for isolated test
    const implBytecode = loadBytecode("CoinbaseSmartWallet8141");
    const { address: implAddr } = await deployContract(
      walletClient, publicClient, implBytecode, 5_000_000n, "CoinbaseSmartWallet8141 (test)"
    );
    const factoryBytecode = loadBytecode("CoinbaseSmartWalletFactory8141");
    const factoryConstructorArgs = encodeAbiParameters(
      parseAbiParameters("address"),
      [implAddr]
    );
    const factoryDeployData = (factoryBytecode + factoryConstructorArgs.slice(2)) as Hex;
    const { address: factoryAddr } = await deployContract(
      walletClient, publicClient, factoryDeployData, 3_000_000n, "Factory (test)"
    );

    // Try to create account with address(0) as owner
    const zeroOwners = [
      encodeAbiParameters(parseAbiParameters("address"), [
        "0x0000000000000000000000000000000000000000" as Address,
      ]),
    ];

    try {
      const createData = encodeFunctionData({
        abi: factoryAbi,
        functionName: "createAccount",
        args: [zeroOwners, 99n], // different nonce
      });
      const createHash = await walletClient.sendTransaction({
        to: factoryAddr,
        data: createData,
        gas: 5_000_000n,
        maxFeePerGas: 10_000_000_000n,
        maxPriorityFeePerGas: 1_000_000_000n,
      });
      const receipt = await publicClient.waitForTransactionReceipt({ hash: createHash });
      if (receipt.status === "success") {
        testFailed("address(0) owner was NOT rejected — C-02 fix missing!");
      } else {
        passed++;
        testPassed("address(0) owner correctly rejected (tx reverted)");
      }
    } catch (err: any) {
      passed++;
      detail(`Rejected: ${err.message?.slice(0, 80) || err}`);
      testPassed("address(0) owner correctly rejected");
    }
  }

  // ── Test 4: Valid signature still works (sanity check) ──────────────
  testHeader(++total, "Valid signature still accepted (sanity check)");
  {
    const { params, sigHash } = await buildFrameTxParams(ctx.publicClient, ctx.walletAddr, senderCalldata);
    const { r, s, v } = signRaw(sigHash, DEV_KEY);
    const validSig = packSig(r, s, v);

    const signatureWrapper = encodeAbiParameters(
      parseAbiParameters("uint256, bytes"),
      [0n, bytesToHex(validSig)]
    );
    const validateCalldata = encodeFunctionData({
      abi: walletAbi,
      functionName: "validate",
      args: [signatureWrapper, 2],
    });
    params.frames[0].data = hexToBytes(validateCalldata);

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

  summary("Coinbase Security", passed, total);
  if (passed < total) process.exit(1);
}

main().catch((err) => {
  fatal(err);
  process.exit(1);
});
