import {
  encodeAbiParameters,
  parseAbiParameters,
  type Hex,
  type Address,
  formatEther,
} from "viem";
import { createTestClients, fundAccount } from "../helpers/client.js";
import { loadBytecode, deployContract } from "../helpers/deploy.js";

export type KernelTestContext = {
  publicClient: any;
  walletClient: any;
  devAddr: Address;
  kernelAddr: Address;
  validatorAddr: Address;
  defaultExecutorAddr: Address;
  batchExecutorAddr: Address;
  hookAddr: Address;
  handlerAddr: Address;
  sessionKeyValidatorAddr: Address;
  sessionKeyPermissionHookAddr: Address;
};

/** Deploy all 8 Kernel8141 contracts and fund the kernel with 10 ETH. */
export async function deployKernelTestbed(): Promise<KernelTestContext> {
  const { publicClient, walletClient, devAddr } = createTestClients();

  const balance = await publicClient.getBalance({ address: devAddr });
  console.log(`\n${"=".repeat(70)}`);
  console.log(`Dev account: ${devAddr}`);
  console.log(`Balance: ${formatEther(balance)} ETH`);
  console.log(`${"=".repeat(70)}\n`);

  console.log("Deploying contracts...\n");

  console.log("  1/8 ECDSAValidator");
  const validatorBytecode = loadBytecode("ECDSAValidator");
  const { address: validatorAddr } = await deployContract(
    walletClient,
    publicClient,
    validatorBytecode
  );

  console.log("  2/8 Kernel8141");
  const kernelBytecode = loadBytecode("Kernel8141");
  const constructorArgs = encodeAbiParameters(
    parseAbiParameters("address, bytes"),
    [
      validatorAddr,
      encodeAbiParameters(parseAbiParameters("address"), [devAddr]),
    ]
  );
  const kernelDeployData = (kernelBytecode + constructorArgs.slice(2)) as Hex;
  const { address: kernelAddr } = await deployContract(
    walletClient,
    publicClient,
    kernelDeployData,
    10_000_000n
  );

  console.log("  3/8 DefaultExecutor");
  const { address: defaultExecutorAddr } = await deployContract(
    walletClient,
    publicClient,
    loadBytecode("DefaultExecutor")
  );

  console.log("  4/8 BatchExecutor");
  const { address: batchExecutorAddr } = await deployContract(
    walletClient,
    publicClient,
    loadBytecode("BatchExecutor")
  );

  console.log("  5/8 SpendingLimitHook");
  const { address: hookAddr } = await deployContract(
    walletClient,
    publicClient,
    loadBytecode("SpendingLimitHook")
  );

  console.log("  6/8 ERC1271Handler");
  const { address: handlerAddr } = await deployContract(
    walletClient,
    publicClient,
    loadBytecode("ERC1271Handler")
  );

  console.log("  7/8 SessionKeyValidator");
  const { address: sessionKeyValidatorAddr } = await deployContract(
    walletClient,
    publicClient,
    loadBytecode("SessionKeyValidator")
  );

  console.log("  8/8 SessionKeyPermissionHook");
  const hookConstructorArgs = encodeAbiParameters(
    parseAbiParameters("address"),
    [sessionKeyValidatorAddr]
  );
  const hookDeployData = (loadBytecode("SessionKeyPermissionHook") +
    hookConstructorArgs.slice(2)) as Hex;
  const { address: sessionKeyPermissionHookAddr } = await deployContract(
    walletClient,
    publicClient,
    hookDeployData
  );

  console.log("\n  All contracts deployed\n");

  console.log("Funding Kernel with 10 ETH...");
  await fundAccount(walletClient, publicClient, kernelAddr);
  console.log("  Funded\n");

  return {
    publicClient,
    walletClient,
    devAddr,
    kernelAddr,
    validatorAddr,
    defaultExecutorAddr,
    batchExecutorAddr,
    hookAddr,
    handlerAddr,
    sessionKeyValidatorAddr,
    sessionKeyPermissionHookAddr,
  };
}
