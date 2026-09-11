import { getContractAddress, type Hex, type Address, type Hash } from "viem";
import { readFileSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import { waitForReceipt } from "./client.js";
import { deploy as logDeploy } from "./log.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const bytecodeCache = new Map<string, Hex>();

/** Load compiled bytecode from forge output artifacts (cached). */
export function loadBytecode(contractName: string): Hex {
  const cached = bytecodeCache.get(contractName);
  if (cached) return cached;
  const artifactPath = join(
    __dirname,
    "..",
    "..",
    "out",
    `${contractName}.sol`,
    `${contractName}.json`
  );
  const artifact = JSON.parse(readFileSync(artifactPath, "utf-8"));
  const bytecode = artifact.bytecode.object as Hex;
  bytecodeCache.set(contractName, bytecode);
  return bytecode;
}

/** Deploy a contract and return its address. */
export async function deployContract(
  walletClient: any,
  publicClient: any,
  bytecode: Hex,
  gas = 3_000_000n,
  label?: string
): Promise<{ hash: Hash; address: Address }> {
  const devAddr = walletClient.account.address;
  const nonce = await publicClient.getTransactionCount({ address: devAddr });
  const expectedAddr = getContractAddress({
    from: devAddr,
    nonce: BigInt(nonce),
  });

  // Under Amsterdam (EIP-8037) code deposit and account creation are charged
  // as state gas, so fixed pre-Amsterdam limits are far too small for larger
  // contracts. Prefer the node's estimate (which includes state gas) and keep
  // the caller-supplied value as a floor.
  //
  // Amsterdam splits a legacy transaction's gas into an execution budget capped
  // at MAX_TX_GAS (EIP-7825, 16,777,216) and a state reservoir made of whatever
  // exceeds that cap. A code deposit larger than ~10 KB therefore needs
  // MAX_TX_GAS + state_gas, so the estimate is padded by the execution cap.
  const maxTxGas = 16_777_216n;
  let gasLimit = gas;
  try {
    const estimate: bigint = await publicClient.estimateGas({
      account: devAddr,
      data: bytecode,
    });
    const padded = (estimate * 12n) / 10n + maxTxGas;
    if (padded > gasLimit) gasLimit = padded;
  } catch {
    // Fall back to the fixed limit; the receipt check below reports failures.
  }

  const hash = await walletClient.sendTransaction({
    data: bytecode,
    gas: gasLimit,
    maxFeePerGas: 10_000_000_000n,
    maxPriorityFeePerGas: 1_000_000_000n,
  });

  const receipt = await waitForReceipt(publicClient, hash);
  if (receipt.status !== "0x1") {
    throw new Error(`Deploy failed: status=${receipt.status}, tx=${hash}`);
  }
  logDeploy(label || "Contract", expectedAddr, hash);
  return { hash, address: expectedAddr };
}
