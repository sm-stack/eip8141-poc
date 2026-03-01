/**
 * E2E: SpendingLimitHook lifecycle test (inline hook pattern)
 *
 * Tests that SpendingLimitHook enforces daily spending limits using the
 * inline hook model, where hook pre/post are called inside the SENDER frame:
 *
 *   Frame 0: VERIFY(kernel)  → kernel.validate(sig, 1)     — validates signature, enforces executeHooked selector
 *   Frame 1: SENDER(kernel)  → kernel.executeHooked(vId, mode, data) — hook pre/post + execution (atomic)
 *
 * Usage: cd contracts && npx tsx e2e/kernel-hooked/spending-limit.ts
 */

import {
  encodeAbiParameters,
  parseAbiParameters,
  encodeFunctionData,
  parseEther,
  formatEther,
  type Hex,
  type Address,
} from "viem";
import { DEAD_ADDR } from "../helpers/config.js";
import { createTestClients, waitForReceipt, fundAccount } from "../helpers/client.js";
import { loadBytecode, deployContract } from "../helpers/deploy.js";
import { printReceipt, banner, sectionHeader, testHeader, step, info, testPassed, summary, fatal } from "../helpers/log.js";
import { kernelAbi, factoryAbi } from "../helpers/abis/kernel.js";
import { encodeExecMode, encodeSingleExec } from "../helpers/exec-encoding.js";
import { createKernelAccount, sendAndWait } from "../helpers/send-frame-tx.js";

async function main() {
  const { publicClient, walletClient, devAddr } = createTestClients();

  const balance = await publicClient.getBalance({ address: devAddr });
  banner("SpendingLimitHook E2E (Inline Hook)");
  info(`Dev account: ${devAddr}`);
  info(`Balance: ${formatEther(balance)} ETH`);

  // ── Deploy contracts ───────────────────────────────────────────────
  sectionHeader("📦 Deploy Contracts");

  const { address: validatorAddr } = await deployContract(
    walletClient, publicClient, loadBytecode("ECDSAValidator"), 3_000_000n, "ECDSAValidator"
  );

  const { address: hookAddr } = await deployContract(
    walletClient, publicClient, loadBytecode("SpendingLimitHook"), 3_000_000n, "SpendingLimitHook"
  );

  const { address: implAddr } = await deployContract(
    walletClient, publicClient, loadBytecode("Kernel8141"), 10_000_000n, "Kernel8141 (impl)"
  );

  const factoryBytecode = loadBytecode("Kernel8141Factory");
  const factoryCtorArgs = encodeAbiParameters(parseAbiParameters("address"), [implAddr]);
  const factoryDeployData = (factoryBytecode + factoryCtorArgs.slice(2)) as Hex;
  const { address: factoryAddr } = await deployContract(
    walletClient, publicClient, factoryDeployData, 5_000_000n, "Kernel8141Factory"
  );

  // ── Create account with SpendingLimitHook as root validator's hook ─
  const rootVId = `0x01${validatorAddr.slice(2)}` as Hex;
  const salt = "0x0000000000000000000000000000000000000000000000000000000000000000" as Hex;

  // hookData = [0x00 flag byte][abi.encode(uint256 dailyLimit)]
  const hookInstallData = encodeAbiParameters(parseAbiParameters("uint256"), [parseEther("5")]);
  const hookData = ("0x00" + hookInstallData.slice(2)) as Hex;

  const initData = encodeFunctionData({
    abi: kernelAbi,
    functionName: "initialize",
    args: [
      rootVId,      // bytes21 _rootValidator
      hookAddr,     // IHook8141 hook (SpendingLimitHook)
      devAddr,      // bytes validatorData (ECDSAValidator: abi.encodePacked(owner))
      hookData,     // bytes hookData (SpendingLimitHook: abi.encode(5 ether))
      [],           // bytes[] initConfig
    ],
  });

  const kernelAddr = await (publicClient as any).readContract({
    address: factoryAddr,
    abi: factoryAbi,
    functionName: "getAddress",
    args: [initData, salt],
  }) as Address;
  step(`Predicted kernel address: ${kernelAddr}`);

  const createHash = await walletClient.sendTransaction({
    to: factoryAddr,
    data: encodeFunctionData({
      abi: factoryAbi,
      functionName: "createAccount",
      args: [initData, salt],
    }),
    gas: 5_000_000n,
    maxFeePerGas: 10_000_000_000n,
    maxPriorityFeePerGas: 1_000_000_000n,
  } as any);
  const createReceipt = await waitForReceipt(publicClient, createHash);
  if (createReceipt.status !== "0x1") throw new Error("Factory createAccount failed");
  info(`Kernel created with SpendingLimitHook (5 ETH daily limit)`);

  sectionHeader("💰 Fund Kernel");
  await fundAccount(walletClient, publicClient, kernelAddr);

  // ── Helpers ──────────────────────────────────────────────────────────
  const send = (senderCalldata: Hex, senderGas?: bigint) => {
    const account = createKernelAccount(kernelAddr, undefined, { senderGas });
    return sendAndWait(publicClient, account, senderCalldata);
  };

  // ── Tests ──────────────────────────────────────────────────────────
  const EXEC_MODE_SINGLE_DEFAULT = encodeExecMode("0x00" as Hex, "0x00" as Hex);

  // Test 1: Transfer 3 ETH with inline hook pattern
  testHeader(1, "Transfer 3 ETH (VERIFY→SENDER, inline hook)");
  {
    const execCalldata = encodeSingleExec(DEAD_ADDR, parseEther("3"));
    const senderCalldata = encodeFunctionData({
      abi: kernelAbi,
      functionName: "executeHooked",
      args: [rootVId, EXEC_MODE_SINGLE_DEFAULT, execCalldata],
    });
    const receipt = await send(senderCalldata);
    printReceipt(receipt);
    if (receipt.status !== "0x1") throw new Error("Transfer should succeed (within 5 ETH limit)");
    testPassed("3 ETH transferred with inline hook (VERIFY→SENDER)");
  }

  // Test 2: Transfer 1.5 ETH — cumulative 4.5 ETH, still within daily limit
  testHeader(2, "Transfer 1.5 ETH (cumulative 4.5 ETH, within limit)");
  {
    const execCalldata = encodeSingleExec(DEAD_ADDR, parseEther("1.5"));
    const senderCalldata = encodeFunctionData({
      abi: kernelAbi,
      functionName: "executeHooked",
      args: [rootVId, EXEC_MODE_SINGLE_DEFAULT, execCalldata],
    });
    const receipt = await send(senderCalldata);
    printReceipt(receipt);
    if (receipt.status !== "0x1") throw new Error("Transfer should succeed (4.5 ETH < 5 ETH limit)");
    testPassed("1.5 ETH transferred (cumulative spending enforcement verified)");
  }

  // Test 3: Zero-value call with inline hook
  testHeader(3, "Zero-value call (inline hook, no spending)");
  {
    const execCalldata = encodeSingleExec(DEAD_ADDR, 0n);
    const senderCalldata = encodeFunctionData({
      abi: kernelAbi,
      functionName: "executeHooked",
      args: [rootVId, EXEC_MODE_SINGLE_DEFAULT, execCalldata],
    });
    const receipt = await send(senderCalldata);
    printReceipt(receipt);
    if (receipt.status !== "0x1") throw new Error("Zero-value call should succeed");
    testPassed("Zero-value call succeeded with inline hook");
  }

  summary("SpendingLimitHook (Inline Hook)", 3);
}

main().catch((err) => {
  fatal(err);
  process.exit(1);
});
