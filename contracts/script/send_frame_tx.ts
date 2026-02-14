/**
 * Standalone tool to send an EIP-8141 frame transaction to a geth dev node.
 *
 * Usage:
 *   1. Start the dev node: bash devnet/run.sh
 *   2. Run this tool:      cd contracts && npx tsx script/send_frame_tx.ts
 */

import {
  createPublicClient,
  createWalletClient,
  http,
  encodeAbiParameters,
  parseAbiParameters,
  getContractAddress,
  type Hex,
  type Address,
  type Hash,
  keccak256,
  encodePacked,
  hexToBytes,
  bytesToHex,
  concat,
  pad,
  toHex,
  numberToHex,
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

// Well-known geth --dev account private key
const DEV_KEY =
  "0xb71c71a67e1177ad4e901695e1b4b9ee17ae16c6668d313eac2f96dbcda3f291" as const;

const DEAD_ADDR = "0x000000000000000000000000000000000000dEaD" as Address;

// EIP-8141 FrameTx type
const FRAME_TX_TYPE = 0x06;

// Frame modes (from core/types/tx_frame.go)
const FRAME_MODE_VERIFY = 0x01;
const FRAME_MODE_SENDER = 0x02;

// ── Helpers ───────────────────────────────────────────────────────────

function loadBytecode(contractName: string): Hex {
  const artifactPath = join(
    __dirname,
    "..",
    "out",
    `${contractName}.sol`,
    `${contractName}.json`
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

// RLP encoding helpers
function rlpEncodeLength(len: number, offset: number): Uint8Array {
  if (len < 56) {
    return new Uint8Array([len + offset]);
  }
  const hexLen = len.toString(16);
  const lenOfLen = hexLen.length / 2 + (hexLen.length % 2 ? 0.5 : 0);
  const lenBytes = Math.ceil(lenOfLen);
  const buf = new Uint8Array(1 + lenBytes);
  buf[0] = offset + 55 + lenBytes;
  for (let i = lenBytes - 1; i >= 0; i--) {
    buf[1 + i] = len & 0xff;
    len = len >> 8;
  }
  return buf;
}

function rlpEncodeBytes(data: Uint8Array): Uint8Array {
  if (data.length === 1 && data[0] < 0x80) {
    return data;
  }
  const prefix = rlpEncodeLength(data.length, 0x80);
  const result = new Uint8Array(prefix.length + data.length);
  result.set(prefix);
  result.set(data, prefix.length);
  return result;
}

function rlpEncodeList(items: Uint8Array[]): Uint8Array {
  let totalLen = 0;
  for (const item of items) totalLen += item.length;
  const prefix = rlpEncodeLength(totalLen, 0xc0);
  const result = new Uint8Array(prefix.length + totalLen);
  result.set(prefix);
  let offset = prefix.length;
  for (const item of items) {
    result.set(item, offset);
    offset += item.length;
  }
  return result;
}

function toMinimalBytes(n: bigint): Uint8Array {
  if (n === 0n) return new Uint8Array(0);
  let hex = n.toString(16);
  if (hex.length % 2) hex = "0" + hex;
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < bytes.length; i++) {
    bytes[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  }
  return bytes;
}

function addressToBytes(addr: Address): Uint8Array {
  return hexToBytes(addr as Hex);
}

function encodeFrame(
  mode: number,
  target: Address | null,
  gasLimit: bigint,
  data: Uint8Array
): Uint8Array {
  const items: Uint8Array[] = [
    rlpEncodeBytes(toMinimalBytes(BigInt(mode))),
    target
      ? rlpEncodeBytes(addressToBytes(target))
      : rlpEncodeBytes(new Uint8Array(0)),
    rlpEncodeBytes(toMinimalBytes(gasLimit)),
    rlpEncodeBytes(data),
  ];
  return rlpEncodeList(items);
}

// Compute sigHash for a FrameTx (EIP-8141):
// keccak256(FRAME_TX_TYPE || rlp([chainId, nonce, sender, gasTipCap, gasFeeCap, frames_for_sig, blobFeeCap, blobHashes]))
// In frames_for_sig, VERIFY frame data is replaced with empty bytes.
function computeSigHash(params: {
  chainId: bigint;
  nonce: bigint;
  sender: Address;
  gasTipCap: bigint;
  gasFeeCap: bigint;
  frames: Array<{
    mode: number;
    target: Address | null;
    gasLimit: bigint;
    data: Uint8Array;
  }>;
  blobFeeCap: bigint;
  blobHashes: Hex[];
}): Hex {
  // For sigHash, VERIFY frames have data replaced with empty
  const framesForSig = params.frames.map((f) => {
    const data = f.mode === FRAME_MODE_VERIFY ? new Uint8Array(0) : f.data;
    return encodeFrame(f.mode, f.target, f.gasLimit, data);
  });

  const blobHashItems = params.blobHashes.map((h) =>
    rlpEncodeBytes(hexToBytes(h))
  );

  // Field order per Go struct: chainId, nonce, sender, frames, gasTipCap, gasFeeCap, blobFeeCap, blobHashes
  const items: Uint8Array[] = [
    rlpEncodeBytes(toMinimalBytes(params.chainId)),
    rlpEncodeBytes(toMinimalBytes(params.nonce)),
    rlpEncodeBytes(addressToBytes(params.sender)),
    rlpEncodeList(framesForSig), // frames list
    rlpEncodeBytes(toMinimalBytes(params.gasTipCap)),
    rlpEncodeBytes(toMinimalBytes(params.gasFeeCap)),
    rlpEncodeBytes(toMinimalBytes(params.blobFeeCap)),
    rlpEncodeList(blobHashItems), // blob hashes list
  ];

  const payload = rlpEncodeList(items);
  // Prepend tx type byte
  const toHash = new Uint8Array(1 + payload.length);
  toHash[0] = FRAME_TX_TYPE;
  toHash.set(payload, 1);

  return keccak256(toHash);
}

// RLP encode the full FrameTx for sending
function encodeFrameTx(params: {
  chainId: bigint;
  nonce: bigint;
  sender: Address;
  gasTipCap: bigint;
  gasFeeCap: bigint;
  frames: Array<{
    mode: number;
    target: Address | null;
    gasLimit: bigint;
    data: Uint8Array;
  }>;
  blobFeeCap: bigint;
  blobHashes: Hex[];
}): Hex {
  const frameItems = params.frames.map((f) =>
    encodeFrame(f.mode, f.target, f.gasLimit, f.data)
  );

  const blobHashItems = params.blobHashes.map((h) =>
    rlpEncodeBytes(hexToBytes(h))
  );

  // Field order per Go struct: chainId, nonce, sender, frames, gasTipCap, gasFeeCap, blobFeeCap, blobHashes
  const items: Uint8Array[] = [
    rlpEncodeBytes(toMinimalBytes(params.chainId)),
    rlpEncodeBytes(toMinimalBytes(params.nonce)),
    rlpEncodeBytes(addressToBytes(params.sender)),
    rlpEncodeList(frameItems),
    rlpEncodeBytes(toMinimalBytes(params.gasTipCap)),
    rlpEncodeBytes(toMinimalBytes(params.gasFeeCap)),
    rlpEncodeBytes(toMinimalBytes(params.blobFeeCap)),
    rlpEncodeList(blobHashItems),
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

  const publicClient = createPublicClient({
    transport: http(RPC_URL),
  });
  const walletClient = createWalletClient({
    account,
    transport: http(RPC_URL),
  });

  // 1. Verify connection
  const balance = await publicClient.getBalance({ address: devAddr });
  console.log(`Dev account ${devAddr} balance: ${formatEther(balance)} ETH`);

  // 2. Deploy Simple8141Account(ownerAddr)
  // ownerAddr = devAddr for simplicity
  const ownerAddr = devAddr;
  const initCode = loadBytecode("Simple8141Account");
  const constructorArg = encodeAbiParameters(parseAbiParameters("address"), [
    ownerAddr,
  ]);
  const deployData = (initCode + constructorArg.slice(2)) as Hex;

  const deployNonce = await publicClient.getTransactionCount({
    address: devAddr,
  });
  const simple8141AccountAddr = getContractAddress({
    from: devAddr,
    nonce: BigInt(deployNonce),
  });
  console.log(`Expected Simple8141Account address: ${simple8141AccountAddr}`);

  const deployHash = await walletClient.sendTransaction({
    chain: { id: CHAIN_ID, name: "devnet", nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 }, rpcUrls: { default: { http: [RPC_URL] } } },
    data: deployData,
    gas: 2_000_000n,
    maxFeePerGas: 10_000_000_000n,
    maxPriorityFeePerGas: 1_000_000_000n,
  });
  console.log(`Deploy tx: ${deployHash}`);

  const deployReceipt = await waitForReceipt(publicClient, deployHash);
  console.log(
    `Deploy receipt: status=${deployReceipt.status}, contract=${deployReceipt.contractAddress}`
  );
  if (deployReceipt.status !== "0x1") {
    throw new Error(`Deploy failed: status=${deployReceipt.status}`);
  }

  // 3. Fund Simple8141Account with 10 ETH
  const fundHash = await walletClient.sendTransaction({
    chain: { id: CHAIN_ID, name: "devnet", nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 }, rpcUrls: { default: { http: [RPC_URL] } } },
    to: simple8141AccountAddr,
    value: parseEther("10"),
    gas: 50_000n,
    maxFeePerGas: 10_000_000_000n,
    maxPriorityFeePerGas: 1_000_000_000n,
  });
  const fundReceipt = await waitForReceipt(publicClient, fundHash);
  console.log(`Fund receipt: status=${fundReceipt.status}`);

  // 4. Build FrameTx
  const accountNonce = await publicClient.getTransactionCount({
    address: simple8141AccountAddr,
  });
  console.log(`Simple8141Account nonce: ${accountNonce}`);

  const block = await publicClient.getBlock();
  const baseFee = block.baseFeePerGas!;
  const gasFeeCap = baseFee + 2_000_000_000n;
  console.log(`BaseFee: ${baseFee}, GasFeeCap: ${gasFeeCap}`);

  const verifyGas = 200_000n;
  const senderGas = 50_000n;

  const frameTxParams = {
    chainId: BigInt(CHAIN_ID),
    nonce: BigInt(accountNonce),
    sender: simple8141AccountAddr,
    gasTipCap: 1_000_000_000n,
    gasFeeCap,
    frames: [
      {
        mode: FRAME_MODE_VERIFY,
        target: null as Address | null,
        gasLimit: verifyGas,
        data: new Uint8Array(0), // placeholder, will be filled after signing
      },
      {
        mode: FRAME_MODE_SENDER,
        target: DEAD_ADDR as Address | null,
        gasLimit: senderGas,
        data: new Uint8Array(0),
      },
    ],
    blobFeeCap: 0n,
    blobHashes: [] as Hex[],
  };

  // 5. Compute sigHash and sign
  const sigHash = computeSigHash(frameTxParams);
  console.log(`SigHash: ${sigHash}`);

  // Sign with secp256k1 (owner key = dev key)
  const privKeyHex = DEV_KEY.slice(2);
  const sigHashHex = sigHash.slice(2);
  const sig = secp256k1.sign(sigHashHex, privKeyHex);
  const r = sig.r;
  const s = sig.s;
  const v = sig.recovery + 27;

  // ABI-encode validate(uint8 v, bytes32 r, bytes32 s, uint8 scope)
  // Selector: 0xf2d64fed
  const validateSelector = hexToBytes("0xf2d64fed" as Hex);
  const calldata = new Uint8Array(4 + 32 * 4); // 132 bytes
  calldata.set(validateSelector, 0);
  calldata[35] = v; // uint8 v in last byte of word 1

  // r as 32 bytes
  const rHex = r.toString(16).padStart(64, "0");
  const rBytes = hexToBytes(("0x" + rHex) as Hex);
  calldata.set(rBytes, 36);

  // s as 32 bytes
  const sHex = s.toString(16).padStart(64, "0");
  const sBytes = hexToBytes(("0x" + sHex) as Hex);
  calldata.set(sBytes, 68);

  calldata[131] = 2; // scope=2 (both)

  // Set VERIFY frame data
  frameTxParams.frames[0].data = calldata;

  // 6. Encode and send raw FrameTx
  const rawTx = encodeFrameTx(frameTxParams);
  console.log(`FrameTx raw length: ${rawTx.length / 2 - 1} bytes`);

  const txHash = (await publicClient.request({
    method: "eth_sendRawTransaction" as any,
    params: [rawTx],
  })) as Hash;
  console.log(`FrameTx hash: ${txHash}`);
  console.log("FrameTx sent");

  // 7. Wait for receipt and verify
  const frameReceipt = await waitForReceipt(publicClient, txHash);
  printReceipt(frameReceipt);

  verifyReceipt(frameReceipt, simple8141AccountAddr);
  console.log("\n=== E2E TEST PASSED ===");
}

function printReceipt(r: any) {
  console.log("\n--- Frame Transaction Receipt ---");
  console.log(`Status:   ${r.status}`);
  console.log(`Type:     ${r.type}`);
  console.log(`GasUsed:  ${BigInt(r.gasUsed)}`);
  if (r.payer) console.log(`Payer:    ${r.payer}`);
  if (r.frameReceipts) {
    for (let i = 0; i < r.frameReceipts.length; i++) {
      const fr = r.frameReceipts[i];
      const statusNames: Record<string, string> = {
        "0x0": "Failed",
        "0x1": "Success",
        "0x2": "ApproveExecution",
        "0x3": "ApprovePayment",
        "0x4": "ApproveBoth",
      };
      const statusName = statusNames[fr.status] || "unknown";
      console.log(
        `Frame ${i}:  status=${fr.status} (${statusName}), gasUsed=${BigInt(fr.gasUsed)}`
      );
    }
  }
}

function verifyReceipt(receipt: any, simple8141AccountAddr: Address) {
  if (receipt.status !== "0x1") {
    throw new Error(
      `status: got ${receipt.status}, want 0x1 (successful)`
    );
  }
  if (receipt.type !== "0x6") {
    throw new Error(
      `type: got ${receipt.type}, want 0x6 (FrameTx)`
    );
  }
  if (
    receipt.payer &&
    receipt.payer.toLowerCase() !== simple8141AccountAddr.toLowerCase()
  ) {
    throw new Error(
      `payer: got ${receipt.payer}, want ${simple8141AccountAddr}`
    );
  }
  if (receipt.frameReceipts) {
    if (receipt.frameReceipts.length !== 2) {
      throw new Error(
        `frame receipts count: got ${receipt.frameReceipts.length}, want 2`
      );
    }
    // Frame 0 (VERIFY): ApproveBoth = 0x4
    if (receipt.frameReceipts[0].status !== "0x4") {
      throw new Error(
        `frame 0 status: got ${receipt.frameReceipts[0].status}, want 0x4 (ApproveBoth)`
      );
    }
    // Frame 1 (SENDER): Success = 0x1
    if (receipt.frameReceipts[1].status !== "0x1") {
      throw new Error(
        `frame 1 status: got ${receipt.frameReceipts[1].status}, want 0x1 (success)`
      );
    }
  }
  if (BigInt(receipt.gasUsed) === 0n) {
    throw new Error("gas used should be > 0");
  }
}

main().catch((err) => {
  console.error("FATAL:", err.message || err);
  process.exit(1);
});
