/**
 * E2E: Kernel8141 module management and execution tests (Tests 1-7)
 *
 * Tests:
 *   1. Install DefaultExecutor
 *   2. Install SpendingLimitHook
 *   3. Install ERC1271Handler
 *   4. Basic execute()
 *   5. executeBatch()
 *   6. executeTry() - graceful failure
 *   7. executeBatchTry() - mixed success/failure
 *
 * Usage: cd contracts && npx tsx e2e/kernel/kernel-basic.ts
 */

import {
  encodeAbiParameters,
  parseAbiParameters,
  encodeFunctionData,
  hexToBytes,
  bytesToHex,
  parseEther,
  type Hex,
  type Hash,
  type Address,
} from "viem";
import { CHAIN_ID, DEV_KEY, DEAD_ADDR, FRAME_MODE_VERIFY, FRAME_MODE_SENDER } from "../helpers/config.js";
import { waitForReceipt } from "../helpers/client.js";
import { computeSigHash, encodeFrameTx, type FrameTxParams } from "../helpers/frame-tx.js";
import { signFrameHash } from "../helpers/signing.js";
import { printReceipt, verifyReceipt } from "../helpers/receipt.js";
import { kernelAbi } from "../helpers/abis/kernel.js";
import { deployKernelTestbed, type KernelTestContext } from "./setup.js";

async function sendFrameTx(
  ctx: KernelTestContext,
  senderCalldata: Hex,
  senderGas = 500_000n
): Promise<any> {
  const { publicClient, kernelAddr } = ctx;
  const kernelNonce = await publicClient.getTransactionCount({ address: kernelAddr });
  const block = await publicClient.getBlock();
  const gasFeeCap = block.baseFeePerGas! + 2_000_000_000n;

  const frameTxParams: FrameTxParams = {
    chainId: BigInt(CHAIN_ID),
    nonce: BigInt(kernelNonce),
    sender: kernelAddr,
    gasTipCap: 1_000_000_000n,
    gasFeeCap,
    frames: [
      { mode: FRAME_MODE_VERIFY, target: null, gasLimit: 300_000n, data: new Uint8Array(0) },
      { mode: FRAME_MODE_SENDER, target: null, gasLimit: senderGas, data: hexToBytes(senderCalldata) },
    ],
    blobFeeCap: 0n,
    blobHashes: [],
  };

  const sigHash = computeSigHash(frameTxParams);
  const { packed: packedSig } = signFrameHash(sigHash, DEV_KEY);

  const validateCalldata = encodeFunctionData({
    abi: kernelAbi,
    functionName: "validate",
    args: [bytesToHex(packedSig), 2],
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
  const ctx = await deployKernelTestbed();
  let testNum = 1;

  // Test 1: Install DefaultExecutor for execute() selector
  console.log(`\n${"~".repeat(70)}`);
  console.log(`Test ${testNum++}: Install DefaultExecutor`);
  console.log(`${"~".repeat(70)}`);
  {
    const MODULE_TYPE_EXECUTOR = 1;
    const executeSelector = "0xb61d27f6";

    const executorConfig = encodeAbiParameters(
      parseAbiParameters("bytes4[], uint48, uint48, uint8"),
      [[executeSelector], 0, 0, 2]
    );

    const installCalldata = encodeFunctionData({
      abi: kernelAbi,
      functionName: "installModule",
      args: [MODULE_TYPE_EXECUTOR, ctx.defaultExecutorAddr, executorConfig],
    });
    const receipt = await sendFrameTx(ctx, installCalldata);
    printReceipt(receipt);
    verifyReceipt(receipt, ctx.kernelAddr, { expectVerifyStatus: "0x4|0x2" });
    console.log("PASSED - DefaultExecutor installed for execute()");
  }

  // Test 2: Install SpendingLimitHook for execute() selector
  console.log(`\n${"~".repeat(70)}`);
  console.log(`Test ${testNum++}: Install SpendingLimitHook`);
  console.log(`${"~".repeat(70)}`);
  {
    const MODULE_TYPE_PRE_HOOK = 2;
    const executeSelector = "0xb61d27f6";
    const dailyLimit = parseEther("5");

    const hookData = encodeAbiParameters(
      parseAbiParameters("uint256"),
      [dailyLimit]
    );
    const hookConfig = encodeAbiParameters(
      parseAbiParameters("bytes4[], bytes"),
      [[executeSelector], hookData]
    );

    const installCalldata = encodeFunctionData({
      abi: kernelAbi,
      functionName: "installModule",
      args: [MODULE_TYPE_PRE_HOOK, ctx.hookAddr, hookConfig],
    });
    const receipt = await sendFrameTx(ctx, installCalldata);
    printReceipt(receipt);
    verifyReceipt(receipt, ctx.kernelAddr, { expectVerifyStatus: "0x4|0x2" });
    console.log("PASSED - SpendingLimitHook installed with 5 ETH daily limit");
  }

  // Test 3: Install ERC1271Handler for isValidSignature()
  console.log(`\n${"~".repeat(70)}`);
  console.log(`Test ${testNum++}: Install ERC1271Handler`);
  console.log(`${"~".repeat(70)}`);
  {
    const MODULE_TYPE_FALLBACK_HANDLER = 4;
    const isValidSignatureSelector = "0x1626ba7e";

    const handlerData = encodeAbiParameters(
      parseAbiParameters("address"),
      [ctx.validatorAddr]
    );
    const handlerConfig = encodeAbiParameters(
      parseAbiParameters("bytes4[], bytes"),
      [[isValidSignatureSelector], handlerData]
    );

    const installCalldata = encodeFunctionData({
      abi: kernelAbi,
      functionName: "installModule",
      args: [MODULE_TYPE_FALLBACK_HANDLER, ctx.handlerAddr, handlerConfig],
    });
    const receipt = await sendFrameTx(ctx, installCalldata);
    printReceipt(receipt);
    verifyReceipt(receipt, ctx.kernelAddr, { expectVerifyStatus: "0x4|0x2" });
    console.log("PASSED - ERC1271Handler installed");
  }

  // Test 4: Basic execute
  console.log(`\n${"~".repeat(70)}`);
  console.log(`Test ${testNum++}: Basic execute()`);
  console.log(`${"~".repeat(70)}`);
  {
    const calldata = encodeFunctionData({
      abi: kernelAbi,
      functionName: "execute",
      args: [DEAD_ADDR, 0n, "0x"],
    });
    const receipt = await sendFrameTx(ctx, calldata);
    printReceipt(receipt);
    verifyReceipt(receipt, ctx.kernelAddr, { expectVerifyStatus: "0x4|0x2" });
    console.log("PASSED");
  }

  // Test 5: executeBatch
  console.log(`\n${"~".repeat(70)}`);
  console.log(`Test ${testNum++}: executeBatch()`);
  console.log(`${"~".repeat(70)}`);
  {
    const calldata = encodeFunctionData({
      abi: kernelAbi,
      functionName: "executeBatch",
      args: [[DEAD_ADDR, DEAD_ADDR], [0n, 0n], ["0x", "0x"]],
    });
    const receipt = await sendFrameTx(ctx, calldata);
    printReceipt(receipt);
    verifyReceipt(receipt, ctx.kernelAddr, { expectVerifyStatus: "0x4|0x2" });
    console.log("PASSED");
  }

  // Test 6: executeTry (graceful error handling)
  console.log(`\n${"~".repeat(70)}`);
  console.log(`Test ${testNum++}: executeTry() - graceful failure`);
  console.log(`${"~".repeat(70)}`);
  {
    const calldata = encodeFunctionData({
      abi: kernelAbi,
      functionName: "executeTry",
      args: ["0x0000000000000000000000000000000000000001", 0n, "0xdeadbeef"],
    });
    const receipt = await sendFrameTx(ctx, calldata);
    printReceipt(receipt);
    verifyReceipt(receipt, ctx.kernelAddr, { expectVerifyStatus: "0x4|0x2" });
    console.log("PASSED - executeTry handled failure gracefully");
  }

  // Test 7: executeBatchTry
  console.log(`\n${"~".repeat(70)}`);
  console.log(`Test ${testNum++}: executeBatchTry() - mixed success/failure`);
  console.log(`${"~".repeat(70)}`);
  {
    const calldata = encodeFunctionData({
      abi: kernelAbi,
      functionName: "executeBatchTry",
      args: [
        [DEAD_ADDR, "0x0000000000000000000000000000000000000001"],
        [0n, 0n],
        ["0x", "0xdeadbeef"],
      ],
    });
    const receipt = await sendFrameTx(ctx, calldata);
    printReceipt(receipt);
    verifyReceipt(receipt, ctx.kernelAddr, { expectVerifyStatus: "0x4|0x2" });
    console.log("PASSED - executeBatchTry handled mixed results");
  }

  console.log(`\n${"=".repeat(70)}`);
  console.log(`ALL ${testNum - 1} KERNEL BASIC TESTS PASSED`);
  console.log(`${"=".repeat(70)}\n`);
}

main().catch((err) => {
  console.error("FATAL:", err.message || err);
  process.exit(1);
});
