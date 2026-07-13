import {
  concatHex,
  encodeAbiParameters,
  encodeFunctionData,
  fromRlp,
  parseAbiParameters,
  toHex,
  toRlp,
  type Address,
  type Hex,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import {
  computeSigHash,
  computeSourceId,
  getFrameTransactionGas,
  makeEoaSignaturePlaceholder,
  makeRootReference,
  serializeFrameTransaction,
  signEoaTransaction,
  writeRecentRoot,
  type Frame,
  type RecentRootReference,
  type TransactionSerializableFrame,
} from "viem/eip8141";
import { createTestClients, waitForReceipt } from "../helpers/client.js";
import { DEAD_ADDR, DEV_KEY } from "../helpers/config.js";
import { deployContract, loadBytecode } from "../helpers/deploy.js";
import { loadFrameTransactionVector } from "../helpers/frame-vector.js";

const recentRootAddress = "0x0000000000000000000000000000000000008272" as Address;
const secondsPerSlot = 12n;
const recentRootWindow = 8192n;
const validatorAbi = [
  { type: "function", name: "validate", inputs: [], outputs: [], stateMutability: "view" },
] as const;
const writerAbi = [
  {
    type: "function",
    name: "writeTwice",
    inputs: [
      { name: "salt", type: "bytes32" },
      { name: "firstRoot", type: "bytes32" },
      { name: "secondRoot", type: "bytes32" },
    ],
    outputs: [],
    stateMutability: "nonpayable",
  },
] as const;

type Sender = ReturnType<typeof privateKeyToAccount>;

async function sendRaw(publicClient: any, raw: Hex): Promise<Hex> {
  return (await publicClient.request({
    method: "eth_sendRawTransaction",
    params: [raw],
  })) as Hex;
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

async function waitUntilDropped(publicClient: any, hash: Hex) {
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    const transaction = await publicClient.request({
      method: "eth_getTransactionByHash",
      params: [hash],
    });
    if (transaction === null) return;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(`transaction ${hash} remained in the framepool`);
}

async function advanceTime(publicClient: any, seconds: bigint) {
  await publicClient.request({
    method: "dev_advanceTime",
    params: [toHex(seconds)],
  });
}

async function currentSlot(publicClient: any): Promise<bigint> {
  const block = await publicClient.getBlock();
  return block.timestamp / secondsPerSlot;
}

function defaultFrames(): Frame[] {
  return [
    { mode: "verify", flags: 3, target: null, gasLimit: 90_000n, value: 0n, data: "0x" },
    { mode: "sender", flags: 0, target: DEAD_ADDR, gasLimit: 30_000n, value: 0n, data: "0x" },
  ];
}

async function buildRaw(
  publicClient: any,
  sender: Sender,
  nonceKey: bigint,
  recentRootReferences: RecentRootReference[],
  options: { frames?: Frame[]; maxFeePerGas?: bigint; maxPriorityFeePerGas?: bigint } = {},
) {
  const fees = await publicClient.estimateFeesPerGas();
  const placeholder = makeEoaSignaturePlaceholder(sender.address);
  const unsigned: TransactionSerializableFrame = {
    chainId: 1337,
    nonceKeys: [nonceKey],
    nonceSeq: 0n,
    sender: sender.address,
    frames: options.frames ?? defaultFrames(),
    signatures: [placeholder],
    recentRootReferences,
    maxPriorityFeePerGas: options.maxPriorityFeePerGas ?? fees.maxPriorityFeePerGas,
    maxFeePerGas: options.maxFeePerGas ?? fees.maxFeePerGas,
    type: "frame",
  };
  const signature = await signEoaTransaction(sender, computeSigHash(unsigned));
  const transaction = { ...unsigned, signatures: [signature] };
  return { raw: serializeFrameTransaction(transaction), transaction };
}

async function deployValidator(
  walletClient: any,
  publicClient: any,
  reference: RecentRootReference,
) {
  const constructor = encodeAbiParameters(parseAbiParameters("bytes32, uint64, bytes32"), [
    reference.sourceId,
    reference.slot,
    reference.root,
  ]);
  return deployContract(
    walletClient,
    publicClient,
    `${loadBytecode("RootAnchoredValidator")}${constructor.slice(2)}` as Hex,
    800_000n,
    "RootAnchoredValidator",
  );
}

async function main() {
  const { publicClient, walletClient } = createTestClients();
  const sender = privateKeyToAccount(DEV_KEY);
  let nonceKey = 827_200n;

  const salt = `0x${"11".repeat(32)}` as Hex;
  const root = `0x${"22".repeat(32)}` as Hex;
  const writeHash = await writeRecentRoot(walletClient as any, { salt, root });
  const writeReceipt = await waitForReceipt(publicClient, writeHash);
  const writeBlock = await publicClient.getBlock({ blockNumber: BigInt(writeReceipt.blockNumber) });
  const writeSlot = writeBlock.timestamp / secondsPerSlot;
  const reference = makeRootReference({
    sourceId: computeSourceId(sender.address, salt),
    slot: writeSlot,
    root,
  });

  const sameSlot = await buildRaw(publicClient, sender, nonceKey++, [reference]);
  if ((await currentSlot(publicClient)) !== writeSlot)
    throw new Error("devnet crossed a slot before the same-slot admission check");
  await expectRejected(publicClient, sameSlot.raw, "same-slot reference rejection");

  await advanceTime(publicClient, secondsPerSlot);
  const validHash = await sendRaw(publicClient, sameSlot.raw);
  const validReceipt = await waitForReceipt(publicClient, validHash);
  if (validReceipt.status !== "0x1") throw new Error("S+1 reference transaction failed");
  console.log("PASS root written in S is referenceable from S+1");

  const slot = await currentSlot(publicClient);
  const invalidCases: [string, RecentRootReference][] = [
    ["future reference rejection", { ...reference, slot: slot + 1n }],
    ["8192-slot expired reference rejection", { ...reference, slot: slot - recentRootWindow }],
    ["wrong source rejection", { ...reference, sourceId: `0x${"33".repeat(32)}` }],
    ["wrong root rejection", { ...reference, root: `0x${"44".repeat(32)}` }],
  ];
  for (const [label, invalidReference] of invalidCases) {
    const invalid = await buildRaw(publicClient, sender, nonceKey++, [invalidReference]);
    await expectRejected(publicClient, invalid.raw, label);
  }

  const { address: writer } = await deployContract(
    walletClient,
    publicClient,
    loadBytecode("RecentRootWriter"),
    500_000n,
    "RecentRootWriter",
  );
  const writerSalt = `0x${"55".repeat(32)}` as Hex;
  const firstRoot = `0x${"66".repeat(32)}` as Hex;
  const secondRoot = `0x${"77".repeat(32)}` as Hex;
  const doubleWriteHash = await (walletClient as any).writeContract({
    address: writer,
    abi: writerAbi,
    functionName: "writeTwice",
    args: [writerSalt, firstRoot, secondRoot],
  });
  const doubleWriteReceipt = await waitForReceipt(publicClient, doubleWriteHash);
  const doubleWriteBlock = await publicClient.getBlock({
    blockNumber: BigInt(doubleWriteReceipt.blockNumber),
  });
  const doubleWriteSlot = doubleWriteBlock.timestamp / secondsPerSlot;
  await advanceTime(publicClient, secondsPerSlot);
  const writerSourceId = computeSourceId(writer, writerSalt);
  const overwritten = makeRootReference({ sourceId: writerSourceId, slot: doubleWriteSlot, root: firstRoot });
  const finalReference = makeRootReference({ sourceId: writerSourceId, slot: doubleWriteSlot, root: secondRoot });
  await expectRejected(
    publicClient,
    (await buildRaw(publicClient, sender, nonceKey++, [overwritten])).raw,
    "same-slot overwritten root rejection",
  );
  const finalHash = await sendRaw(
    publicClient,
    (await buildRaw(publicClient, sender, nonceKey++, [finalReference])).raw,
  );
  const finalReceipt = await waitForReceipt(publicClient, finalHash);
  if (finalReceipt.status !== "0x1") throw new Error("last same-slot root transaction failed");
  console.log("PASS same-slot last write is the only referenceable root");

  const { address: validator } = await deployValidator(walletClient, publicClient, finalReference);
  const fundingReceipt = await waitForReceipt(
    publicClient,
    await (walletClient as any).sendTransaction({ to: validator, value: 1_000_000_000_000_000_000n }),
  );
  if (fundingReceipt.status !== "0x1") throw new Error("validator funding failed");
  const validatorFrames: Frame[] = [
    { mode: "verify", flags: 2, target: null, gasLimit: 70_000n, value: 0n, data: "0x" },
    {
      mode: "verify",
      flags: 1,
      target: validator,
      gasLimit: 25_000n,
      value: 0n,
      data: encodeFunctionData({ abi: validatorAbi, functionName: "validate" }),
    },
    { mode: "sender", flags: 0, target: DEAD_ADDR, gasLimit: 30_000n, value: 0n, data: "0x" },
  ];
  const validatorTx = await buildRaw(publicClient, sender, nonceKey++, [finalReference], {
    frames: validatorFrames,
  });
  const validatorReceipt = await waitForReceipt(
    publicClient,
    await sendRaw(publicClient, validatorTx.raw),
  );
  if (validatorReceipt.status !== "0x1") throw new Error("RootAnchoredValidator transaction failed");
  console.log("PASS RootAnchoredValidator reads and approves the expected tuple");

  const mismatchedExpectation = { ...finalReference, root: firstRoot };
  const { address: mismatchValidator } = await deployValidator(
    walletClient,
    publicClient,
    mismatchedExpectation,
  );
  const mismatchFrames = validatorFrames.map((frame, index) =>
    index === 1 ? { ...frame, target: mismatchValidator } : frame,
  );
  await expectRejected(
    publicClient,
    (await buildRaw(publicClient, sender, nonceKey++, [finalReference], { frames: mismatchFrames })).raw,
    "RootAnchoredValidator tuple mismatch rejection",
  );

  const gasRuns: { count: number; gasUsed: bigint; calculated: bigint }[] = [];
  for (const count of [0, 1, 16]) {
    const refs = Array.from({ length: count }, () => finalReference);
    const built = await buildRaw(publicClient, sender, nonceKey++, refs);
    const receipt = await waitForReceipt(publicClient, await sendRaw(publicClient, built.raw));
    gasRuns.push({
      count,
      gasUsed: BigInt(receipt.gasUsed),
      calculated: getFrameTransactionGas(built.transaction),
    });
  }
  for (const run of gasRuns.slice(1)) {
    const actualDelta = run.gasUsed - gasRuns[0]!.gasUsed;
    const calculatedDelta = run.calculated - gasRuns[0]!.calculated;
    if (actualDelta !== calculatedDelta)
      throw new Error(`reference gas delta for ${run.count}: geth=${actualDelta} viem=${calculatedDelta}`);
  }
  console.log("PASS geth/viem intrinsic gas deltas for 0, 1, and 16 references");

  const { transaction: vector, sigHash, rawTransaction: expectedVectorRaw } =
    loadFrameTransactionVector();
  const vectorRaw = serializeFrameTransaction(vector);
  if (computeSigHash(vector) !== sigHash)
    throw new Error("geth/viem EIP-8272 sig-hash vector mismatch");
  if (vectorRaw !== expectedVectorRaw) {
    const mismatch = [...vectorRaw].findIndex((character, index) => character !== expectedVectorRaw[index]);
    throw new Error(`geth/viem EIP-8272 raw transaction vector mismatch at ${mismatch}: ${vectorRaw}`);
  }
  const fields = fromRlp(`0x${vectorRaw.slice(4)}` as Hex, "hex") as any[];
  fields.pop();
  const legacyTenField = concatHex(["0x06", toRlp(fields as any)]);
  await expectRejected(publicClient, legacyTenField, "legacy 10-field wire rejection");
  console.log("PASS shared raw transaction and sig-hash vectors");

  const expiryPending = await buildRaw(publicClient, sender, nonceKey++, [finalReference], {
    maxFeePerGas: 1n,
    maxPriorityFeePerGas: 1n,
  });
  const expiryHash = await sendRaw(publicClient, expiryPending.raw);
  await advanceTime(publicClient, recentRootWindow * secondsPerSlot);
  await waitUntilDropped(publicClient, expiryHash);
  console.log("PASS framepool evicts a reference at the 8192-slot boundary");

  const reorgSalt = `0x${"88".repeat(32)}` as Hex;
  const reorgRoot = `0x${"99".repeat(32)}` as Hex;
  const beforeWrite = await publicClient.getBlockNumber();
  const reorgWriteHash = await writeRecentRoot(walletClient as any, {
    salt: reorgSalt,
    root: reorgRoot,
  });
  const reorgWriteReceipt = await waitForReceipt(publicClient, reorgWriteHash);
  const reorgWriteBlock = await publicClient.getBlock({
    blockNumber: BigInt(reorgWriteReceipt.blockNumber),
  });
  const reorgReference = makeRootReference({
    sourceId: computeSourceId(sender.address, reorgSalt),
    slot: reorgWriteBlock.timestamp / secondsPerSlot,
    root: reorgRoot,
  });
  await advanceTime(publicClient, secondsPerSlot);
  const reorgPending = await buildRaw(publicClient, sender, nonceKey++, [reorgReference], {
    maxFeePerGas: 1n,
    maxPriorityFeePerGas: 1n,
  });
  const reorgHash = await sendRaw(publicClient, reorgPending.raw);
  await publicClient.request({ method: "debug_setHead", params: [toHex(beforeWrite)] });
  await waitUntilDropped(publicClient, reorgHash);
  console.log("PASS head rewind revalidates and evicts missing recent roots");

  const code = await publicClient.getCode({ address: recentRootAddress });
  if (!code || code === "0x") throw new Error("RECENT_ROOT native marker code missing");
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
