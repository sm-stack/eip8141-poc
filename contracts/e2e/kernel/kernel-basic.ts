/**
 * E2E: Kernel8141 module management and execution tests (Tests 1-5)
 *
 * Usage: cd contracts && npx tsx e2e/kernel/kernel-basic.ts
 */

import {
  encodeAbiParameters,
  parseAbiParameters,
  encodeFunctionData,
  hexToBytes,
  bytesToHex,
  concatHex,
  padHex,
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
import { testHeader, testPassed, summary, fatal } from "../helpers/log.js";
import { deployKernelTestbed, type KernelTestContext } from "./setup.js";

// ── ExecMode encoding ────────────────────────────────────────────────
// ExecMode (bytes32) = [1B callType][1B execType][4B selector][22B payload]
const CALLTYPE_SINGLE   = "0x00";
const CALLTYPE_BATCH    = "0x01";
const EXECTYPE_DEFAULT  = "0x00";
const EXECTYPE_TRY      = "0x01";

function encodeExecMode(callType: string, execType: string): Hex {
  // 1B callType + 1B execType + 30B zeros = 32 bytes
  return padHex(
    `0x${callType.slice(2)}${execType.slice(2)}` as Hex,
    { size: 32, dir: "right" }
  );
}

// ── Execution calldata encoding ──────────────────────────────────────
// Single: abi.encodePacked(target(20B), value(32B), calldata)
function encodeSingleExec(target: Address, value: bigint, data: Hex = "0x"): Hex {
  const targetHex = target.slice(2).toLowerCase().padStart(40, "0");
  const valueHex = value.toString(16).padStart(64, "0");
  const dataHex = data.slice(2);
  return `0x${targetHex}${valueHex}${dataHex}` as Hex;
}

// Batch: abi.encode(Execution[]) where Execution = (address, uint256, bytes)
function encodeBatchExec(executions: { target: Address; value: bigint; data: Hex }[]): Hex {
  return encodeAbiParameters(
    [{ type: "tuple[]", components: [
      { name: "target", type: "address" },
      { name: "value", type: "uint256" },
      { name: "callData", type: "bytes" },
    ]}],
    [executions.map(e => ({ target: e.target, value: e.value, callData: e.data }))]
  );
}

// ── Frame TX helper ──────────────────────────────────────────────────
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

  // ── Test 1: Install DefaultExecutor ────────────────────────────────
  testHeader(testNum++, "Install DefaultExecutor");
  {
    // installModule(2=EXECUTOR, module, initData)
    // initData = [20B hookAddr][abi.encode(executorData, hookData)]
    const HOOK_INSTALLED = "0x0000000000000000000000000000000000000001";
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
    const receipt = await sendFrameTx(ctx, installCalldata);
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
    const receipt = await sendFrameTx(ctx, calldata);
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
    const receipt = await sendFrameTx(ctx, calldata);
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
    const receipt = await sendFrameTx(ctx, calldata);
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
    const receipt = await sendFrameTx(ctx, calldata);
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
