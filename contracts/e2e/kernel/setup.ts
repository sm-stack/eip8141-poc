import {
  encodeAbiParameters,
  parseAbiParameters,
  encodeFunctionData,
  formatEther,
  type Hex,
  type Address,
} from "viem";
import { createTestClients, fundAccount, waitForReceipt } from "../helpers/client.js";
import { loadBytecode, deployContract } from "../helpers/deploy.js";
import { CHAIN_DEF, HOOK_INSTALLED } from "../helpers/config.js";
import { banner, sectionHeader, step, info, success } from "../helpers/log.js";
import { kernelAbi, factoryAbi } from "../helpers/abis/kernel.js";

export type KernelTestContext = {
  publicClient: any;
  walletClient: any;
  devAddr: Address;
  kernelAddr: Address;
  factoryAddr: Address;
  validatorAddr: Address;
  defaultExecutorAddr: Address;
  batchExecutorAddr: Address;
  hookAddr: Address;
  sessionKeyValidatorAddr: Address;
  sessionKeyPermissionHookAddr: Address;
};

/** Deploy all Kernel8141 contracts via factory and fund the kernel with 10 ETH. */
export async function deployKernelTestbed(): Promise<KernelTestContext> {
  const { publicClient, walletClient, devAddr } = createTestClients();

  const balance = await publicClient.getBalance({ address: devAddr });
  banner("Kernel8141 E2E");
  info(`Dev account: ${devAddr}`);
  info(`Balance: ${formatEther(balance)} ETH`);

  sectionHeader("📦 Deploy Contracts");

  // 1. ECDSAValidator
  const { address: validatorAddr } = await deployContract(
    walletClient, publicClient, loadBytecode("ECDSAValidator"), 3_000_000n, "ECDSAValidator"
  );

  // 2. Kernel8141 implementation (constructor sets sentinel to prevent direct use)
  const { address: implAddr } = await deployContract(
    walletClient, publicClient, loadBytecode("Kernel8141"), 10_000_000n, "Kernel8141 (impl)"
  );

  // 3. Kernel8141Factory(impl)
  const factoryBytecode = loadBytecode("Kernel8141Factory");
  const factoryCtorArgs = encodeAbiParameters(parseAbiParameters("address"), [implAddr]);
  const factoryDeployData = (factoryBytecode + factoryCtorArgs.slice(2)) as Hex;
  const { address: factoryAddr } = await deployContract(
    walletClient, publicClient, factoryDeployData, 5_000_000n, "Kernel8141Factory"
  );

  // 4. Create account via factory
  // rootVId = 0x01 (VALIDATION_TYPE_VALIDATOR) + validatorAddr (20 bytes) = bytes21
  const rootVId = `0x01${validatorAddr.slice(2)}` as Hex;
  const salt = "0x0000000000000000000000000000000000000000000000000000000000000000" as Hex;

  const initData = encodeFunctionData({
    abi: kernelAbi,
    functionName: "initialize",
    args: [
      rootVId,        // bytes21 _rootValidator
      HOOK_INSTALLED, // IHook8141 hook (sentinel — no real hook)
      devAddr,        // bytes validatorData (ECDSAValidator: abi.encodePacked(owner))
      "0x",           // bytes hookData
      [],             // bytes[] initConfig
    ],
  });

  // Predict deterministic address
  const kernelAddr = await (publicClient as any).readContract({
    address: factoryAddr,
    abi: factoryAbi,
    functionName: "getAddress",
    args: [initData, salt],
  }) as Address;
  step(`Predicted kernel address: ${kernelAddr}`);

  // Deploy proxy
  const createHash = await walletClient.sendTransaction({
    chain: CHAIN_DEF,
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
  success(`Kernel8141 proxy created at ${kernelAddr}`);

  // 5-8. Deploy remaining modules
  const { address: defaultExecutorAddr } = await deployContract(
    walletClient, publicClient, loadBytecode("DefaultExecutor"), 3_000_000n, "DefaultExecutor"
  );

  const { address: batchExecutorAddr } = await deployContract(
    walletClient, publicClient, loadBytecode("BatchExecutor"), 3_000_000n, "BatchExecutor"
  );

  const { address: hookAddr } = await deployContract(
    walletClient, publicClient, loadBytecode("SpendingLimitHook"), 3_000_000n, "SpendingLimitHook"
  );

  const { address: sessionKeyValidatorAddr } = await deployContract(
    walletClient, publicClient, loadBytecode("SessionKeyValidator"), 3_000_000n, "SessionKeyValidator"
  );

  const hookCtorArgs = encodeAbiParameters(parseAbiParameters("address"), [sessionKeyValidatorAddr]);
  const hookDeployData = (loadBytecode("SessionKeyPermissionHook") + hookCtorArgs.slice(2)) as Hex;
  const { address: sessionKeyPermissionHookAddr } = await deployContract(
    walletClient, publicClient, hookDeployData, 3_000_000n, "SessionKeyPermissionHook"
  );

  success("All contracts deployed");

  sectionHeader("💰 Fund Kernel");
  await fundAccount(walletClient, publicClient, kernelAddr);

  return {
    publicClient, walletClient, devAddr,
    kernelAddr, factoryAddr, validatorAddr,
    defaultExecutorAddr, batchExecutorAddr,
    hookAddr, sessionKeyValidatorAddr, sessionKeyPermissionHookAddr,
  };
}
