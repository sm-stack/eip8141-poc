/**
 * E2E: CoinbaseSmartWallet8141 Owner Management
 *
 * Tests:
 * 1. ownerCount / removedOwnersCount initial state
 * 2. addOwnerAddress via SENDER frame
 * 3. removeOwnerAtIndex via SENDER frame
 *
 * Usage: cd contracts && npx tsx e2e/coinbase/coinbase-owner-mgmt.ts
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
import { CHAIN_ID, DEV_KEY, FRAME_MODE_VERIFY, FRAME_MODE_SENDER } from "../helpers/config.js";
import { waitForReceipt } from "../helpers/client.js";
import { computeSigHash, encodeFrameTx, type FrameTxParams } from "../helpers/frame-tx.js";
import { printReceipt, verifyReceipt } from "../helpers/receipt.js";
import { walletAbi } from "../helpers/abis/coinbase.js";
import { testHeader, testPassed, summary, fatal } from "../helpers/log.js";
import { deployCoinbaseTestbed } from "./setup.js";

/** Send a frame tx: VERIFY(validate) + SENDER(calldata), signed by owner at ownerIndex. */
async function sendOwnerFrameTx(
  publicClient: any,
  walletAddr: Address,
  senderCalldata: Hex,
  ownerIndex: number,
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

  const sigHash = computeSigHash(frameTxParams);
  const sig = secp256k1.sign(sigHash.slice(2), privKey.slice(2));
  const rHex = sig.r.toString(16).padStart(64, "0");
  const sHex = sig.s.toString(16).padStart(64, "0");
  const v = sig.recovery;
  const ecdsaSig = hexToBytes(("0x" + rHex + sHex + v.toString(16).padStart(2, "0")) as Hex);

  const signatureWrapper = encodeAbiParameters(
    parseAbiParameters("uint256, bytes"),
    [BigInt(ownerIndex), bytesToHex(ecdsaSig)]
  );
  const validateCalldata = encodeFunctionData({
    abi: walletAbi,
    functionName: "validate",
    args: [signatureWrapper, 2],
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
  const ctx = await deployCoinbaseTestbed();

  testHeader(1, "ownerCount / removedOwnersCount initial state");
  {
    const ownerCount = await ctx.publicClient.readContract({
      address: ctx.walletAddr,
      abi: walletAbi,
      functionName: "ownerCount",
    });
    const removedCount = await ctx.publicClient.readContract({
      address: ctx.walletAddr,
      abi: walletAbi,
      functionName: "removedOwnersCount",
    });
    const nextIndex = await ctx.publicClient.readContract({
      address: ctx.walletAddr,
      abi: walletAbi,
      functionName: "nextOwnerIndex",
    });

    if (Number(ownerCount) !== 3) throw new Error(`Expected ownerCount=3, got ${ownerCount}`);
    if (Number(removedCount) !== 0) throw new Error(`Expected removedOwnersCount=0, got ${removedCount}`);
    if (Number(nextIndex) !== 3) throw new Error(`Expected nextOwnerIndex=3, got ${nextIndex}`);

    testPassed(`ownerCount=${ownerCount}, removedOwnersCount=${removedCount}, nextOwnerIndex=${nextIndex}`);
  }

  testHeader(2, "addOwnerAddress via SENDER frame");
  {
    const newOwner = "0x0000000000000000000000000000000000004444" as Address;

    const senderCalldata = encodeFunctionData({
      abi: walletAbi,
      functionName: "addOwnerAddress",
      args: [newOwner],
    });

    const receipt = await sendOwnerFrameTx(ctx.publicClient, ctx.walletAddr, senderCalldata, 0, DEV_KEY);
    printReceipt(receipt);
    verifyReceipt(receipt, ctx.walletAddr, { expectVerifyStatus: "0x4|0x2" });

    // Verify new owner was added
    const isOwner = await ctx.publicClient.readContract({
      address: ctx.walletAddr,
      abi: walletAbi,
      functionName: "isOwnerAddress",
      args: [newOwner],
    });
    if (!isOwner) throw new Error("New owner not added");

    const ownerCount = await ctx.publicClient.readContract({
      address: ctx.walletAddr,
      abi: walletAbi,
      functionName: "ownerCount",
    });
    if (Number(ownerCount) !== 4) throw new Error(`Expected ownerCount=4, got ${ownerCount}`);

    const nextIndex = await ctx.publicClient.readContract({
      address: ctx.walletAddr,
      abi: walletAbi,
      functionName: "nextOwnerIndex",
    });
    if (Number(nextIndex) !== 4) throw new Error(`Expected nextOwnerIndex=4, got ${nextIndex}`);

    testPassed(`addOwnerAddress succeeded, ownerCount=${ownerCount}`);
  }

  testHeader(3, "removeOwnerAtIndex via SENDER frame");
  {
    // Remove the owner we just added (index=3, which is the new owner at index 3)
    const newOwner = "0x0000000000000000000000000000000000004444" as Address;
    const ownerBytes = encodeAbiParameters(parseAbiParameters("address"), [newOwner]);

    const senderCalldata = encodeFunctionData({
      abi: walletAbi,
      functionName: "removeOwnerAtIndex",
      args: [3n, ownerBytes],
    });

    const receipt = await sendOwnerFrameTx(ctx.publicClient, ctx.walletAddr, senderCalldata, 0, DEV_KEY);
    printReceipt(receipt);
    verifyReceipt(receipt, ctx.walletAddr, { expectVerifyStatus: "0x4|0x2" });

    // Verify owner was removed
    const isOwner = await ctx.publicClient.readContract({
      address: ctx.walletAddr,
      abi: walletAbi,
      functionName: "isOwnerAddress",
      args: [newOwner],
    });
    if (isOwner) throw new Error("Owner not removed");

    const ownerCount = await ctx.publicClient.readContract({
      address: ctx.walletAddr,
      abi: walletAbi,
      functionName: "ownerCount",
    });
    if (Number(ownerCount) !== 3) throw new Error(`Expected ownerCount=3, got ${ownerCount}`);

    const removedCount = await ctx.publicClient.readContract({
      address: ctx.walletAddr,
      abi: walletAbi,
      functionName: "removedOwnersCount",
    });
    if (Number(removedCount) !== 1) throw new Error(`Expected removedOwnersCount=1, got ${removedCount}`);

    testPassed(`removeOwnerAtIndex succeeded, ownerCount=${ownerCount}, removedOwnersCount=${removedCount}`);
  }

  summary("Coinbase Owner Management", 3);
}

main().catch((err) => {
  fatal(err);
  process.exit(1);
});
