/**
 * E2E: Simple8141Account basic frame transaction
 *
 * Deploys Simple8141Account, funds it, constructs a raw EIP-8141 FrameTx
 * with VERIFY + SENDER frames, signs with secp256k1, and verifies receipt.
 *
 * Usage: cd contracts && npx tsx e2e/simple/simple-basic.ts
 */

import {
  encodeAbiParameters,
  parseAbiParameters,
  getContractAddress,
  hexToBytes,
  type Hex,
  type Address,
  type Hash,
  formatEther,
} from "viem";
import {
  CHAIN_ID,
  DEV_KEY,
  DEAD_ADDR,
  FRAME_MODE_VERIFY,
  FRAME_MODE_SENDER,
  CHAIN_DEF,
} from "../helpers/config.js";
import { createTestClients, waitForReceipt, fundAccount } from "../helpers/client.js";
import { loadBytecode } from "../helpers/deploy.js";
import { computeSigHash, encodeFrameTx, type FrameTxParams } from "../helpers/frame-tx.js";
import { signFrameHash } from "../helpers/signing.js";
import { printReceipt, verifyReceipt } from "../helpers/receipt.js";
import { SIMPLE_VALIDATE_SELECTOR } from "../helpers/abis/simple.js";

async function main() {
  const { publicClient, walletClient, devAddr } = createTestClients();

  const balance = await publicClient.getBalance({ address: devAddr });
  console.log(`Dev account ${devAddr} balance: ${formatEther(balance)} ETH`);

  // 1. Deploy Simple8141Account(ownerAddr)
  const ownerAddr = devAddr;
  const initCode = loadBytecode("Simple8141Account");
  const constructorArg = encodeAbiParameters(parseAbiParameters("address"), [
    ownerAddr,
  ]);
  const deployData = (initCode + constructorArg.slice(2)) as Hex;

  const deployNonce = await publicClient.getTransactionCount({
    address: devAddr,
  });
  const simple8141AccountAddr = getContractAddress({
    from: devAddr,
    nonce: BigInt(deployNonce),
  });
  console.log(`Expected Simple8141Account address: ${simple8141AccountAddr}`);

  const deployHash = await walletClient.sendTransaction({
    chain: CHAIN_DEF,
    data: deployData,
    gas: 2_000_000n,
    maxFeePerGas: 10_000_000_000n,
    maxPriorityFeePerGas: 1_000_000_000n,
  });
  console.log(`Deploy tx: ${deployHash}`);

  const deployReceipt = await waitForReceipt(publicClient, deployHash);
  console.log(
    `Deploy receipt: status=${deployReceipt.status}, contract=${deployReceipt.contractAddress}`
  );
  if (deployReceipt.status !== "0x1") {
    throw new Error(`Deploy failed: status=${deployReceipt.status}`);
  }

  // 2. Fund with 10 ETH
  await fundAccount(walletClient, publicClient, simple8141AccountAddr);
  console.log("Funded with 10 ETH");

  // 3. Build FrameTx
  const accountNonce = await publicClient.getTransactionCount({
    address: simple8141AccountAddr,
  });
  const block = await publicClient.getBlock();
  const baseFee = block.baseFeePerGas!;
  const gasFeeCap = baseFee + 2_000_000_000n;

  const frameTxParams: FrameTxParams = {
    chainId: BigInt(CHAIN_ID),
    nonce: BigInt(accountNonce),
    sender: simple8141AccountAddr,
    gasTipCap: 1_000_000_000n,
    gasFeeCap,
    frames: [
      {
        mode: FRAME_MODE_VERIFY,
        target: null,
        gasLimit: 200_000n,
        data: new Uint8Array(0),
      },
      {
        mode: FRAME_MODE_SENDER,
        target: DEAD_ADDR as Address | null,
        gasLimit: 50_000n,
        data: new Uint8Array(0),
      },
    ],
    blobFeeCap: 0n,
    blobHashes: [],
  };

  // 4. Compute sigHash and sign
  const sigHash = computeSigHash(frameTxParams);
  console.log(`SigHash: ${sigHash}`);

  const { r, s, v } = signFrameHash(sigHash, DEV_KEY);

  // Manually construct validate(uint8 v, bytes32 r, bytes32 s, uint8 scope) calldata
  // Selector: 0xf2d64fed
  const validateSelector = hexToBytes(SIMPLE_VALIDATE_SELECTOR as Hex);
  const calldata = new Uint8Array(4 + 32 * 4); // 132 bytes
  calldata.set(validateSelector, 0);
  calldata[35] = v + 27; // uint8 v in last byte of word 1

  const rHex = r.toString(16).padStart(64, "0");
  const rBytes = hexToBytes(("0x" + rHex) as Hex);
  calldata.set(rBytes, 36);

  const sHex = s.toString(16).padStart(64, "0");
  const sBytes = hexToBytes(("0x" + sHex) as Hex);
  calldata.set(sBytes, 68);

  calldata[131] = 2; // scope=2 (both)

  if (calldata.length !== 132) {
    throw new Error(`Calldata length mismatch: got ${calldata.length}, want 132`);
  }

  frameTxParams.frames[0].data = calldata;

  // 5. Encode and send
  const rawTx = encodeFrameTx(frameTxParams);
  console.log(`FrameTx raw length: ${rawTx.length / 2 - 1} bytes`);

  const txHash = (await publicClient.request({
    method: "eth_sendRawTransaction" as any,
    params: [rawTx],
  })) as Hash;
  console.log(`FrameTx hash: ${txHash}`);

  // 6. Verify
  const frameReceipt = await waitForReceipt(publicClient, txHash);
  printReceipt(frameReceipt);
  verifyReceipt(frameReceipt, simple8141AccountAddr);

  console.log("\n=== SIMPLE8141 E2E TEST PASSED ===");
}

main().catch((err) => {
  console.error("FATAL:", err.message || err);
  process.exit(1);
});
