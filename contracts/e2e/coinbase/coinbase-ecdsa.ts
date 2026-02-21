/**
 * E2E: CoinbaseSmartWallet8141 ECDSA owner execution (Tests 1-2)
 *
 * Tests multi-owner ECDSA signing with owner index-based signature wrapping.
 *
 * Usage: cd contracts && npx tsx e2e/coinbase/coinbase-ecdsa.ts
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
import { CHAIN_ID, DEV_KEY, OWNER2_KEY, DEAD_ADDR, FRAME_MODE_VERIFY, FRAME_MODE_SENDER } from "../helpers/config.js";
import { waitForReceipt } from "../helpers/client.js";
import { computeSigHash, encodeFrameTx, type FrameTxParams } from "../helpers/frame-tx.js";
import { printReceipt, verifyReceipt } from "../helpers/receipt.js";
import { walletAbi } from "../helpers/abis/coinbase.js";
import { deployCoinbaseTestbed } from "./setup.js";

async function sendFrameTx(
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
  const ecdsaSig = hexToBytes(
    ("0x" + rHex + sHex + v.toString(16).padStart(2, "0")) as Hex
  );

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

  // Test 1: Execute with ECDSA Owner 1
  console.log(`${"~".repeat(70)}`);
  console.log(`Test 1: Execute with ECDSA Owner 1`);
  console.log(`${"~".repeat(70)}`);
  {
    const calldata = encodeFunctionData({
      abi: walletAbi,
      functionName: "execute",
      args: [DEAD_ADDR, 0n, "0x"],
    });
    const receipt = await sendFrameTx(
      ctx.publicClient,
      ctx.walletAddr,
      calldata,
      0,
      DEV_KEY
    );
    printReceipt(receipt);
    verifyReceipt(receipt, ctx.walletAddr, { expectVerifyStatus: "0x4|0x2" });
    console.log("PASSED - ECDSA Owner 1 executed successfully\n");
  }

  // Test 2: Execute with ECDSA Owner 2
  console.log(`${"~".repeat(70)}`);
  console.log(`Test 2: Execute with ECDSA Owner 2`);
  console.log(`${"~".repeat(70)}`);
  {
    const calldata = encodeFunctionData({
      abi: walletAbi,
      functionName: "execute",
      args: [DEAD_ADDR, 0n, "0x"],
    });
    const receipt = await sendFrameTx(
      ctx.publicClient,
      ctx.walletAddr,
      calldata,
      1,
      OWNER2_KEY
    );
    printReceipt(receipt);
    verifyReceipt(receipt, ctx.walletAddr, { expectVerifyStatus: "0x4|0x2" });
    console.log("PASSED - ECDSA Owner 2 executed successfully\n");
  }

  console.log(`${"=".repeat(70)}`);
  console.log(`ALL 2 COINBASE ECDSA TESTS PASSED`);
  console.log(`${"=".repeat(70)}\n`);
}

main().catch((err) => {
  console.error("FATAL:", err.message || err);
  console.error("Stack:", err.stack);
  process.exit(1);
});
