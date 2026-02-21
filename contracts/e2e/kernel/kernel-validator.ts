/**
 * E2E: Kernel8141 non-root validator via SENDER frame cross-read
 *
 * Usage: cd contracts && npx tsx e2e/kernel/kernel-validator.ts
 */

import {
  encodeAbiParameters,
  parseAbiParameters,
  encodeFunctionData,
  hexToBytes,
  bytesToHex,
  concatHex,
  padHex,
  toFunctionSelector,
  type Hex,
  type Hash,
  type Address,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { CHAIN_ID, DEV_KEY, SECOND_OWNER_KEY, DEAD_ADDR, FRAME_MODE_VERIFY, FRAME_MODE_SENDER } from "../helpers/config.js";
import { waitForReceipt } from "../helpers/client.js";
import { loadBytecode, deployContract } from "../helpers/deploy.js";
import { computeSigHash, encodeFrameTx, type FrameTxParams } from "../helpers/frame-tx.js";
import { signFrameHash } from "../helpers/signing.js";
import { printReceipt, verifyReceipt } from "../helpers/receipt.js";
import { kernelAbi } from "../helpers/abis/kernel.js";
import { sectionHeader, testHeader, step, info, testPassed, summary, fatal } from "../helpers/log.js";
import { deployKernelTestbed, type KernelTestContext } from "./setup.js";

// ── ExecMode encoding ────────────────────────────────────────────────
function encodeExecMode(callType: string, execType: string): Hex {
  return padHex(
    `0x${callType.slice(2)}${execType.slice(2)}` as Hex,
    { size: 32, dir: "right" }
  );
}

function encodeSingleExec(target: Address, value: bigint, data: Hex = "0x"): Hex {
  const targetHex = target.slice(2).toLowerCase().padStart(40, "0");
  const valueHex = value.toString(16).padStart(64, "0");
  const dataHex = data.slice(2);
  return `0x${targetHex}${valueHex}${dataHex}` as Hex;
}

// ── Frame TX helpers ─────────────────────────────────────────────────

/** Send frame tx validated by root validator (validate). */
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

/** Send frame tx validated by non-root validator (validateFromSenderFrame + validatedCall). */
async function sendFrameTxWithValidator(
  ctx: KernelTestContext,
  signingKey: Hex,
  validatorAddr: Address,
  innerCalldata: Hex,
  senderGas = 700_000n
): Promise<any> {
  const { publicClient, kernelAddr } = ctx;
  const kernelNonce = await publicClient.getTransactionCount({ address: kernelAddr });
  const block = await publicClient.getBlock();
  const gasFeeCap = block.baseFeePerGas! + 2_000_000_000n;

  // SENDER frame: validatedCall(validator, innerCalldata)
  const senderCalldata = encodeFunctionData({
    abi: kernelAbi,
    functionName: "validatedCall",
    args: [validatorAddr, innerCalldata],
  });

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
  const { packed: packedSig } = signFrameHash(sigHash, signingKey);

  // sig format for validateFromSenderFrame: [1B type=0x01][20B validatorAddr][65B sig]
  const sigPrefix = `0x01${validatorAddr.slice(2)}` as Hex;
  const prefixedSig = concatHex([sigPrefix, bytesToHex(packedSig)]);

  const validateCalldata = encodeFunctionData({
    abi: kernelAbi,
    functionName: "validateFromSenderFrame",
    args: [prefixedSig, 2],
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

  testHeader(1, "validateFromSenderFrame + validatedCall (sigHash-bound)");
  {
    const secondOwnerAccount = privateKeyToAccount(SECOND_OWNER_KEY);
    const secondOwnerAddr = secondOwnerAccount.address;
    info(`Second owner: ${secondOwnerAddr}`);

    // Deploy second ECDSAValidator
    step("Deploying second ECDSAValidator...");
    const validatorBytecode = loadBytecode("ECDSAValidator");
    const { address: secondValidatorAddr } = await deployContract(
      ctx.walletClient, ctx.publicClient, validatorBytecode, 3_000_000n, "ECDSAValidator #2"
    );

    // Install second validator via installModule(1=VALIDATOR, module, initData)
    // initData = [20B hookAddr][abi.encode(validatorData, hookData, selectorData)]
    // - hookAddr: HOOK_INSTALLED sentinel (no real hook)
    // - validatorData: abi.encodePacked(secondOwnerAddr) = 20 bytes
    // - hookData: empty
    // - selectorData: validatedCall selector (4 bytes → auto-grants selector ACL)
    step("Installing second validator...");
    const HOOK_INSTALLED = "0x0000000000000000000000000000000000000001" as Hex;
    const validatedCallSelector = toFunctionSelector("validatedCall(address,bytes)");
    const structData = encodeAbiParameters(
      parseAbiParameters("bytes, bytes, bytes"),
      [secondOwnerAddr, "0x", validatedCallSelector]
    );
    const installInitData = concatHex([HOOK_INSTALLED, structData]);

    const installCalldata = encodeFunctionData({
      abi: kernelAbi,
      functionName: "installModule",
      args: [1n, secondValidatorAddr, installInitData],
    });
    const installReceipt = await sendFrameTx(ctx, installCalldata);
    verifyReceipt(installReceipt, ctx.kernelAddr, { expectVerifyStatus: "0x4|0x2" });

    // Send frame tx with non-root validator
    step("Sending frame tx with non-root validator...");
    const execMode = padHex("0x0000" as Hex, { size: 32, dir: "right" }); // single + default
    const execCalldata = encodeSingleExec(DEAD_ADDR, 0n);
    const innerCalldata = encodeFunctionData({
      abi: kernelAbi,
      functionName: "execute",
      args: [execMode, execCalldata],
    });
    const receipt = await sendFrameTxWithValidator(
      ctx, SECOND_OWNER_KEY as Hex, secondValidatorAddr, innerCalldata
    );
    printReceipt(receipt);
    verifyReceipt(receipt, ctx.kernelAddr, { expectVerifyStatus: "0x4|0x2" });
    testPassed("Non-root validator bound to sigHash via SENDER frame");
  }

  summary("Kernel Validator", 1);
}

main().catch((err) => {
  fatal(err);
  process.exit(1);
});
