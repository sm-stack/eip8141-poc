/**
 * E2E: Kernel8141 non-root validator via SENDER frame cross-read (Test 8)
 *
 * Tests validateFromSenderFrame + validatedCall pattern where the validator
 * address is placed in SENDER frame calldata (included in sigHash) for
 * secure, sigHash-bound validator selection.
 *
 * Usage: cd contracts && npx tsx e2e/kernel/kernel-validator.ts
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
import { privateKeyToAccount } from "viem/accounts";
import { CHAIN_ID, DEV_KEY, SECOND_OWNER_KEY, DEAD_ADDR, FRAME_MODE_VERIFY, FRAME_MODE_SENDER } from "../helpers/config.js";
import { waitForReceipt } from "../helpers/client.js";
import { loadBytecode, deployContract } from "../helpers/deploy.js";
import { computeSigHash, encodeFrameTx, type FrameTxParams } from "../helpers/frame-tx.js";
import { signFrameHash } from "../helpers/signing.js";
import { printReceipt, verifyReceipt } from "../helpers/receipt.js";
import { kernelAbi } from "../helpers/abis/kernel.js";
import { deployKernelTestbed, type KernelTestContext } from "./setup.js";

/** Send a frame tx using root validator (validate + simple SENDER frame). */
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

/** Send a frame tx using a non-root validator via validateFromSenderFrame + validatedCall. */
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

  // Sign with the specified key (not necessarily DEV_KEY)
  const sigHash = computeSigHash(frameTxParams);
  const { packed: packedSig } = signFrameHash(sigHash, signingKey);

  // VERIFY frame: validateFromSenderFrame(signature, scope=2)
  const validateCalldata = encodeFunctionData({
    abi: kernelAbi,
    functionName: "validateFromSenderFrame",
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

  // First, install DefaultExecutor for execute() so the inner call works
  console.log(`\n${"~".repeat(70)}`);
  console.log(`Setup: Install DefaultExecutor`);
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
    verifyReceipt(receipt, ctx.kernelAddr, { expectVerifyStatus: "0x4|0x2" });
    console.log("  DefaultExecutor installed");
  }

  // Test: validateFromSenderFrame + validatedCall
  console.log(`\n${"~".repeat(70)}`);
  console.log(`Test: validateFromSenderFrame + validatedCall (sigHash-bound validator)`);
  console.log(`${"~".repeat(70)}`);
  {
    const secondOwnerAccount = privateKeyToAccount(SECOND_OWNER_KEY);
    const secondOwnerAddr = secondOwnerAccount.address;
    console.log(`  Second owner: ${secondOwnerAddr}`);

    // Deploy second ECDSAValidator
    console.log("  Deploying second ECDSAValidator...");
    const validatorBytecode = loadBytecode("ECDSAValidator");
    const { address: secondValidatorAddr } = await deployContract(
      ctx.walletClient,
      ctx.publicClient,
      validatorBytecode
    );

    // Install second validator with secondOwnerAddr as owner
    console.log("  Installing second validator...");
    const installConfig = encodeAbiParameters(
      parseAbiParameters("address"),
      [secondOwnerAddr]
    );
    const MODULE_TYPE_VALIDATOR = 0;
    const installCalldata = encodeFunctionData({
      abi: kernelAbi,
      functionName: "installModule",
      args: [MODULE_TYPE_VALIDATOR, secondValidatorAddr, installConfig],
    });
    const installReceipt = await sendFrameTx(ctx, installCalldata);
    verifyReceipt(installReceipt, ctx.kernelAddr, { expectVerifyStatus: "0x4|0x2" });
    console.log("  Second validator installed");

    // Send frame tx signed by second owner, validated by second validator
    const innerCalldata = encodeFunctionData({
      abi: kernelAbi,
      functionName: "execute",
      args: [DEAD_ADDR, 0n, "0x"],
    });
    const receipt = await sendFrameTxWithValidator(
      ctx,
      SECOND_OWNER_KEY as Hex,
      secondValidatorAddr,
      innerCalldata
    );
    printReceipt(receipt);
    verifyReceipt(receipt, ctx.kernelAddr, { expectVerifyStatus: "0x4|0x2" });
    console.log("PASSED - Non-root validator selection bound to sigHash via SENDER frame");
  }

  console.log(`\n${"=".repeat(70)}`);
  console.log(`KERNEL VALIDATOR TEST PASSED`);
  console.log(`${"=".repeat(70)}\n`);
}

main().catch((err) => {
  console.error("FATAL:", err.message || err);
  process.exit(1);
});
