/**
 * E2E: Kernel8141 non-root validator via SENDER frame cross-read
 *
 * Usage: cd contracts && npx tsx e2e/kernel/kernel-validator.ts
 */

import {
  encodeAbiParameters,
  parseAbiParameters,
  encodeFunctionData,
  concatHex,
  toFunctionSelector,
  type Hex,
  type Address,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { SECOND_OWNER_KEY, DEAD_ADDR, HOOK_INSTALLED } from "../helpers/config.js";
import { loadBytecode, deployContract } from "../helpers/deploy.js";
import { verifyReceipt } from "../helpers/receipt.js";
import { kernelAbi } from "../helpers/abis/kernel.js";
import { printReceipt, sectionHeader, testHeader, step, info, testPassed, summary, fatal } from "../helpers/log.js";
import { deployKernelTestbed, type KernelTestContext } from "./setup.js";
import { encodeExecMode, encodeSingleExec } from "../helpers/exec-encoding.js";
import { sendFrameTx, kernelValidateVerify, kernelValidatorVerify } from "../helpers/send-frame-tx.js";

const sendRoot = (ctx: KernelTestContext, senderCalldata: Hex, senderGas?: bigint) =>
  sendFrameTx({
    publicClient: ctx.publicClient,
    sender: ctx.kernelAddr,
    senderCalldata,
    senderGas,
    buildVerifyData: kernelValidateVerify(),
  });

const sendWithValidator = (
  ctx: KernelTestContext,
  signingKey: Hex,
  validatorAddr: Address,
  senderCalldata: Hex,
  senderGas = 700_000n,
) =>
  sendFrameTx({
    publicClient: ctx.publicClient,
    sender: ctx.kernelAddr,
    senderCalldata,
    senderGas,
    buildVerifyData: kernelValidatorVerify(validatorAddr, signingKey),
  });

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
    // HOOK_INSTALLED imported from config
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
    const installReceipt = await sendRoot(ctx, installCalldata);
    verifyReceipt(installReceipt, ctx.kernelAddr, { expectVerifyStatus: "0x4|0x2" });

    // Send frame tx with non-root validator
    step("Sending frame tx with non-root validator...");
    const execMode = encodeExecMode("0x00" as Hex, "0x00" as Hex); // single + default
    const execCalldata = encodeSingleExec(DEAD_ADDR, 0n);
    const innerCalldata = encodeFunctionData({
      abi: kernelAbi,
      functionName: "execute",
      args: [execMode, execCalldata],
    });
    const senderCalldata = encodeFunctionData({
      abi: kernelAbi,
      functionName: "validatedCall",
      args: [secondValidatorAddr, innerCalldata],
    });
    const receipt = await sendWithValidator(
      ctx, SECOND_OWNER_KEY as Hex, secondValidatorAddr, senderCalldata
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
