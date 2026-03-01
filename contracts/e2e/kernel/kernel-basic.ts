/**
 * E2E: Kernel8141 module management and execution tests (Tests 1-5)
 *
 * Usage: cd contracts && npx tsx e2e/kernel/kernel-basic.ts
 */

import {
  encodeAbiParameters,
  parseAbiParameters,
  encodeFunctionData,
  concatHex,
  type Hex,
  type Address,
} from "viem";
import { DEAD_ADDR, HOOK_INSTALLED } from "../helpers/config.js";
import { verifyReceipt } from "../helpers/receipt.js";
import { kernelAbi } from "../helpers/abis/kernel.js";
import { printReceipt, testHeader, testPassed, summary, fatal } from "../helpers/log.js";
import { deployKernelTestbed, type KernelTestContext } from "./setup.js";
import { encodeExecMode, encodeSingleExec, encodeBatchExec } from "../helpers/exec-encoding.js";
import { sendFrameTx, kernelValidateVerify } from "../helpers/send-frame-tx.js";

const CALLTYPE_SINGLE   = "0x00" as Hex;
const CALLTYPE_BATCH    = "0x01" as Hex;
const EXECTYPE_DEFAULT  = "0x00" as Hex;
const EXECTYPE_TRY      = "0x01" as Hex;

const send = (ctx: KernelTestContext, senderCalldata: Hex, senderGas?: bigint) =>
  sendFrameTx({
    publicClient: ctx.publicClient,
    sender: ctx.kernelAddr,
    senderCalldata,
    senderGas,
    buildVerifyData: kernelValidateVerify(),
  });

async function main() {
  const ctx = await deployKernelTestbed();
  let testNum = 1;

  // ── Test 1: Install DefaultExecutor ────────────────────────────────
  testHeader(testNum++, "Install DefaultExecutor");
  {
    // installModule(2=EXECUTOR, module, initData)
    // initData = [20B hookAddr][abi.encode(executorData, hookData)]
    // HOOK_INSTALLED imported from config
    const structData = encodeAbiParameters(
      parseAbiParameters("bytes, bytes"),
      ["0x", "0x"]
    );
    const initData = concatHex([HOOK_INSTALLED as Hex, structData]);

    const installCalldata = encodeFunctionData({
      abi: kernelAbi,
      functionName: "installModule",
      args: [2n, ctx.defaultExecutorAddr, initData],
    });
    const receipt = await send(ctx, installCalldata);
    printReceipt(receipt);
    verifyReceipt(receipt, ctx.kernelAddr, { expectVerifyStatus: "0x4|0x2" });
    testPassed("DefaultExecutor installed");
  }

  // ── Test 2: Basic execute (single call) ────────────────────────────
  testHeader(testNum++, "Single execute()");
  {
    const execMode = encodeExecMode(CALLTYPE_SINGLE, EXECTYPE_DEFAULT);
    const execCalldata = encodeSingleExec(DEAD_ADDR, 0n);
    const calldata = encodeFunctionData({
      abi: kernelAbi,
      functionName: "execute",
      args: [execMode, execCalldata],
    });
    const receipt = await send(ctx, calldata);
    printReceipt(receipt);
    verifyReceipt(receipt, ctx.kernelAddr, { expectVerifyStatus: "0x4|0x2" });
    testPassed();
  }

  // ── Test 3: Batch execute ──────────────────────────────────────────
  testHeader(testNum++, "Batch execute()");
  {
    const execMode = encodeExecMode(CALLTYPE_BATCH, EXECTYPE_DEFAULT);
    const execCalldata = encodeBatchExec([
      { target: DEAD_ADDR, value: 0n, data: "0x" },
      { target: DEAD_ADDR, value: 0n, data: "0x" },
    ]);
    const calldata = encodeFunctionData({
      abi: kernelAbi,
      functionName: "execute",
      args: [execMode, execCalldata],
    });
    const receipt = await send(ctx, calldata);
    printReceipt(receipt);
    verifyReceipt(receipt, ctx.kernelAddr, { expectVerifyStatus: "0x4|0x2" });
    testPassed();
  }

  // ── Test 4: Single executeTry (graceful failure) ───────────────────
  testHeader(testNum++, "executeTry (single) — graceful failure");
  {
    const execMode = encodeExecMode(CALLTYPE_SINGLE, EXECTYPE_TRY);
    // Call to address(1) with bogus data — will fail but try mode catches it
    const execCalldata = encodeSingleExec(
      "0x0000000000000000000000000000000000000001" as Address,
      0n,
      "0xdeadbeef"
    );
    const calldata = encodeFunctionData({
      abi: kernelAbi,
      functionName: "execute",
      args: [execMode, execCalldata],
    });
    const receipt = await send(ctx, calldata);
    printReceipt(receipt);
    verifyReceipt(receipt, ctx.kernelAddr, { expectVerifyStatus: "0x4|0x2" });
    testPassed("executeTry handled failure gracefully");
  }

  // ── Test 5: Batch executeTry (mixed success/failure) ───────────────
  testHeader(testNum++, "executeBatchTry — mixed success/failure");
  {
    const execMode = encodeExecMode(CALLTYPE_BATCH, EXECTYPE_TRY);
    const execCalldata = encodeBatchExec([
      { target: DEAD_ADDR, value: 0n, data: "0x" },
      { target: "0x0000000000000000000000000000000000000001" as Address, value: 0n, data: "0xdeadbeef" },
    ]);
    const calldata = encodeFunctionData({
      abi: kernelAbi,
      functionName: "execute",
      args: [execMode, execCalldata],
    });
    const receipt = await send(ctx, calldata);
    printReceipt(receipt);
    verifyReceipt(receipt, ctx.kernelAddr, { expectVerifyStatus: "0x4|0x2" });
    testPassed("executeBatchTry handled mixed results");
  }

  summary("Kernel Basic", testNum - 1);
}

main().catch((err) => {
  fatal(err);
  process.exit(1);
});
