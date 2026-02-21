/**
 * E2E: SpendingLimitHook enforcement test
 *
 * Deploys Kernel8141 + SpendingLimitHook, installs hook with 5 ETH daily limit,
 * then verifies that a transfer under the limit succeeds and one over the limit fails.
 *
 * Usage: cd contracts && npx tsx e2e/kernel-hooked/spending-limit.ts
 */

import {
  encodeAbiParameters,
  parseAbiParameters,
  encodeFunctionData,
  hexToBytes,
  bytesToHex,
  parseEther,
  formatEther,
  toFunctionSelector,
  type Hex,
  type Hash,
  type Address,
} from "viem";
import { CHAIN_ID, DEV_KEY, DEAD_ADDR, FRAME_MODE_VERIFY, FRAME_MODE_SENDER, CHAIN_DEF } from "../helpers/config.js";
import { createTestClients, waitForReceipt, fundAccount } from "../helpers/client.js";
import { loadBytecode, deployContract } from "../helpers/deploy.js";
import { computeSigHash, encodeFrameTx, type FrameTxParams } from "../helpers/frame-tx.js";
import { signFrameTx } from "../helpers/signing.js";
import { printReceipt, verifyReceipt } from "../helpers/receipt.js";
import { kernelAbi } from "../helpers/abis/kernel.js";

async function sendFrameTx(
  publicClient: any,
  params: FrameTxParams,
  validateCalldata: Hex
): Promise<any> {
  params.frames[0].data = hexToBytes(validateCalldata);
  const rawTx = encodeFrameTx(params);
  const txHash = (await publicClient.request({
    method: "eth_sendRawTransaction" as any,
    params: [rawTx],
  })) as Hash;
  return waitForReceipt(publicClient, txHash);
}

async function main() {
  const { publicClient, walletClient, devAddr } = createTestClients();

  const balance = await publicClient.getBalance({ address: devAddr });
  console.log(`Dev account ${devAddr} balance: ${formatEther(balance)} ETH\n`);

  // Deploy contracts
  console.log("1. Deploying ECDSAValidator...");
  const { address: validatorAddr } = await deployContract(
    walletClient,
    publicClient,
    loadBytecode("ECDSAValidator")
  );

  console.log("\n2. Deploying Kernel8141...");
  const kernelBytecode = loadBytecode("Kernel8141");
  const constructorArgs = encodeAbiParameters(
    parseAbiParameters("address, bytes"),
    [
      validatorAddr,
      encodeAbiParameters(parseAbiParameters("address"), [devAddr]),
    ]
  );
  const kernelDeployData = (kernelBytecode + constructorArgs.slice(2)) as Hex;
  const { address: kernelAddr } = await deployContract(
    walletClient,
    publicClient,
    kernelDeployData,
    6_000_000n
  );

  console.log("\n3. Deploying SpendingLimitHook...");
  const { address: hookAddr } = await deployContract(
    walletClient,
    publicClient,
    loadBytecode("SpendingLimitHook")
  );

  console.log("\n4. Funding Kernel with 10 ETH...");
  await fundAccount(walletClient, publicClient, kernelAddr);
  console.log("  Funded");

  // Install SpendingLimitHook
  console.log("\n5. Installing SpendingLimitHook (5 ETH daily limit)...");

  const executeSelector = toFunctionSelector("execute(address,uint256,bytes)");
  const MODULE_TYPE_PRE_HOOK = 2;
  const dailyLimit = parseEther("5");
  const hookData = encodeAbiParameters(parseAbiParameters("uint256"), [dailyLimit]);
  const moduleConfig = encodeAbiParameters(
    parseAbiParameters("bytes4[], bytes"),
    [[executeSelector], hookData]
  );
  const installCalldata = encodeFunctionData({
    abi: kernelAbi,
    functionName: "installModule",
    args: [MODULE_TYPE_PRE_HOOK, hookAddr, moduleConfig],
  });

  let kernelNonce = await publicClient.getTransactionCount({ address: kernelAddr });
  let block = await publicClient.getBlock();
  let gasFeeCap = block.baseFeePerGas! + 2_000_000_000n;

  let frameTxParams: FrameTxParams = {
    chainId: BigInt(CHAIN_ID),
    nonce: BigInt(kernelNonce),
    sender: kernelAddr,
    gasTipCap: 1_000_000_000n,
    gasFeeCap,
    frames: [
      { mode: FRAME_MODE_VERIFY, target: null, gasLimit: 200_000n, data: new Uint8Array(0) },
      { mode: FRAME_MODE_SENDER, target: null, gasLimit: 300_000n, data: hexToBytes(installCalldata) },
    ],
    blobFeeCap: 0n,
    blobHashes: [],
  };

  const installSig = signFrameTx(frameTxParams, DEV_KEY);
  const installValidateCalldata = encodeFunctionData({
    abi: kernelAbi,
    functionName: "validate",
    args: [installSig, 2],
  });

  const installReceipt = await sendFrameTx(publicClient, frameTxParams, installValidateCalldata);
  printReceipt(installReceipt);
  if (installReceipt.status !== "0x1") {
    throw new Error("Hook installation failed");
  }
  console.log("  SpendingLimitHook installed successfully");

  // Transfer 3 ETH (under limit - should succeed)
  console.log("\n6. Executing transfer of 3 ETH (under 5 ETH limit)...");

  const executeCalldata1 = encodeFunctionData({
    abi: kernelAbi,
    functionName: "execute",
    args: [DEAD_ADDR, parseEther("3"), "0x"],
  });

  kernelNonce = await publicClient.getTransactionCount({ address: kernelAddr });
  block = await publicClient.getBlock();
  gasFeeCap = block.baseFeePerGas! + 2_000_000_000n;

  frameTxParams = {
    chainId: BigInt(CHAIN_ID),
    nonce: BigInt(kernelNonce),
    sender: kernelAddr,
    gasTipCap: 1_000_000_000n,
    gasFeeCap,
    frames: [
      { mode: FRAME_MODE_VERIFY, target: null, gasLimit: 200_000n, data: new Uint8Array(0) },
      { mode: FRAME_MODE_SENDER, target: null, gasLimit: 100_000n, data: hexToBytes(executeCalldata1) },
    ],
    blobFeeCap: 0n,
    blobHashes: [],
  };

  const sig1 = signFrameTx(frameTxParams, DEV_KEY);
  const validateCalldata1 = encodeFunctionData({
    abi: kernelAbi,
    functionName: "validate",
    args: [sig1, 2],
  });

  const receipt1 = await sendFrameTx(publicClient, frameTxParams, validateCalldata1);
  printReceipt(receipt1);
  if (receipt1.status !== "0x1") {
    throw new Error("First transfer should succeed but failed");
  }
  console.log("  Transfer of 3 ETH succeeded (spent: 3/5 ETH)");

  // Transfer 3 ETH (over limit - should fail)
  console.log("\n7. Executing transfer of 3 ETH (over limit - should fail)...");

  const executeCalldata2 = encodeFunctionData({
    abi: kernelAbi,
    functionName: "execute",
    args: [DEAD_ADDR, parseEther("3"), "0x"],
  });

  kernelNonce = await publicClient.getTransactionCount({ address: kernelAddr });
  block = await publicClient.getBlock();
  gasFeeCap = block.baseFeePerGas! + 2_000_000_000n;

  frameTxParams = {
    chainId: BigInt(CHAIN_ID),
    nonce: BigInt(kernelNonce),
    sender: kernelAddr,
    gasTipCap: 1_000_000_000n,
    gasFeeCap,
    frames: [
      { mode: FRAME_MODE_VERIFY, target: null, gasLimit: 200_000n, data: new Uint8Array(0) },
      { mode: FRAME_MODE_SENDER, target: null, gasLimit: 100_000n, data: hexToBytes(executeCalldata2) },
    ],
    blobFeeCap: 0n,
    blobHashes: [],
  };

  const sig2 = signFrameTx(frameTxParams, DEV_KEY);
  const validateCalldata2 = encodeFunctionData({
    abi: kernelAbi,
    functionName: "validate",
    args: [sig2, 2],
  });

  const receipt2 = await sendFrameTx(publicClient, frameTxParams, validateCalldata2);
  printReceipt(receipt2);

  // Verify overall tx succeeded but SENDER frame failed
  if (receipt2.status !== "0x1") {
    throw new Error("Overall tx should succeed (0x1) even when frame fails");
  }
  if (!receipt2.frameReceipts || receipt2.frameReceipts.length < 2) {
    throw new Error("Missing frame receipts");
  }
  if (receipt2.frameReceipts[1].status !== "0x0") {
    throw new Error(
      `Frame 1 should fail (0x0) but got ${receipt2.frameReceipts[1].status} - hook not enforced!`
    );
  }

  console.log("  Transfer correctly rejected by SpendingLimitHook (6 ETH > 5 ETH limit)");

  console.log("\n=== SPENDING LIMIT HOOK E2E TEST PASSED ===");
}

main().catch((err) => {
  console.error("FATAL:", err.message || err);
  process.exit(1);
});
