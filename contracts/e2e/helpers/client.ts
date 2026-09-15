import {
  createPublicClient,
  createWalletClient,
  http,
  parseEther,
  type Hash,
  type Address,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";

/**
 * EIP-8272 slot of a block. Amsterdam headers carry the EIP-7843 `slotNumber`;
 * older headers fall back to `timestamp / SECONDS_PER_SLOT`.
 */
export function blockSlot(block: any, secondsPerSlot = 12n): bigint {
  if (block.slotNumber !== undefined && block.slotNumber !== null) return BigInt(block.slotNumber);
  return BigInt(block.timestamp) / secondsPerSlot;
}
import { eip8141Devnet, frameActions } from "viem/eip8141";
import { RPC_URL, DEV_KEY } from "./config.js";
import { fund as logFund } from "./log.js";

export async function waitForReceipt(
  publicClient: any,
  hash: Hash,
  timeoutMs = 60_000
): Promise<any> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const receipt = await publicClient.request({
        method: "eth_getTransactionReceipt" as any,
        params: [hash],
      });
      if (receipt) return receipt;
    } catch (e) {
      // Receipt not yet available, retry
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error(`Timeout waiting for receipt of ${hash}`);
}

export function createTestClients(rpcUrl = RPC_URL) {
  const account = privateKeyToAccount(DEV_KEY);
  const devAddr = account.address;
  const publicClient = createPublicClient({
    chain: eip8141Devnet,
    transport: http(rpcUrl),
  }).extend(frameActions());
  const walletClient = createWalletClient({
    account,
    chain: eip8141Devnet,
    transport: http(rpcUrl),
  });
  return { account, publicClient, walletClient, devAddr };
}

export async function fundAccount(
  walletClient: any,
  publicClient: any,
  to: Address,
  ethAmount = "10"
): Promise<void> {
  const fundHash = await walletClient.sendTransaction({
    to,
    value: parseEther(ethAmount),
    // Amsterdam (EIP-8037) charges 120 * 1530 state gas to create the
    // recipient account on top of the 21,000 base cost.
    gas: 250_000n,
    maxFeePerGas: 10_000_000_000n,
    maxPriorityFeePerGas: 1_000_000_000n,
  });
  await waitForReceipt(publicClient, fundHash);
  logFund(to, `${ethAmount} ETH`);
}
