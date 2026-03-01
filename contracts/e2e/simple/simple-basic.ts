/**
 * E2E: Simple8141Account basic frame transaction
 *
 * Usage: cd contracts && npx tsx e2e/simple/simple-basic.ts
 */

import {
  encodeAbiParameters,
  parseAbiParameters,
  getContractAddress,
  formatEther,
  type Hex,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { toSimple8141Account } from "viem/eip8141";
import { DEV_KEY, DEAD_ADDR } from "../helpers/config.js";
import { createTestClients, waitForReceipt, fundAccount } from "../helpers/client.js";
import { loadBytecode } from "../helpers/deploy.js";
import { verifyReceipt } from "../helpers/receipt.js";
import { printReceipt, banner, sectionHeader, info, step, success, testHeader, testPassed, summary, fatal } from "../helpers/log.js";

async function main() {
  const { publicClient, walletClient, devAddr } = createTestClients();
  const owner = privateKeyToAccount(DEV_KEY);

  const balance = await publicClient.getBalance({ address: devAddr });
  banner("Simple8141Account E2E");
  info(`Dev account: ${devAddr}`);
  info(`Balance: ${formatEther(balance)} ETH`);

  // Deploy
  sectionHeader("📦 Deploy Simple8141Account");
  const initCode = loadBytecode("Simple8141Account");
  const constructorArg = encodeAbiParameters(parseAbiParameters("address"), [devAddr]);
  const deployData = (initCode + constructorArg.slice(2)) as Hex;

  const deployNonce = await publicClient.getTransactionCount({ address: devAddr });
  const simple8141AccountAddr = getContractAddress({ from: devAddr, nonce: BigInt(deployNonce) });

  const deployHash = await walletClient.sendTransaction({
    data: deployData,
    gas: 2_000_000n,
    maxFeePerGas: 10_000_000_000n,
    maxPriorityFeePerGas: 1_000_000_000n,
  });

  const deployReceipt = await waitForReceipt(publicClient, deployHash);
  if (deployReceipt.status !== "0x1") throw new Error(`Deploy failed: status=${deployReceipt.status}`);
  success(`Deployed at ${simple8141AccountAddr}`);

  // Fund
  sectionHeader("💰 Fund Account");
  await fundAccount(walletClient, publicClient, simple8141AccountAddr);

  // Build & send FrameTx using viem/eip8141
  testHeader(1, "Send basic frame transaction");

  const account = toSimple8141Account({
    address: simple8141AccountAddr,
    owner,
    verifyGasLimit: 200_000n,
    senderGasLimit: 50_000n,
  });

  step("Sending frame transaction...");
  const txHash = await publicClient.sendFrameTransaction({
    account,
    calls: [{ to: DEAD_ADDR }],
  });

  const frameReceipt = await waitForReceipt(publicClient, txHash);
  printReceipt(frameReceipt);
  verifyReceipt(frameReceipt, simple8141AccountAddr);
  testPassed("Basic frame transaction");

  summary("Simple8141", 1);
}

main().catch((err) => {
  fatal(err);
  process.exit(1);
});
