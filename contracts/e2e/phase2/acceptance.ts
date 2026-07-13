import { encodeFunctionData, type Address, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import {
  computeSigHash,
  getKeyedNonce,
  makeEoaSignaturePlaceholder,
  serializeFrameTransaction,
  signEoaTransaction,
  type Frame,
  type TransactionSerializableFrame,
} from "viem/eip8141";
import { createTestClients, waitForReceipt } from "../helpers/client.js";
import { DEAD_ADDR, DEV_KEY, RPC_URL } from "../helpers/config.js";
import { deployContract, loadBytecode } from "../helpers/deploy.js";

const nonceManager = "0x0000000000000000000000000000000000008250" as Address;
const targetAbi = [
  { type: "function", name: "fail", inputs: [], outputs: [], stateMutability: "pure" },
] as const;

async function buildRaw(
  publicClient: any,
  sender: ReturnType<typeof privateKeyToAccount>,
  nonceKeys: bigint[],
  nonceSeq: bigint,
  frames?: Frame[],
) {
  const fees = await publicClient.estimateFeesPerGas();
  const txFrames = frames ?? [
    { mode: "verify", flags: 3, target: null, gasLimit: 90_000n, value: 0n, data: "0x" },
    { mode: "sender", flags: 0, target: DEAD_ADDR, gasLimit: 30_000n, value: 0n, data: "0x" },
  ];
  const placeholder = makeEoaSignaturePlaceholder(sender.address);
  const unsigned: TransactionSerializableFrame = {
    chainId: 1337,
    nonceKeys,
    nonceSeq,
    sender: sender.address,
    frames: txFrames,
    signatures: [placeholder],
    recentRootReferences: [],
    maxPriorityFeePerGas: fees.maxPriorityFeePerGas,
    maxFeePerGas: fees.maxFeePerGas,
    type: "frame",
  };
  const signature = await signEoaTransaction(sender, computeSigHash(unsigned));
  return serializeFrameTransaction({ ...unsigned, signatures: [signature] });
}

async function sendRaw(publicClient: any, raw: Hex): Promise<Hex> {
  return (await publicClient.request({
    method: "eth_sendRawTransaction",
    params: [raw],
  })) as Hex;
}

async function sendBatch(raws: Hex[]): Promise<Hex[]> {
  const response = await fetch(RPC_URL, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(
      raws.map((raw, index) => ({
        jsonrpc: "2.0",
        id: index + 1,
        method: "eth_sendRawTransaction",
        params: [raw],
      })),
    ),
  });
  const results = (await response.json()) as { id: number; result?: Hex; error?: unknown }[];
  if (results.some(({ error, result }) => error || !result))
    throw new Error(`batch submission failed: ${JSON.stringify(results)}`);
  return results
    .sort((a, b) => a.id - b.id)
    .map(({ result }) => {
      if (!/^0x[0-9a-fA-F]{64}$/.test(result!))
        throw new Error(`batch submission returned invalid hash: ${result}`);
      return result!;
    });
}

async function expectRejected(publicClient: any, raw: Hex, label: string) {
  try {
    await sendRaw(publicClient, raw);
  } catch {
    console.log(`PASS ${label}`);
    return;
  }
  throw new Error(`${label}: transaction was unexpectedly accepted`);
}

async function main() {
  const { publicClient, walletClient } = createTestClients();
  const sender = privateKeyToAccount(DEV_KEY);

  const parallelRaws = await Promise.all([
    buildRaw(publicClient, sender, [101n], 0n),
    buildRaw(publicClient, sender, [102n], 0n),
  ]);
  const parallelHashes = await sendBatch(parallelRaws);
  console.log(`INFO parallel transaction hashes: ${parallelHashes.join(", ")}`);
  const parallelReceipts = await Promise.all(
    parallelHashes.map((hash) => waitForReceipt(publicClient, hash)),
  );
  if (parallelReceipts[0].blockNumber !== parallelReceipts[1].blockNumber)
    throw new Error("independent nonce domains were not included in the same block");
  console.log("PASS independent nonce domains from one sender share a block");

  await expectRejected(publicClient, parallelRaws[0]!, "consumed key replay rejection");

  const firstUseRaw = await buildRaw(publicClient, sender, [201n], 0n);
  const firstUseReceipt = await waitForReceipt(publicClient, await sendRaw(publicClient, firstUseRaw));
  const reuseRaw = await buildRaw(publicClient, sender, [201n], 1n);
  const reuseReceipt = await waitForReceipt(publicClient, await sendRaw(publicClient, reuseRaw));
  const firstVerifyGas = BigInt(firstUseReceipt.frameReceipts[0].gasUsed);
  const reuseVerifyGas = BigInt(reuseReceipt.frameReceipts[0].gasUsed);
  if (firstVerifyGas - reuseVerifyGas !== 20_000n)
    throw new Error(`first-use gas delta ${firstVerifyGas - reuseVerifyGas}, want 20000`);
  console.log("PASS first-use 20000 gas surcharge and reuse exemption");

  const { address: target } = await deployContract(
    walletClient,
    publicClient,
    loadBytecode("Phase1AcceptanceTarget"),
    500_000n,
    "Phase1AcceptanceTarget",
  );
  const fail = encodeFunctionData({ abi: targetAbi, functionName: "fail" });
  const rollbackFrames: Frame[] = [
    { mode: "verify", flags: 3, target: null, gasLimit: 90_000n, value: 0n, data: "0x" },
    { mode: "sender", flags: 4, target, gasLimit: 80_000n, value: 0n, data: fail },
    { mode: "sender", flags: 0, target, gasLimit: 80_000n, value: 0n, data: "0x" },
  ];
  const rollbackRaw = await buildRaw(publicClient, sender, [301n], 0n, rollbackFrames);
  const rollbackReceipt = await waitForReceipt(
    publicClient,
    await sendRaw(publicClient, rollbackRaw),
  );
  if (rollbackReceipt.frameReceipts[1].status !== "0x0" || rollbackReceipt.frameReceipts[2].status !== "0x3")
    throw new Error(`unexpected rollback statuses ${JSON.stringify(rollbackReceipt.frameReceipts)}`);
  if ((await getKeyedNonce(publicClient, { sender: sender.address, key: 301n })) !== 1n)
    throw new Error("payment approval nonce effect was rolled back");
  console.log("PASS approval nonce effect survives atomic rollback");

  try {
    await publicClient.call({ to: nonceManager, data: "0x" });
  } catch {
    console.log("PASS NONCE_MANAGER rejects direct calls");
    return;
  }
  throw new Error("NONCE_MANAGER direct call unexpectedly succeeded");
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
