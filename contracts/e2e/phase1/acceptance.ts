import {
  encodeAbiParameters,
  encodeFunctionData,
  parseAbiParameters,
  type Address,
  type Hex,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import {
  computeSigHash,
  makeEoaSignaturePlaceholder,
  makeExpiryFrame,
  serializeFrameTransaction,
  signEoaTransaction,
  toSimple8141Account,
  type Frame,
  type FramePaymaster,
  type TransactionSerializableFrame,
  type TxSignature,
} from "viem/eip8141";
import { DEV_KEY, DEAD_ADDR } from "../helpers/config.js";
import { createTestClients, fundAccount, waitForReceipt } from "../helpers/client.js";
import { deployContract, loadBytecode } from "../helpers/deploy.js";
import { loadFrameTransactionVector } from "../helpers/frame-vector.js";

const targetAbi = [
  { type: "function", name: "setValue", inputs: [{ name: "newValue", type: "uint256" }], outputs: [], stateMutability: "nonpayable" },
  { type: "function", name: "fail", inputs: [], outputs: [], stateMutability: "pure" },
  { type: "function", name: "value", inputs: [], outputs: [{ type: "uint256" }], stateMutability: "view" },
] as const;

const canonicalPaymasterAbi = [
  { type: "function", name: "validate", inputs: [{ name: "signatureIndex", type: "uint256" }], outputs: [], stateMutability: "view" },
] as const;

async function transactionBase(publicClient: any, sender: Address) {
  const [nonce, fees] = await Promise.all([
    publicClient.getTransactionCount({ address: sender, blockTag: "pending" }),
    publicClient.estimateFeesPerGas(),
  ]);
  return {
    chainId: 1337,
    nonce,
    sender,
    maxPriorityFeePerGas: fees.maxPriorityFeePerGas,
    maxFeePerGas: fees.maxFeePerGas,
    type: "frame" as const,
  };
}

async function signAndSend(
  publicClient: any,
  base: Awaited<ReturnType<typeof transactionBase>>,
  frames: Frame[],
  signers: ReturnType<typeof privateKeyToAccount>[],
) {
  const placeholders = signers.map((signer) => makeEoaSignaturePlaceholder(signer.address));
  const unsigned: TransactionSerializableFrame = {
    ...base,
    frames,
    signatures: placeholders,
    recentRootReferences: [],
  };
  const sigHash = computeSigHash(unsigned);
  const signatures: TxSignature[] = await Promise.all(
    signers.map((signer) => signEoaTransaction(signer, sigHash)),
  );
  const raw = serializeFrameTransaction({ ...unsigned, signatures });
  const hash = await publicClient.request({ method: "eth_sendRawTransaction", params: [raw] });
  return { hash: hash as Hex, raw, sigHash };
}

async function expectRejected(publicClient: any, raw: Hex, label: string) {
  try {
    await publicClient.request({ method: "eth_sendRawTransaction", params: [raw] });
  } catch {
    console.log(`PASS ${label}`);
    return;
  }
  throw new Error(`${label}: transaction was unexpectedly accepted`);
}

async function waitUntilDropped(publicClient: any, hash: Hex) {
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    const transaction = await publicClient.request({
      method: "eth_getTransactionByHash",
      params: [hash],
    });
    if (transaction === null) return;
    if ((transaction as any).blockHash !== null) {
      throw new Error(`expired transaction ${hash} was mined before eviction`);
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new Error(`expired transaction ${hash} remained in the framepool`);
}

async function main() {
  const { publicClient, walletClient } = createTestClients();
  const sender = privateKeyToAccount(DEV_KEY);

  const { address: target } = await deployContract(
    walletClient,
    publicClient,
    loadBytecode("Phase1AcceptanceTarget"),
    500_000n,
    "Phase1AcceptanceTarget",
  );

  const setOne = encodeFunctionData({ abi: targetAbi, functionName: "setValue", args: [1n] });
  const setTwo = encodeFunctionData({ abi: targetAbi, functionName: "setValue", args: [2n] });
  const fail = encodeFunctionData({ abi: targetAbi, functionName: "fail" });
  const atomicFrames: Frame[] = [
    { mode: "verify", flags: 3, target: null, gasLimit: 80_000n, value: 0n, data: "0x" },
    { mode: "sender", flags: 4, target, gasLimit: 80_000n, value: 0n, data: setOne },
    { mode: "sender", flags: 4, target, gasLimit: 80_000n, value: 0n, data: fail },
    { mode: "sender", flags: 0, target, gasLimit: 80_000n, value: 0n, data: setTwo },
  ];
  const atomic = await signAndSend(publicClient, await transactionBase(publicClient, sender.address), atomicFrames, [sender]);
  const atomicReceipt: any = await waitForReceipt(publicClient, atomic.hash);
  const statuses = atomicReceipt.frameReceipts?.map((frame: any) => frame.status);
  if (JSON.stringify(statuses) !== JSON.stringify(["0x1", "0x1", "0x0", "0x2"])) {
    throw new Error(`atomic statuses: ${JSON.stringify(statuses)}`);
  }
  if (BigInt(atomicReceipt.frameReceipts[3].gasUsed) !== 0n) throw new Error("skipped frame consumed gas");
  const stored = await publicClient.readContract({ address: target, abi: targetAbi, functionName: "value" });
  if (stored !== 0n) throw new Error(`atomic rollback left value ${stored}`);
  console.log("PASS atomic rollback, status 2, and skipped gas refund");

  const simpleConstructor = encodeAbiParameters(parseAbiParameters("address"), [sender.address]);
  const simpleInitCode = `${loadBytecode("Simple8141Account")}${simpleConstructor.slice(2)}` as Hex;
  const { address: simpleAddress } = await deployContract(
    walletClient,
    publicClient,
    simpleInitCode,
    1_000_000n,
    "Simple8141Account",
  );
  await fundAccount(walletClient, publicClient, simpleAddress, "10");
  const simpleAccount = toSimple8141Account({
    address: simpleAddress,
    owner: sender,
    verifyGasLimit: 80_000n,
  });
  const simpleHash = await publicClient.sendFrameTransaction({
    account: simpleAccount,
    calls: [{ to: DEAD_ADDR }],
  });
  const simpleReceipt: any = await waitForReceipt(publicClient, simpleHash);
  if (simpleReceipt.status !== "0x1") throw new Error("Simple8141Account tx-level signature failed");
  console.log("PASS SIGPARAM and FRAMEPARAM runtime wrappers");

  const latest = await publicClient.getBlock();
  const validExpiry = makeExpiryFrame(latest.timestamp + 60n, 10_000n);
  const validFrames: Frame[] = [
    validExpiry,
    { mode: "verify", flags: 3, target: null, gasLimit: 80_000n, value: 0n, data: "0x" },
    { mode: "sender", flags: 0, target: DEAD_ADDR, gasLimit: 30_000n, value: 0n, data: "0x" },
  ];
  const valid = await signAndSend(publicClient, await transactionBase(publicClient, sender.address), validFrames, [sender]);
  const validReceipt: any = await waitForReceipt(publicClient, valid.hash);
  if (validReceipt.status !== "0x1") throw new Error("valid expiry transaction failed");
  console.log("PASS valid expiry transaction");

  const expiredFrames = [...validFrames];
  expiredFrames[0] = makeExpiryFrame(latest.timestamp - 1n, 10_000n);
  const expiredBase = await transactionBase(publicClient, sender.address);
  const expiredPlaceholder = makeEoaSignaturePlaceholder(sender.address);
  const expiredUnsigned = {
    ...expiredBase,
    frames: expiredFrames,
    signatures: [expiredPlaceholder],
    recentRootReferences: [],
  };
  const expiredSig = await signEoaTransaction(sender, computeSigHash(expiredUnsigned));
  await expectRejected(publicClient, serializeFrameTransaction({ ...expiredUnsigned, signatures: [expiredSig] }), "expired deadline rejection");

  const pendingHead = await publicClient.getBlock();
  const pendingFrames = [...validFrames];
  pendingFrames[0] = makeExpiryFrame(pendingHead.timestamp + 14n, 10_000n);
  const pendingBase = await transactionBase(publicClient, sender.address);
  pendingBase.maxPriorityFeePerGas = 1n;
  pendingBase.maxFeePerGas = 1n;
  const pending = await signAndSend(publicClient, pendingBase, pendingFrames, [sender]);
  const pooled = await publicClient.request({
    method: "eth_getTransactionByHash",
    params: [pending.hash],
  });
  if (pooled === null) throw new Error("expiry transaction did not enter the framepool");
  await waitUntilDropped(publicClient, pending.hash);
  const pendingReceipt = await publicClient.request({
    method: "eth_getTransactionReceipt",
    params: [pending.hash],
  });
  if (pendingReceipt !== null) throw new Error("expired framepool transaction was mined");
  console.log("PASS expired transaction framepool eviction");

  const paymasterSigner = privateKeyToAccount(`0x${"42".repeat(32)}`);
  const constructorArg = encodeAbiParameters(parseAbiParameters("address"), [paymasterSigner.address]);
  const initCode = `${loadBytecode("CanonicalPaymaster")}${constructorArg.slice(2)}` as Hex;
  const { address: paymaster } = await deployContract(walletClient, publicClient, initCode, 1_000_000n, "CanonicalPaymaster");
  await fundAccount(walletClient, publicClient, paymaster, "10");
  const canonicalPaymaster: FramePaymaster = {
    address: paymaster,
    signFrameTransaction: async () => ({
      mode: "verify",
      flags: 1,
      target: paymaster,
      gasLimit: 50_000n,
      value: 0n,
      data: encodeFunctionData({ abi: canonicalPaymasterAbi, functionName: "validate", args: [1n] }),
    }),
    getTransactionSignaturePlaceholders: () => [
      makeEoaSignaturePlaceholder(paymasterSigner.address),
    ],
    signTransactionSignatures: async ({ sigHash }) => [
      await signEoaTransaction(paymasterSigner, sigHash),
    ],
  };
  const sponsoredHash = await publicClient.sendFrameTransaction({
    account: sender,
    paymaster: canonicalPaymaster,
    calls: [{ to: DEAD_ADDR }],
    senderGasLimit: 30_000n,
  });
  const sponsoredReceipt: any = await waitForReceipt(publicClient, sponsoredHash);
  if (sponsoredReceipt.payer?.toLowerCase() !== paymaster.toLowerCase()) {
    throw new Error(`canonical payer mismatch: ${sponsoredReceipt.payer}`);
  }
  console.log("PASS canonical paymaster sponsorship");

  await expectRejected(
    publicClient,
    "0x06e80180941111111111111111111111111111111111111111c0808080c0",
    "legacy eight-field wire rejection",
  );

  const { transaction: vector, sigHash } = loadFrameTransactionVector();
  if (computeSigHash(vector) !== sigHash) {
    throw new Error("geth/viem sig-hash vector mismatch");
  }
  console.log("PASS geth/viem shared sig-hash vector");
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
