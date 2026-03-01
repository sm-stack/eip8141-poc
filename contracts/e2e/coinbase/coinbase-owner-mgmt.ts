/**
 * E2E: CoinbaseSmartWallet8141 Owner Management
 *
 * Tests:
 * 1. ownerCount / removedOwnersCount initial state
 * 2. addOwnerAddress via SENDER frame
 * 3. removeOwnerAtIndex via SENDER frame
 *
 * Usage: cd contracts && npx tsx e2e/coinbase/coinbase-owner-mgmt.ts
 */

import {
  encodeAbiParameters,
  parseAbiParameters,
  encodeFunctionData,
  type Hex,
  type Address,
} from "viem";
import { DEV_KEY } from "../helpers/config.js";
import { verifyReceipt } from "../helpers/receipt.js";
import { walletAbi } from "../helpers/abis/coinbase.js";
import { printReceipt, testHeader, testPassed, summary, fatal } from "../helpers/log.js";
import { deployCoinbaseTestbed } from "./setup.js";
import { sendFrameTx, coinbaseVerify } from "../helpers/send-frame-tx.js";

async function main() {
  const ctx = await deployCoinbaseTestbed();

  const send = (senderCalldata: Hex, ownerIndex = 0, privKey: Hex = DEV_KEY) =>
    sendFrameTx({
      publicClient: ctx.publicClient,
      sender: ctx.walletAddr,
      senderCalldata,
      buildVerifyData: coinbaseVerify(ownerIndex, privKey),
    });

  testHeader(1, "ownerCount / removedOwnersCount initial state");
  {
    const ownerCount = await ctx.publicClient.readContract({
      address: ctx.walletAddr,
      abi: walletAbi,
      functionName: "ownerCount",
    });
    const removedCount = await ctx.publicClient.readContract({
      address: ctx.walletAddr,
      abi: walletAbi,
      functionName: "removedOwnersCount",
    });
    const nextIndex = await ctx.publicClient.readContract({
      address: ctx.walletAddr,
      abi: walletAbi,
      functionName: "nextOwnerIndex",
    });

    if (Number(ownerCount) !== 3) throw new Error(`Expected ownerCount=3, got ${ownerCount}`);
    if (Number(removedCount) !== 0) throw new Error(`Expected removedOwnersCount=0, got ${removedCount}`);
    if (Number(nextIndex) !== 3) throw new Error(`Expected nextOwnerIndex=3, got ${nextIndex}`);

    testPassed(`ownerCount=${ownerCount}, removedOwnersCount=${removedCount}, nextOwnerIndex=${nextIndex}`);
  }

  testHeader(2, "addOwnerAddress via SENDER frame");
  {
    const newOwner = "0x0000000000000000000000000000000000004444" as Address;

    const senderCalldata = encodeFunctionData({
      abi: walletAbi,
      functionName: "addOwnerAddress",
      args: [newOwner],
    });

    const receipt = await send(senderCalldata);
    printReceipt(receipt);
    verifyReceipt(receipt, ctx.walletAddr, { expectVerifyStatus: "0x4|0x2" });

    // Verify new owner was added
    const isOwner = await ctx.publicClient.readContract({
      address: ctx.walletAddr,
      abi: walletAbi,
      functionName: "isOwnerAddress",
      args: [newOwner],
    });
    if (!isOwner) throw new Error("New owner not added");

    const ownerCount = await ctx.publicClient.readContract({
      address: ctx.walletAddr,
      abi: walletAbi,
      functionName: "ownerCount",
    });
    if (Number(ownerCount) !== 4) throw new Error(`Expected ownerCount=4, got ${ownerCount}`);

    const nextIndex = await ctx.publicClient.readContract({
      address: ctx.walletAddr,
      abi: walletAbi,
      functionName: "nextOwnerIndex",
    });
    if (Number(nextIndex) !== 4) throw new Error(`Expected nextOwnerIndex=4, got ${nextIndex}`);

    testPassed(`addOwnerAddress succeeded, ownerCount=${ownerCount}`);
  }

  testHeader(3, "removeOwnerAtIndex via SENDER frame");
  {
    // Remove the owner we just added (index=3, which is the new owner at index 3)
    const newOwner = "0x0000000000000000000000000000000000004444" as Address;
    const ownerBytes = encodeAbiParameters(parseAbiParameters("address"), [newOwner]);

    const senderCalldata = encodeFunctionData({
      abi: walletAbi,
      functionName: "removeOwnerAtIndex",
      args: [3n, ownerBytes],
    });

    const receipt = await send(senderCalldata);
    printReceipt(receipt);
    verifyReceipt(receipt, ctx.walletAddr, { expectVerifyStatus: "0x4|0x2" });

    // Verify owner was removed
    const isOwner = await ctx.publicClient.readContract({
      address: ctx.walletAddr,
      abi: walletAbi,
      functionName: "isOwnerAddress",
      args: [newOwner],
    });
    if (isOwner) throw new Error("Owner not removed");

    const ownerCount = await ctx.publicClient.readContract({
      address: ctx.walletAddr,
      abi: walletAbi,
      functionName: "ownerCount",
    });
    if (Number(ownerCount) !== 3) throw new Error(`Expected ownerCount=3, got ${ownerCount}`);

    const removedCount = await ctx.publicClient.readContract({
      address: ctx.walletAddr,
      abi: walletAbi,
      functionName: "removedOwnersCount",
    });
    if (Number(removedCount) !== 1) throw new Error(`Expected removedOwnersCount=1, got ${removedCount}`);

    testPassed(`removeOwnerAtIndex succeeded, ownerCount=${ownerCount}, removedOwnersCount=${removedCount}`);
  }

  summary("Coinbase Owner Management", 3);
}

main().catch((err) => {
  fatal(err);
  process.exit(1);
});
