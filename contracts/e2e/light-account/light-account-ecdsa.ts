/**
 * E2E: LightAccount8141 EOA owner execution
 *
 * Usage: cd contracts && npx tsx e2e/light-account/light-account-ecdsa.ts
 */

import {
  encodeFunctionData,
  type Hex,
  type Address,
} from "viem";
import { DEV_KEY, SECOND_OWNER_KEY, DEAD_ADDR } from "../helpers/config.js";
import { verifyReceipt } from "../helpers/receipt.js";
import { walletAbi } from "../helpers/abis/light-account.js";
import { printReceipt, testHeader, testPassed, summary, fatal } from "../helpers/log.js";
import { deployLightAccountTestbed } from "./setup.js";
import { createLightAccount, sendAndWait } from "../helpers/send-frame-tx.js";

async function main() {
  const ctx = await deployLightAccountTestbed();

  const send = (senderCalldata: Hex, privKey: Hex = DEV_KEY) => {
    const account = createLightAccount(ctx.walletAddr, privKey);
    return sendAndWait(ctx.publicClient, account, senderCalldata);
  };

  testHeader(1, "Execute ETH transfer with EOA owner");
  {
    const calldata = encodeFunctionData({
      abi: walletAbi,
      functionName: "execute",
      args: [DEAD_ADDR, 0n, "0x"],
    });
    const receipt = await send(calldata);
    printReceipt(receipt);
    verifyReceipt(receipt, ctx.walletAddr, { expectVerifyStatus: "0x4|0x2" });
    testPassed("EOA owner executed successfully");
  }

  testHeader(2, "Execute batch (no value)");
  {
    const calldata = encodeFunctionData({
      abi: walletAbi,
      functionName: "executeBatch",
      args: [[DEAD_ADDR, DEAD_ADDR], ["0x", "0x"]],
    });
    const receipt = await send(calldata);
    printReceipt(receipt);
    verifyReceipt(receipt, ctx.walletAddr, { expectVerifyStatus: "0x4|0x2" });
    testPassed("Batch execution (no value) succeeded");
  }

  testHeader(3, "Transfer ownership via SENDER frame");
  {
    const { privateKeyToAccount } = await import("viem/accounts");
    const newOwnerAccount = privateKeyToAccount(SECOND_OWNER_KEY);
    const newOwnerAddr = newOwnerAccount.address;

    // Transfer ownership
    const transferCalldata = encodeFunctionData({
      abi: walletAbi,
      functionName: "transferOwnership",
      args: [newOwnerAddr],
    });
    // Wrap in execute self-call
    const calldata = encodeFunctionData({
      abi: walletAbi,
      functionName: "execute",
      args: [ctx.walletAddr, 0n, transferCalldata],
    });
    const receipt = await send(calldata);
    printReceipt(receipt);
    verifyReceipt(receipt, ctx.walletAddr, { expectVerifyStatus: "0x4|0x2" });

    // Verify new owner
    const currentOwner = await ctx.publicClient.readContract({
      address: ctx.walletAddr,
      abi: walletAbi,
      functionName: "owner",
    }) as Address;
    if (currentOwner.toLowerCase() !== newOwnerAddr.toLowerCase()) {
      throw new Error(`Owner transfer failed: expected ${newOwnerAddr}, got ${currentOwner}`);
    }
    testPassed(`Ownership transferred to ${newOwnerAddr}`);

    // Execute with new owner
    testHeader(4, "Execute with new owner after transfer");
    const calldata2 = encodeFunctionData({
      abi: walletAbi,
      functionName: "execute",
      args: [DEAD_ADDR, 0n, "0x"],
    });
    const receipt2 = await send(calldata2, SECOND_OWNER_KEY);
    printReceipt(receipt2);
    verifyReceipt(receipt2, ctx.walletAddr, { expectVerifyStatus: "0x4|0x2" });
    testPassed("New owner executed successfully");
  }

  summary("LightAccount ECDSA", 4);
}

main().catch((err) => {
  fatal(err);
  process.exit(1);
});
