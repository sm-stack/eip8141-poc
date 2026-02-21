import {
  encodeAbiParameters,
  parseAbiParameters,
  encodeFunctionData,
  formatEther,
  type Hex,
  type Address,
} from "viem";
import { createTestClients, fundAccount } from "../helpers/client.js";
import { loadBytecode, deployContract } from "../helpers/deploy.js";
import { walletAbi, factoryAbi } from "../helpers/abis/light-account.js";
import { banner, sectionHeader, info, success, detail } from "../helpers/log.js";

export type LightAccountTestContext = {
  publicClient: any;
  walletClient: any;
  devAddr: Address;
  walletAddr: Address;
  factoryAddr: Address;
  implAddr: Address;
};

/** Deploy LightAccount8141 via Factory and fund with 10 ETH. */
export async function deployLightAccountTestbed(): Promise<LightAccountTestContext> {
  const { publicClient, walletClient, devAddr } = createTestClients();

  const balance = await publicClient.getBalance({ address: devAddr });
  banner("LightAccount8141 E2E");
  info(`Owner (ECDSA): ${devAddr}`);
  info(`Balance: ${formatEther(balance)} ETH`);

  // ── Deploy Implementation ──
  sectionHeader("Deploy Implementation");
  const implBytecode = loadBytecode("LightAccount8141");
  const { address: implAddr } = await deployContract(
    walletClient, publicClient, implBytecode, 5_000_000n, "LightAccount8141 (impl)"
  );

  // ── Deploy Factory ──
  sectionHeader("Deploy Factory");
  const factoryBytecode = loadBytecode("LightAccountFactory8141");
  const factoryConstructorArgs = encodeAbiParameters(
    parseAbiParameters("address"),
    [implAddr]
  );
  const factoryDeployData = (factoryBytecode + factoryConstructorArgs.slice(2)) as Hex;
  const { address: factoryAddr } = await deployContract(
    walletClient, publicClient, factoryDeployData, 3_000_000n, "LightAccountFactory8141"
  );

  // ── Create Account via Factory ──
  sectionHeader("Create Account via Factory");

  // Predict deterministic address
  const walletAddr = await publicClient.readContract({
    address: factoryAddr,
    abi: factoryAbi,
    functionName: "getAddress",
    args: [devAddr, 0n],
  }) as Address;
  detail(`Predicted wallet address: ${walletAddr}`);

  // Deploy via factory
  const createData = encodeFunctionData({
    abi: factoryAbi,
    functionName: "createAccount",
    args: [devAddr, 0n],
  });
  const createHash = await walletClient.sendTransaction({
    to: factoryAddr,
    data: createData,
    gas: 5_000_000n,
    maxFeePerGas: 10_000_000_000n,
    maxPriorityFeePerGas: 1_000_000_000n,
  });
  const createReceipt = await publicClient.waitForTransactionReceipt({ hash: createHash });
  if (createReceipt.status !== "success") {
    throw new Error(`Factory createAccount failed: tx=${createHash}`);
  }
  success(`Account created at ${walletAddr}`);

  // ── Verify Owner ──
  sectionHeader("Verify Owner");
  const currentOwner = await publicClient.readContract({
    address: walletAddr,
    abi: walletAbi,
    functionName: "owner",
  }) as Address;
  detail(`Owner: ${currentOwner}`);
  if (currentOwner.toLowerCase() !== devAddr.toLowerCase()) {
    throw new Error(`Expected owner ${devAddr}, got ${currentOwner}`);
  }
  success("Owner verified");

  // ── Fund Wallet ──
  sectionHeader("Fund Wallet");
  await fundAccount(walletClient, publicClient, walletAddr);

  return { publicClient, walletClient, devAddr, walletAddr, factoryAddr, implAddr };
}
