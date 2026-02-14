/**
 * E2E test: Deploy Kernel8141 + SpendingLimitHook, test daily spending limit enforcement.
 *
 * Flow:
 *   1. Deploy ECDSAValidator, Kernel8141, SpendingLimitHook
 *   2. Fund kernel with 10 ETH
 *   3. Install SpendingLimitHook (5 ETH daily limit) via frame tx
 *   4. Execute transfer of 3 ETH (should succeed)
 *   5. Execute transfer of 3 ETH (should fail - over limit)
 *
 * Usage:
 *   1. Start the dev node: bash devnet/run.sh
 *   2. Run this tool:      cd contracts && npx tsx script/send_hooked_tx.ts
 */

import {
  createPublicClient,
  createWalletClient,
  http,
  encodeAbiParameters,
  parseAbiParameters,
  getContractAddress,
  encodeFunctionData,
  type Hex,
  type Address,
  type Hash,
  keccak256,
  hexToBytes,
  bytesToHex,
  parseEther,
  formatEther,
  toFunctionSelector,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { readFileSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import { secp256k1 } from "@noble/curves/secp256k1";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// ── Config ────────────────────────────────────────────────────────────
const RPC_URL = "http://localhost:18545";
const CHAIN_ID = 1337;
const DEV_KEY =
  "0xb71c71a67e1177ad4e901695e1b4b9ee17ae16c6668d313eac2f96dbcda3f291" as const;
const DEAD_ADDR = "0x000000000000000000000000000000000000dEaD" as Address;

const FRAME_TX_TYPE = 0x06;
const FRAME_MODE_VERIFY = 0x01;
const FRAME_MODE_SENDER = 0x02;

const CHAIN_DEF = {
  id: CHAIN_ID,
  name: "devnet",
  nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
  rpcUrls: { default: { http: [RPC_URL] } },
};

// ModuleType enum (from Kernel8141)
const MODULE_TYPE_PRE_HOOK = 2;

// ── ABI fragments ─────────────────────────────────────────────────────

const kernelAbi = [
  {
    type: "function",
    name: "validate",
    inputs: [
      { name: "signature", type: "bytes" },
      { name: "scope", type: "uint8" },
    ],
    outputs: [],
    stateMutability: "view",
  },
  {
    type: "function",
    name: "execute",
    inputs: [
      { name: "target", type: "address" },
      { name: "value", type: "uint256" },
      { name: "data", type: "bytes" },
    ],
    outputs: [],
    stateMutability: "nonpayable",
  },
  {
    type: "function",
    name: "installModule",
    inputs: [
      { name: "moduleType", type: "uint8" },
      { name: "module", type: "address" },
      { name: "config", type: "bytes" },
    ],
    outputs: [],
    stateMutability: "nonpayable",
  },
] as const;

// ── Helpers (reused from send_kernel_tx.ts) ──────────────────────────

function loadBytecode(contractName: string): Hex {
  const artifactPath = join(
    __dirname, "..", "out", `${contractName}.sol`, `${contractName}.json`
  );
  const artifact = JSON.parse(readFileSync(artifactPath, "utf-8"));
  return artifact.bytecode.object as Hex;
}

async function waitForReceipt(
  publicClient: ReturnType<typeof createPublicClient>,
  hash: Hash,
  timeoutMs = 30_000
): Promise<any> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const receipt = await publicClient.request({
        method: "eth_getTransactionReceipt" as any,
        params: [hash],
      });
      if (receipt) return receipt;
    } catch {}
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error(`Timeout waiting for receipt of ${hash}`);
}

async function deployContract(
  walletClient: any,
  publicClient: any,
  bytecode: Hex,
  gas = 3_000_000n
): Promise<{ hash: Hash; address: Address }> {
  const devAddr = walletClient.account.address;
  const nonce = await publicClient.getTransactionCount({ address: devAddr });
  const expectedAddr = getContractAddress({ from: devAddr, nonce: BigInt(nonce) });

  const hash = await walletClient.sendTransaction({
    chain: CHAIN_DEF,
    data: bytecode,
    gas,
    maxFeePerGas: 10_000_000_000n,
    maxPriorityFeePerGas: 1_000_000_000n,
  });

  const receipt = await waitForReceipt(publicClient, hash);
  console.log(`  Deploy tx: ${hash}, expected address: ${expectedAddr}`);
  if (receipt.status !== "0x1") {
    console.log(`  Receipt:`, JSON.stringify(receipt, null, 2));
    throw new Error(`Deploy failed: status=${receipt.status}, tx=${hash}`);
  }
  console.log(`  ✓ Deployed successfully`);
  return { hash, address: expectedAddr };
}

// RLP helpers
function rlpEncodeLength(len: number, offset: number): Uint8Array {
  if (len < 56) return new Uint8Array([len + offset]);
  const hexLen = len.toString(16);
  const lenBytes = Math.ceil(hexLen.length / 2);
  const buf = new Uint8Array(1 + lenBytes);
  buf[0] = offset + 55 + lenBytes;
  let tmp = len;
  for (let i = lenBytes - 1; i >= 0; i--) { buf[1 + i] = tmp & 0xff; tmp >>= 8; }
  return buf;
}

function rlpEncodeBytes(data: Uint8Array): Uint8Array {
  if (data.length === 1 && data[0] < 0x80) return data;
  const prefix = rlpEncodeLength(data.length, 0x80);
  const r = new Uint8Array(prefix.length + data.length);
  r.set(prefix); r.set(data, prefix.length);
  return r;
}

function rlpEncodeList(items: Uint8Array[]): Uint8Array {
  let totalLen = 0;
  for (const item of items) totalLen += item.length;
  const prefix = rlpEncodeLength(totalLen, 0xc0);
  const r = new Uint8Array(prefix.length + totalLen);
  r.set(prefix);
  let off = prefix.length;
  for (const item of items) { r.set(item, off); off += item.length; }
  return r;
}

function toMinimalBytes(n: bigint): Uint8Array {
  if (n === 0n) return new Uint8Array(0);
  let hex = n.toString(16);
  if (hex.length % 2) hex = "0" + hex;
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < bytes.length; i++) bytes[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return bytes;
}

function addressToBytes(addr: Address): Uint8Array { return hexToBytes(addr as Hex); }

function encodeFrame(mode: number, target: Address | null, gasLimit: bigint, data: Uint8Array): Uint8Array {
  return rlpEncodeList([
    rlpEncodeBytes(toMinimalBytes(BigInt(mode))),
    target ? rlpEncodeBytes(addressToBytes(target)) : rlpEncodeBytes(new Uint8Array(0)),
    rlpEncodeBytes(toMinimalBytes(gasLimit)),
    rlpEncodeBytes(data),
  ]);
}

type FrameTxParams = {
  chainId: bigint; nonce: bigint; sender: Address;
  gasTipCap: bigint; gasFeeCap: bigint;
  frames: Array<{ mode: number; target: Address | null; gasLimit: bigint; data: Uint8Array }>;
  blobFeeCap: bigint; blobHashes: Hex[];
};

function computeSigHash(params: FrameTxParams): Hex {
  const framesForSig = params.frames.map((f) =>
    encodeFrame(f.mode, f.target, f.gasLimit, f.mode === FRAME_MODE_VERIFY ? new Uint8Array(0) : f.data)
  );
  const items: Uint8Array[] = [
    rlpEncodeBytes(toMinimalBytes(params.chainId)),
    rlpEncodeBytes(toMinimalBytes(params.nonce)),
    rlpEncodeBytes(addressToBytes(params.sender)),
    rlpEncodeList(framesForSig),
    rlpEncodeBytes(toMinimalBytes(params.gasTipCap)),
    rlpEncodeBytes(toMinimalBytes(params.gasFeeCap)),
    rlpEncodeBytes(toMinimalBytes(params.blobFeeCap)),
    rlpEncodeList(params.blobHashes.map((h) => rlpEncodeBytes(hexToBytes(h)))),
  ];
  const payload = rlpEncodeList(items);
  const toHash = new Uint8Array(1 + payload.length);
  toHash[0] = FRAME_TX_TYPE;
  toHash.set(payload, 1);
  return keccak256(toHash);
}

function encodeFrameTx(params: FrameTxParams): Hex {
  const items: Uint8Array[] = [
    rlpEncodeBytes(toMinimalBytes(params.chainId)),
    rlpEncodeBytes(toMinimalBytes(params.nonce)),
    rlpEncodeBytes(addressToBytes(params.sender)),
    rlpEncodeList(params.frames.map((f) => encodeFrame(f.mode, f.target, f.gasLimit, f.data))),
    rlpEncodeBytes(toMinimalBytes(params.gasTipCap)),
    rlpEncodeBytes(toMinimalBytes(params.gasFeeCap)),
    rlpEncodeBytes(toMinimalBytes(params.blobFeeCap)),
    rlpEncodeList(params.blobHashes.map((h) => rlpEncodeBytes(hexToBytes(h)))),
  ];
  const payload = rlpEncodeList(items);
  const raw = new Uint8Array(1 + payload.length);
  raw[0] = FRAME_TX_TYPE;
  raw.set(payload, 1);
  return bytesToHex(raw);
}

function signFrameTx(params: FrameTxParams, privKey: Hex): Hex {
  const sigHash = computeSigHash(params);
  const privKeyHex = privKey.slice(2);
  const sigHashHex = sigHash.slice(2);
  const sig = secp256k1.sign(sigHashHex, privKeyHex);

  // Pack signature: r(32) || s(32) || v(1) = 65 bytes
  const rHex = sig.r.toString(16).padStart(64, "0");
  const sHex = sig.s.toString(16).padStart(64, "0");
  const v = sig.recovery;
  return ("0x" + rHex + sHex + v.toString(16).padStart(2, "0")) as Hex;
}

async function sendFrameTx(
  publicClient: any,
  params: FrameTxParams,
  validateCalldata: Hex
): Promise<any> {
  params.frames[0].data = hexToBytes(validateCalldata);
  const rawTx = encodeFrameTx(params);
  const txHash = (await publicClient.request({
    method: "eth_sendRawTransaction" as any,
    params: [rawTx],
  })) as Hash;
  return waitForReceipt(publicClient, txHash);
}

function printReceipt(r: any) {
  console.log("\n--- Frame Transaction Receipt ---");
  console.log(`Status:   ${r.status}`);
  console.log(`Type:     ${r.type}`);
  console.log(`GasUsed:  ${BigInt(r.gasUsed)}`);
  if (r.payer) console.log(`Payer:    ${r.payer}`);
  if (r.frameReceipts) {
    const names: Record<string, string> = {
      "0x0": "Failed", "0x1": "Success", "0x2": "ApproveExecution",
      "0x3": "ApprovePayment", "0x4": "ApproveBoth",
    };
    for (let i = 0; i < r.frameReceipts.length; i++) {
      const fr = r.frameReceipts[i];
      console.log(`Frame ${i}:  status=${fr.status} (${names[fr.status] || "unknown"}), gasUsed=${BigInt(fr.gasUsed)}`);
    }
  }
}

// ── Main ──────────────────────────────────────────────────────────────

async function main() {
  const account = privateKeyToAccount(DEV_KEY);
  const devAddr = account.address;
  const ownerAddr = devAddr;

  const publicClient = createPublicClient({ transport: http(RPC_URL) });
  const walletClient = createWalletClient({ account, transport: http(RPC_URL) });

  const balance = await publicClient.getBalance({ address: devAddr });
  console.log(`Dev account ${devAddr} balance: ${formatEther(balance)} ETH\n`);

  // ── Step 1: Deploy Contracts ───────────────────────────────────────

  console.log("1. Deploying ECDSAValidator...");
  const validatorBytecode = loadBytecode("ECDSAValidator");
  const { address: validatorAddr } = await deployContract(walletClient, publicClient, validatorBytecode);

  console.log("\n2. Deploying Kernel8141...");
  const kernelBytecode = loadBytecode("Kernel8141");
  const constructorArgs = encodeAbiParameters(
    parseAbiParameters("address, bytes"),
    [validatorAddr, encodeAbiParameters(parseAbiParameters("address"), [ownerAddr])]
  );
  const kernelDeployData = (kernelBytecode + constructorArgs.slice(2)) as Hex;
  const { address: kernelAddr } = await deployContract(walletClient, publicClient, kernelDeployData, 6_000_000n);

  console.log("\n3. Deploying SpendingLimitHook...");
  const hookBytecode = loadBytecode("SpendingLimitHook");
  const { address: hookAddr } = await deployContract(walletClient, publicClient, hookBytecode);

  console.log("\n4. Funding Kernel with 10 ETH...");
  const fundHash = await walletClient.sendTransaction({
    chain: CHAIN_DEF,
    to: kernelAddr,
    value: parseEther("10"),
    gas: 50_000n,
    maxFeePerGas: 10_000_000_000n,
    maxPriorityFeePerGas: 1_000_000_000n,
  });
  await waitForReceipt(publicClient, fundHash);
  console.log(`  Funded (tx: ${fundHash})`);

  // ── Step 2: Install SpendingLimitHook ──────────────────────────────

  console.log("\n5. Installing SpendingLimitHook (5 ETH daily limit)...");

  // Get execute selector
  const executeSelector = toFunctionSelector("execute(address,uint256,bytes)");

  // Prepare installModule config: abi.encode(bytes4[] selectors, bytes hookData)
  // hookData = abi.encode(uint256 dailyLimit)
  const dailyLimit = parseEther("5"); // 5 ETH daily limit
  const hookData = encodeAbiParameters(parseAbiParameters("uint256"), [dailyLimit]);
  const moduleConfig = encodeAbiParameters(
    parseAbiParameters("bytes4[], bytes"),
    [[executeSelector], hookData]
  );

  // Build installModule calldata
  const installCalldata = encodeFunctionData({
    abi: kernelAbi,
    functionName: "installModule",
    args: [MODULE_TYPE_PRE_HOOK, hookAddr, moduleConfig],
  });

  // Frame tx: VERIFY + SENDER(installModule)
  let kernelNonce = await publicClient.getTransactionCount({ address: kernelAddr });
  let block = await publicClient.getBlock();
  let gasFeeCap = block.baseFeePerGas! + 2_000_000_000n;

  let frameTxParams: FrameTxParams = {
    chainId: BigInt(CHAIN_ID),
    nonce: BigInt(kernelNonce),
    sender: kernelAddr,
    gasTipCap: 1_000_000_000n,
    gasFeeCap,
    frames: [
      { mode: FRAME_MODE_VERIFY, target: null, gasLimit: 200_000n, data: new Uint8Array(0) },
      { mode: FRAME_MODE_SENDER, target: null, gasLimit: 300_000n, data: hexToBytes(installCalldata) },
    ],
    blobFeeCap: 0n,
    blobHashes: [],
  };

  const installSig = signFrameTx(frameTxParams, DEV_KEY);
  const installValidateCalldata = encodeFunctionData({
    abi: kernelAbi,
    functionName: "validate",
    args: [installSig, 2], // scope=2 (both)
  });

  const installReceipt = await sendFrameTx(publicClient, frameTxParams, installValidateCalldata);
  printReceipt(installReceipt);
  if (installReceipt.status !== "0x1") {
    throw new Error("Hook installation failed");
  }
  console.log("  ✓ SpendingLimitHook installed successfully");

  // ── Step 3: Execute transfer under limit (3 ETH) ───────────────────

  console.log("\n6. Executing transfer of 3 ETH (under 5 ETH limit)...");

  const executeCalldata1 = encodeFunctionData({
    abi: kernelAbi,
    functionName: "execute",
    args: [DEAD_ADDR, parseEther("3"), "0x"],
  });

  kernelNonce = await publicClient.getTransactionCount({ address: kernelAddr });
  block = await publicClient.getBlock();
  gasFeeCap = block.baseFeePerGas! + 2_000_000_000n;

  frameTxParams = {
    chainId: BigInt(CHAIN_ID),
    nonce: BigInt(kernelNonce),
    sender: kernelAddr,
    gasTipCap: 1_000_000_000n,
    gasFeeCap,
    frames: [
      { mode: FRAME_MODE_VERIFY, target: null, gasLimit: 200_000n, data: new Uint8Array(0) },
      { mode: FRAME_MODE_SENDER, target: null, gasLimit: 100_000n, data: hexToBytes(executeCalldata1) },
    ],
    blobFeeCap: 0n,
    blobHashes: [],
  };

  const sig1 = signFrameTx(frameTxParams, DEV_KEY);
  const validateCalldata1 = encodeFunctionData({
    abi: kernelAbi,
    functionName: "validate",
    args: [sig1, 2],
  });

  const receipt1 = await sendFrameTx(publicClient, frameTxParams, validateCalldata1);
  printReceipt(receipt1);
  if (receipt1.status !== "0x1") {
    throw new Error("First transfer should succeed but failed");
  }
  console.log("  ✓ Transfer of 3 ETH succeeded (spent: 3/5 ETH)");

  // ── Step 4: Execute transfer over limit (3 ETH) → should fail ─────

  console.log("\n7. Executing transfer of 3 ETH (over limit - should fail)...");

  const executeCalldata2 = encodeFunctionData({
    abi: kernelAbi,
    functionName: "execute",
    args: [DEAD_ADDR, parseEther("3"), "0x"],
  });

  kernelNonce = await publicClient.getTransactionCount({ address: kernelAddr });
  block = await publicClient.getBlock();
  gasFeeCap = block.baseFeePerGas! + 2_000_000_000n;

  frameTxParams = {
    chainId: BigInt(CHAIN_ID),
    nonce: BigInt(kernelNonce),
    sender: kernelAddr,
    gasTipCap: 1_000_000_000n,
    gasFeeCap,
    frames: [
      { mode: FRAME_MODE_VERIFY, target: null, gasLimit: 200_000n, data: new Uint8Array(0) },
      { mode: FRAME_MODE_SENDER, target: null, gasLimit: 100_000n, data: hexToBytes(executeCalldata2) },
    ],
    blobFeeCap: 0n,
    blobHashes: [],
  };

  const sig2 = signFrameTx(frameTxParams, DEV_KEY);
  const validateCalldata2 = encodeFunctionData({
    abi: kernelAbi,
    functionName: "validate",
    args: [sig2, 2],
  });

  const receipt2 = await sendFrameTx(publicClient, frameTxParams, validateCalldata2);
  printReceipt(receipt2);

  // Verify that frame 1 (SENDER) failed due to spending limit
  // Note: Overall tx status is 0x1 (success) in EIP-8141 even if individual frames fail
  if (!receipt2.frameReceipts || receipt2.frameReceipts.length < 2) {
    throw new Error("Missing frame receipts");
  }
  if (receipt2.frameReceipts[1].status !== "0x0") {
    throw new Error(`Frame 1 should fail (0x0) but got ${receipt2.frameReceipts[1].status} - hook not enforced!`);
  }

  console.log("  ✓ Transfer correctly rejected by SpendingLimitHook (6 ETH > 5 ETH limit)");

  console.log("\n=== SPENDING LIMIT HOOK E2E TEST PASSED ===");
}

main().catch((err) => {
  console.error("FATAL:", err.message || err);
  process.exit(1);
});
