/**
 * E2E test: Deploy Kernel8141 + ECDSAValidator, send a frame transaction.
 *
 * Usage:
 *   1. Start the dev node: bash devnet/run.sh
 *   2. Run this tool:      cd contracts && npx tsx script/send_kernel_tx.ts
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
] as const;

// ── Helpers (reused from send_frame_tx.ts) ────────────────────────────

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
  if (receipt.status !== "0x1") {
    throw new Error(`Deploy failed: status=${receipt.status}`);
  }
  console.log(`  Deployed at ${expectedAddr} (tx: ${hash})`);
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

// ── Main ──────────────────────────────────────────────────────────────

async function main() {
  const account = privateKeyToAccount(DEV_KEY);
  const devAddr = account.address;
  const ownerAddr = devAddr;

  const publicClient = createPublicClient({ transport: http(RPC_URL) });
  const walletClient = createWalletClient({ account, transport: http(RPC_URL) });

  const balance = await publicClient.getBalance({ address: devAddr });
  console.log(`Dev account ${devAddr} balance: ${formatEther(balance)} ETH\n`);

  // 1. Deploy ECDSAValidator
  console.log("1. Deploying ECDSAValidator...");
  const validatorBytecode = loadBytecode("ECDSAValidator");
  const { address: validatorAddr } = await deployContract(walletClient, publicClient, validatorBytecode);

  // 2. Deploy Kernel8141(ecdsaValidator, abi.encode(ownerAddr))
  console.log("\n2. Deploying Kernel8141...");
  const kernelBytecode = loadBytecode("Kernel8141");
  // Constructor args: (IValidator8141 _rootValidator, bytes memory _validatorData)
  const constructorArgs = encodeAbiParameters(
    parseAbiParameters("address, bytes"),
    [validatorAddr, encodeAbiParameters(parseAbiParameters("address"), [ownerAddr])]
  );
  const kernelDeployData = (kernelBytecode + constructorArgs.slice(2)) as Hex;
  const { address: kernelAddr } = await deployContract(walletClient, publicClient, kernelDeployData, 6_000_000n);

  // 3. Fund Kernel with 10 ETH
  console.log("\n3. Funding Kernel with 10 ETH...");
  const fundHash = await walletClient.sendTransaction({
    chain: CHAIN_DEF,
    to: kernelAddr,
    value: parseEther("10"),
    gas: 50_000n,
    maxFeePerGas: 10_000_000_000n,
    maxPriorityFeePerGas: 1_000_000_000n,
  });
  const fundReceipt = await waitForReceipt(publicClient, fundHash);
  console.log(`  Fund receipt: status=${fundReceipt.status}`);

  // 4. Build FrameTx
  console.log("\n4. Building FrameTx...");
  const kernelNonce = await publicClient.getTransactionCount({ address: kernelAddr });
  const block = await publicClient.getBlock();
  const baseFee = block.baseFeePerGas!;
  const gasFeeCap = baseFee + 2_000_000_000n;
  console.log(`  Kernel nonce: ${kernelNonce}, BaseFee: ${baseFee}, GasFeeCap: ${gasFeeCap}`);

  // SENDER frame: kernel.execute(DEAD_ADDR, 0, "")
  const executeCalldata = encodeFunctionData({
    abi: kernelAbi,
    functionName: "execute",
    args: [DEAD_ADDR, 0n, "0x"],
  });

  const frameTxParams: FrameTxParams = {
    chainId: BigInt(CHAIN_ID),
    nonce: BigInt(kernelNonce),
    sender: kernelAddr,
    gasTipCap: 1_000_000_000n,
    gasFeeCap,
    frames: [
      { mode: FRAME_MODE_VERIFY, target: null, gasLimit: 200_000n, data: new Uint8Array(0) },
      { mode: FRAME_MODE_SENDER, target: null, gasLimit: 100_000n, data: hexToBytes(executeCalldata) },
    ],
    blobFeeCap: 0n,
    blobHashes: [],
  };

  // 5. Sign
  console.log("\n5. Computing sigHash and signing...");
  const sigHash = computeSigHash(frameTxParams);
  console.log(`  SigHash: ${sigHash}`);

  const privKeyHex = DEV_KEY.slice(2);
  const sigHashHex = sigHash.slice(2);
  const sig = secp256k1.sign(sigHashHex, privKeyHex);

  // Pack signature: r(32) || s(32) || v(1) = 65 bytes
  const rHex = sig.r.toString(16).padStart(64, "0");
  const sHex = sig.s.toString(16).padStart(64, "0");
  const v = sig.recovery; // 0 or 1, validator normalizes
  const packedSig = hexToBytes(("0x" + rHex + sHex + v.toString(16).padStart(2, "0")) as Hex);

  // ABI-encode kernel.validate(bytes signature, uint8 scope)
  const validateCalldata = encodeFunctionData({
    abi: kernelAbi,
    functionName: "validate",
    args: [bytesToHex(packedSig), 2], // scope=2 (both)
  });

  // Set VERIFY frame data
  frameTxParams.frames[0].data = hexToBytes(validateCalldata);

  // 6. Send
  console.log("\n6. Sending FrameTx...");
  const rawTx = encodeFrameTx(frameTxParams);
  const txHash = (await publicClient.request({
    method: "eth_sendRawTransaction" as any,
    params: [rawTx],
  })) as Hash;
  console.log(`  FrameTx hash: ${txHash}`);

  // 7. Verify
  const frameReceipt = await waitForReceipt(publicClient, txHash);
  printReceipt(frameReceipt);
  verifyReceipt(frameReceipt, kernelAddr);
  console.log("\n=== KERNEL8141 E2E TEST PASSED ===");
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

function verifyReceipt(receipt: any, kernelAddr: Address) {
  if (receipt.status !== "0x1") throw new Error(`status: got ${receipt.status}, want 0x1`);
  if (receipt.type !== "0x6") throw new Error(`type: got ${receipt.type}, want 0x6`);
  if (receipt.payer && receipt.payer.toLowerCase() !== kernelAddr.toLowerCase()) {
    throw new Error(`payer: got ${receipt.payer}, want ${kernelAddr}`);
  }
  if (receipt.frameReceipts) {
    if (receipt.frameReceipts.length !== 2) throw new Error(`frame count: got ${receipt.frameReceipts.length}, want 2`);
    if (receipt.frameReceipts[0].status !== "0x4") throw new Error(`frame 0: got ${receipt.frameReceipts[0].status}, want 0x4`);
    if (receipt.frameReceipts[1].status !== "0x1") throw new Error(`frame 1: got ${receipt.frameReceipts[1].status}, want 0x1`);
  }
  if (BigInt(receipt.gasUsed) === 0n) throw new Error("gas used should be > 0");
}

main().catch((err) => {
  console.error("FATAL:", err.message || err);
  process.exit(1);
});
