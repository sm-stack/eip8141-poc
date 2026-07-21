import {
  encodeAbiParameters,
  encodeFunctionData,
  keccak256,
  parseAbiParameters,
  parseEther,
  toHex,
  type Address,
  type Hex,
} from "viem";
import {
  computeSourceId,
  getFrameTransactionGas,
  serializeFrameTransaction,
  type Frame,
  type TransactionSerializableFrame,
} from "viem/eip8141";
import { createTestClients, waitForReceipt } from "../helpers/client.js";
import { deployContract, loadBytecode } from "../helpers/deploy.js";

const denomination = parseEther("1");
const maxGasCharge = parseEther("0.01");
const verifyGasLimit = 400_000n;
const executeGasLimit = 200_000n;
const rootSalt = keccak256(toHex("privacy-pool-8141.root.v1"));
const nullifierDomain = keccak256(toHex("privacy-pool-8141.nullifier.v1"));
const withdrawalStatementTypeHash = keccak256(
  toHex(
    "WithdrawalStatement(uint256 chainId,address pool,bytes32 root,uint64 rootSlot,bytes32 nullifierHash,address recipient,uint64 nonceSeq,uint256 maxGasCharge)",
  ),
);

const poolAbi = [
  {
    type: "function",
    name: "deposit",
    inputs: [{ name: "commitment", type: "bytes32" }],
    outputs: [
      { name: "leafIndex", type: "uint64" },
      { name: "root", type: "bytes32" },
    ],
    stateMutability: "payable",
  },
  {
    type: "function",
    name: "currentRoot",
    inputs: [],
    outputs: [{ type: "bytes32" }],
    stateMutability: "view",
  },
  {
    type: "function",
    name: "nullifierSpent",
    inputs: [{ name: "nullifierHash", type: "bytes32" }],
    outputs: [{ type: "bool" }],
    stateMutability: "view",
  },
  {
    type: "function",
    name: "validateWithdrawal",
    inputs: [
      { name: "proof", type: "bytes" },
      {
        name: "intent",
        type: "tuple",
        components: [
          { name: "root", type: "bytes32" },
          { name: "rootSlot", type: "uint64" },
          { name: "nullifierHash", type: "bytes32" },
          { name: "recipient", type: "address" },
          { name: "nonceSeq", type: "uint64" },
          { name: "maxGasCharge", type: "uint256" },
          { name: "gasCharge", type: "uint256" },
          { name: "verifyGasLimit", type: "uint256" },
          { name: "maxPriorityFeePerGas", type: "uint256" },
          { name: "maxFeePerGas", type: "uint256" },
        ],
      },
    ],
    outputs: [],
    stateMutability: "view",
  },
  {
    type: "function",
    name: "executeWithdrawal",
    inputs: [
      { name: "nullifierHash", type: "bytes32" },
      { name: "recipient", type: "address" },
      { name: "amount", type: "uint256" },
    ],
    outputs: [],
    stateMutability: "nonpayable",
  },
] as const;

type Intent = {
  root: Hex;
  rootSlot: bigint;
  nullifierHash: Hex;
  recipient: Address;
  nonceSeq: bigint;
  maxGasCharge: bigint;
  gasCharge: bigint;
  verifyGasLimit: bigint;
  maxPriorityFeePerGas: bigint;
  maxFeePerGas: bigint;
};

function nonceKey(nullifierHash: Hex): bigint {
  const encoded = encodeAbiParameters(parseAbiParameters("bytes32, bytes32"), [
    nullifierDomain,
    nullifierHash,
  ]);
  const key = BigInt(keccak256(encoded));
  return key === 0n ? 1n : key;
}

function withdrawalStatementHash(pool: Address, intent: Intent): Hex {
  return keccak256(
    encodeAbiParameters(
      parseAbiParameters(
        "bytes32, uint256, address, bytes32, uint64, bytes32, address, uint64, uint256",
      ),
      [
        withdrawalStatementTypeHash,
        1337n,
        pool,
        intent.root,
        intent.rootSlot,
        intent.nullifierHash,
        intent.recipient,
        intent.nonceSeq,
        intent.maxGasCharge,
      ],
    ),
  );
}

function proofForIntent(pool: Address, intent: Intent): Hex {
  return encodeAbiParameters(parseAbiParameters("bytes32, bytes32, bytes32"), [
    intent.root,
    intent.nullifierHash,
    withdrawalStatementHash(pool, intent),
  ]);
}

function frames(
  pool: Address,
  proof: Hex,
  intent: Intent,
  executionGasLimit = executeGasLimit,
): Frame[] {
  return [
    {
      mode: "verify",
      flags: 3,
      target: null,
      gasLimit: verifyGasLimit,
      value: 0n,
      data: encodeFunctionData({
        abi: poolAbi,
        functionName: "validateWithdrawal",
        args: [proof, intent],
      }),
    },
    {
      mode: "sender",
      flags: 0,
      target: null,
      gasLimit: executionGasLimit,
      value: 0n,
      data: encodeFunctionData({
        abi: poolAbi,
        functionName: "executeWithdrawal",
        args: [intent.nullifierHash, intent.recipient, denomination - intent.gasCharge],
      }),
    },
  ];
}

function buildTransaction(
  pool: Address,
  sourceId: Hex,
  proof: Hex,
  intent: Intent,
  executionGasLimit = executeGasLimit,
): TransactionSerializableFrame {
  return {
    type: "frame",
    chainId: 1337,
    nonceKeys: [nonceKey(intent.nullifierHash)],
    nonceSeq: 0n,
    sender: pool,
    frames: frames(pool, proof, intent, executionGasLimit),
    signatures: [],
    recentRootReferences: [{ sourceId, slot: intent.rootSlot, root: intent.root }],
    maxPriorityFeePerGas: intent.maxPriorityFeePerGas,
    maxFeePerGas: intent.maxFeePerGas,
  };
}

async function main() {
  const { publicClient, walletClient } = createTestClients();

  const verifier = await deployContract(
    walletClient,
    publicClient,
    loadBytecode("ProofBoundPrivacyPoolVerifier"),
    300_000n,
    "ProofBoundPrivacyPoolVerifier",
  );
  const constructorArgs = encodeAbiParameters(parseAbiParameters("address, uint256, uint8"), [
    verifier.address,
    denomination,
    20,
  ]);
  const deployedPool = await deployContract(
    walletClient,
    publicClient,
    `${loadBytecode("PrivacyPool8141")}${constructorArgs.slice(2)}` as Hex,
    3_000_000n,
    "PrivacyPool8141",
  );

  const commitment = keccak256(toHex("privacy-pool-note-1"));
  const depositHash = await (walletClient as any).writeContract({
    address: deployedPool.address,
    abi: poolAbi,
    functionName: "deposit",
    args: [commitment],
    value: denomination,
  });
  const depositReceipt = await waitForReceipt(publicClient, depositHash);
  if (depositReceipt.status !== "0x1") throw new Error("deposit failed");
  const depositBlock = await publicClient.getBlock({ blockNumber: BigInt(depositReceipt.blockNumber) });
  const rootSlot = depositBlock.timestamp / 12n;
  const root = (await (publicClient as any).readContract({
    address: deployedPool.address,
    abi: poolAbi,
    functionName: "currentRoot",
  })) as Hex;
  const sourceId = computeSourceId(deployedPool.address, rootSalt);
  await (publicClient as any).request({ method: "dev_advanceTime", params: [toHex(12n)] });

  const secondCommitment = keccak256(toHex("privacy-pool-note-2"));
  const secondDepositHash = await (walletClient as any).writeContract({
    address: deployedPool.address,
    abi: poolAbi,
    functionName: "deposit",
    args: [secondCommitment],
    value: denomination,
  });
  const secondDepositReceipt = await waitForReceipt(publicClient, secondDepositHash);
  if (secondDepositReceipt.status !== "0x1") throw new Error("second deposit failed");
  const secondDepositBlock = await publicClient.getBlock({
    blockNumber: BigInt(secondDepositReceipt.blockNumber),
  });
  const secondRootSlot = secondDepositBlock.timestamp / 12n;
  const secondRoot = (await (publicClient as any).readContract({
    address: deployedPool.address,
    abi: poolAbi,
    functionName: "currentRoot",
  })) as Hex;
  await (publicClient as any).request({ method: "dev_advanceTime", params: [toHex(12n)] });

  const recipient = "0x000000000000000000000000000000000000bEEF" as Address;
  const nullifierHash = keccak256(toHex("privacy-pool-nullifier-1"));
  const fees = await publicClient.estimateFeesPerGas();
  let intent: Intent = {
    root,
    rootSlot,
    nullifierHash,
    recipient,
    nonceSeq: 0n,
    maxGasCharge,
    gasCharge: 0n,
    verifyGasLimit,
    maxPriorityFeePerGas: fees.maxPriorityFeePerGas,
    maxFeePerGas: fees.maxFeePerGas,
  };
  const proof = proofForIntent(deployedPool.address, intent);
  intent = await settleGasCharge(deployedPool.address, sourceId, proof, intent, executeGasLimit);

  const transaction = buildTransaction(deployedPool.address, sourceId, proof, intent);
  const executionDataSize = (transaction.frames[1].data.length - 2) / 2;
  if (executionDataSize !== 100) {
    throw new Error(`execution calldata is ${executionDataSize} bytes, want 100`);
  }

  const invalidProof = "0x5678" as Hex;
  const invalidProofIntent = await settleGasCharge(
    deployedPool.address,
    sourceId,
    invalidProof,
    { ...intent, gasCharge: 0n },
    executeGasLimit,
  );
  await expectFrameTransactionRejected(
    publicClient,
    buildTransaction(deployedPool.address, sourceId, invalidProof, invalidProofIntent),
    "invalid privacy proof",
  );
  console.log("PASS rejected invalid privacy proof");

  for (const mutation of [
    { label: "recipient mutation", intent: { ...intent, recipient: "0x000000000000000000000000000000000000b0b0" as Address } },
    {
      label: "root mutation",
      intent: { ...intent, root: secondRoot, rootSlot: secondRootSlot },
    },
    {
      label: "nullifier mutation",
      intent: { ...intent, nullifierHash: keccak256(toHex("privacy-pool-nullifier-2")) },
    },
    {
      label: "max gas charge mutation",
      intent: { ...intent, maxGasCharge: intent.maxGasCharge + 1n },
    },
  ]) {
    const mutatedIntent = await settleGasCharge(
      deployedPool.address,
      sourceId,
      proof,
      { ...mutation.intent, gasCharge: 0n },
      executeGasLimit,
    );
    await expectFrameTransactionRejected(
      publicClient,
      buildTransaction(deployedPool.address, sourceId, proof, mutatedIntent),
      mutation.label,
    );
  }
  console.log("PASS proof binds recipient, root, nullifier, and max gas charge");

  const underfunded = buildTransaction(
    deployedPool.address,
    sourceId,
    proof,
    await settleGasCharge(
      deployedPool.address,
      sourceId,
      proof,
      { ...intent, gasCharge: 0n },
      executeGasLimit - 1n,
    ),
    executeGasLimit - 1n,
  );
  await expectFrameTransactionRejected(publicClient, underfunded, "underfunded execution frame");
  console.log("PASS rejected execution frame below fixed 200000 gas limit");

  const recipientBefore = await publicClient.getBalance({ address: recipient });
  const raw = serializeFrameTransaction(transaction);
  const hash = (await publicClient.request({
    method: "eth_sendRawTransaction",
    params: [raw],
  })) as Hex;
  const receipt = await waitForReceipt(publicClient, hash);
  if (receipt.status !== "0x1") throw new Error(`withdrawal failed: ${hash}`);
  if (receipt.payer?.toLowerCase() !== deployedPool.address.toLowerCase()) {
    throw new Error(`pool was not recorded as payer: ${receipt.payer}`);
  }

  const recipientAfter = await publicClient.getBalance({ address: recipient });
  if (recipientAfter - recipientBefore !== denomination - intent.gasCharge) {
    throw new Error(
      `recipient amount mismatch: got ${recipientAfter - recipientBefore}, want ${denomination - intent.gasCharge}`,
    );
  }
  const spent = await (publicClient as any).readContract({
    address: deployedPool.address,
    abi: poolAbi,
    functionName: "nullifierSpent",
    args: [nullifierHash],
  });
  if (!spent) throw new Error("nullifier was not marked spent");

  console.log(`PASS relayerless withdrawal: ${hash}`);
  console.log("PASS execution calldata is 100 bytes");
  console.log(`PASS pool paid gas and recipient received ${denomination - intent.gasCharge} wei`);
}

async function settleGasCharge(
  pool: Address,
  sourceId: Hex,
  proof: Hex,
  initialIntent: Intent,
  executionGasLimit: bigint,
): Promise<Intent> {
  let intent = initialIntent;
  for (let i = 0; i < 8; i++) {
    const transaction = buildTransaction(pool, sourceId, proof, intent, executionGasLimit);
    const gasCharge = getFrameTransactionGas(transaction) * intent.maxFeePerGas;
    if (gasCharge === intent.gasCharge) return intent;
    intent = { ...intent, gasCharge };
  }
  throw new Error("gasCharge did not converge");
}

async function expectFrameTransactionRejected(
  publicClient: any,
  transaction: TransactionSerializableFrame,
  label: string,
): Promise<void> {
  try {
    await publicClient.request({
      method: "eth_sendRawTransaction",
      params: [serializeFrameTransaction(transaction)],
    });
  } catch {
    return;
  }
  throw new Error(`${label} was accepted`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
