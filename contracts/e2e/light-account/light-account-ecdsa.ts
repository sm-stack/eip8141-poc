/**
 * E2E: LightAccount8141 EOA owner execution
 *
 * Usage: cd contracts && npx tsx e2e/light-account/light-account-ecdsa.ts
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
import { testHeader, testPassed, summary, fatal } from "../helpers/log.js";
import { deployLightAccountTestbed } from "./setup.js";

async function sendFrameTx(
  publicClient: any,
  walletAddr: Address,
  senderCalldata: Hex,
  privKey: Hex
): Promise<any> {
  const nonce = await publicClient.getTransactionCount({ address: walletAddr });
  const block = await publicClient.getBlock();
  const gasFeeCap = block.baseFeePerGas! + 2_000_000_000n;

  const frameTxParams: FrameTxParams = {
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

  // Sign
  const sigHash = computeSigHash(frameTxParams);
  const sig = secp256k1.sign(sigHash.slice(2), privKey.slice(2));
  const rHex = sig.r.toString(16).padStart(64, "0");
  const sHex = sig.s.toString(16).padStart(64, "0");
  const v = sig.recovery;
  const ecdsaSig = hexToBytes(("0x" + rHex + sHex + v.toString(16).padStart(2, "0")) as Hex);

  // Wrap: [0x00 (EOA type)] + [65-byte ECDSA signature]
  const typedSig = new Uint8Array(1 + ecdsaSig.length);
  typedSig[0] = 0x00; // SignatureType.EOA
  typedSig.set(ecdsaSig, 1);

  const validateCalldata = encodeFunctionData({
    abi: walletAbi,
    functionName: "validate",
    args: [bytesToHex(typedSig), 2], // scope = BOTH
  });
  frameTxParams.frames[0].data = hexToBytes(validateCalldata);

  const rawTx = encodeFrameTx(frameTxParams);
  const txHash = (await publicClient.request({
    method: "eth_sendRawTransaction" as any,
    params: [rawTx],
  })) as Hash;
  return await waitForReceipt(publicClient, txHash);
}

async function main() {
  const ctx = await deployLightAccountTestbed();

  testHeader(1, "Execute ETH transfer with EOA owner");
  {
    const calldata = encodeFunctionData({
      abi: walletAbi,
      functionName: "execute",
      args: [DEAD_ADDR, 0n, "0x"],
    });
    const receipt = await sendFrameTx(ctx.publicClient, ctx.walletAddr, calldata, DEV_KEY);
    printReceipt(receipt);
    verifyReceipt(receipt, ctx.walletAddr, { expectVerifyStatus: "0x4|0x2" });
    testPassed("EOA owner executed successfully");
  }

  testHeader(2, "Execute batch (no value)");
  {
    const calldata = encodeFunctionData({
      abi: walletAbi,
      functionName: "executeBatch",
      args: [[DEAD_ADDR, DEAD_ADDR], ["0x", "0x"]],
    });
    const receipt = await sendFrameTx(ctx.publicClient, ctx.walletAddr, calldata, DEV_KEY);
    printReceipt(receipt);
    verifyReceipt(receipt, ctx.walletAddr, { expectVerifyStatus: "0x4|0x2" });
    testPassed("Batch execution (no value) succeeded");
  }

  testHeader(3, "Transfer ownership via SENDER frame");
  {
    const { privateKeyToAccount } = await import("viem/accounts");
    const newOwnerAccount = privateKeyToAccount(SECOND_OWNER_KEY);
    const newOwnerAddr = newOwnerAccount.address;

    // Transfer ownership
    const transferCalldata = encodeFunctionData({
      abi: walletAbi,
      functionName: "transferOwnership",
      args: [newOwnerAddr],
    });
    // Wrap in execute self-call
    const calldata = encodeFunctionData({
      abi: walletAbi,
      functionName: "execute",
      args: [ctx.walletAddr, 0n, transferCalldata],
    });
    const receipt = await sendFrameTx(ctx.publicClient, ctx.walletAddr, calldata, DEV_KEY);
    printReceipt(receipt);
    verifyReceipt(receipt, ctx.walletAddr, { expectVerifyStatus: "0x4|0x2" });

    // Verify new owner
    const currentOwner = await ctx.publicClient.readContract({
      address: ctx.walletAddr,
      abi: walletAbi,
      functionName: "owner",
    }) as Address;
    if (currentOwner.toLowerCase() !== newOwnerAddr.toLowerCase()) {
      throw new Error(`Owner transfer failed: expected ${newOwnerAddr}, got ${currentOwner}`);
    }
    testPassed(`Ownership transferred to ${newOwnerAddr}`);

    // Execute with new owner
    testHeader(4, "Execute with new owner after transfer");
    const calldata2 = encodeFunctionData({
      abi: walletAbi,
      functionName: "execute",
      args: [DEAD_ADDR, 0n, "0x"],
    });
    const receipt2 = await sendFrameTx(ctx.publicClient, ctx.walletAddr, calldata2, SECOND_OWNER_KEY);
    printReceipt(receipt2);
    verifyReceipt(receipt2, ctx.walletAddr, { expectVerifyStatus: "0x4|0x2" });
    testPassed("New owner executed successfully");
  }

  summary("LightAccount ECDSA", 4);
}

main().catch((err) => {
  fatal(err);
  process.exit(1);
});
