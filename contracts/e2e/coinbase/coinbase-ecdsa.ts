/**
 * E2E: CoinbaseSmartWallet8141 ECDSA owner execution (Tests 1-2)
 *
 * Usage: cd contracts && npx tsx e2e/coinbase/coinbase-ecdsa.ts
 */

import {
  encodeFunctionData,
  type Hex,
  type Address,
} from "viem";
import { DEV_KEY, OWNER2_KEY, DEAD_ADDR } from "../helpers/config.js";
import { verifyReceipt } from "../helpers/receipt.js";
import { walletAbi } from "../helpers/abis/coinbase.js";
import { printReceipt, testHeader, testPassed, summary, fatal } from "../helpers/log.js";
import { deployCoinbaseTestbed } from "./setup.js";
import { createCoinbaseAccount, sendAndWait } from "../helpers/send-frame-tx.js";

async function main() {
  const ctx = await deployCoinbaseTestbed();

  const send = (senderCalldata: Hex, ownerIndex: number, privKey: Hex) => {
    const account = createCoinbaseAccount(ctx.walletAddr, ownerIndex, privKey);
    return sendAndWait(ctx.publicClient, account, senderCalldata);
  };

  testHeader(1, "Execute with ECDSA Owner 1");
  {
    const calldata = encodeFunctionData({
      abi: walletAbi,
      functionName: "execute",
      args: [DEAD_ADDR, 0n, "0x"],
    });
    const receipt = await send(calldata, 0, DEV_KEY);
    printReceipt(receipt);
    verifyReceipt(receipt, ctx.walletAddr, { expectVerifyStatus: "0x4|0x2" });
    testPassed("ECDSA Owner 1 executed successfully");
  }

  testHeader(2, "Execute with ECDSA Owner 2");
  {
    const calldata = encodeFunctionData({
      abi: walletAbi,
      functionName: "execute",
      args: [DEAD_ADDR, 0n, "0x"],
    });
    const receipt = await send(calldata, 1, OWNER2_KEY);
    printReceipt(receipt);
    verifyReceipt(receipt, ctx.walletAddr, { expectVerifyStatus: "0x4|0x2" });
    testPassed("ECDSA Owner 2 executed successfully");
  }

  summary("Coinbase ECDSA", 2);
}

main().catch((err) => {
  fatal(err);
  process.exit(1);
});
