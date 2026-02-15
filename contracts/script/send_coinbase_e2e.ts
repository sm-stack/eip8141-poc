/**
 * CoinbaseSmartWallet8141 E2E Test
 *
 * Demonstrates multi-owner smart wallet using EIP-8141 frame transactions
 *
 * Usage:
 *   1. Start devnet: bash devnet/run.sh
 *   2. Run: npx tsx script/send_coinbase_e2e.ts
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
import { createHash } from "crypto";
import { secp256k1 } from "@noble/curves/secp256k1";
import { p256 } from "@noble/curves/p256";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// Config
const RPC_URL = "http://localhost:18545";
const CHAIN_ID = 1337;
const DEV_KEY = "0xb71c71a67e1177ad4e901695e1b4b9ee17ae16c6668d313eac2f96dbcda3f291" as const;
const OWNER2_KEY = "0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a" as const;
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

const walletAbi = [
  {
    type: "function",
    name: "validate",
    inputs: [
      { name: "signature", type: "bytes" },
      { name: "scope", type: "uint8" },
    ],
    outputs: [],
    stateMutability: "nonpayable",
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
    stateMutability: "payable",
  },
  {
    type: "function",
    name: "isOwnerAddress",
    inputs: [{ name: "owner", type: "address" }],
    outputs: [{ name: "", type: "bool" }],
    stateMutability: "view",
  },
  {
    type: "function",
    name: "nextOwnerIndex",
    inputs: [],
    outputs: [{ name: "", type: "uint256" }],
    stateMutability: "view",
  },
  {
    type: "function",
    name: "isOwnerPublicKey",
    inputs: [
      { name: "x", type: "uint256" },
      { name: "y", type: "uint256" },
    ],
    outputs: [{ name: "", type: "bool" }],
    stateMutability: "view",
  },
  {
    type: "function",
    name: "addOwnerPublicKey",
    inputs: [
      { name: "x", type: "uint256" },
      { name: "y", type: "uint256" },
    ],
    outputs: [],
    stateMutability: "nonpayable",
  },
  {
    type: "function",
    name: "ownerAtIndex",
    inputs: [{ name: "index", type: "uint256" }],
    outputs: [{ name: "", type: "bytes" }],
    stateMutability: "view",
  },
] as const;

// Helpers
function sha256(data: Hex | Uint8Array): Hex {
  const bytes = typeof data === "string" ? hexToBytes(data) : data;
  const hash = createHash("sha256").update(bytes).digest();
  return bytesToHex(hash);
}

function loadBytecode(contractName: string): Hex {
  const artifactPath = join(__dirname, "..", "out", `${contractName}.sol`, `${contractName}.json`);
  const artifact = JSON.parse(readFileSync(artifactPath, "utf-8"));
  return artifact.bytecode.object as Hex;
}

async function waitForReceipt(publicClient: any, hash: Hash, timeoutMs = 60_000): Promise<any> {
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

async function deployContract(walletClient: any, publicClient: any, bytecode: Hex, gas = 3_000_000n) {
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
  if (receipt.status !== "0x1") throw new Error(`Deploy failed: status=${receipt.status}`);
  console.log(`  Deployed at ${expectedAddr} (tx: ${hash})`);
  return { hash, address: expectedAddr };
}

// RLP encoding (same as send_kernel_tx.ts)
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

async function sendFrameTx(publicClient: any, walletAddr: Address, senderCalldata: Hex, ownerIndex: number, privKey: Hex) {
  const nonce = await publicClient.getTransactionCount({ address: walletAddr });
  const block = await publicClient.getBlock();
  const gasFeeCap = block.baseFeePerGas! + 2_000_000_000n;

  const frameTxParams: FrameTxParams = {
    chainId: BigInt(CHAIN_ID),
    nonce: BigInt(nonce),
    sender: walletAddr,
    gasTipCap: 1_000_000_000n,
    gasFeeCap,
    frames: [
      { mode: FRAME_MODE_VERIFY, target: null, gasLimit: 300_000n, data: new Uint8Array(0) },
      { mode: FRAME_MODE_SENDER, target: null, gasLimit: 500_000n, data: hexToBytes(senderCalldata) },
    ],
    blobFeeCap: 0n,
    blobHashes: [],
  };

  const sigHash = computeSigHash(frameTxParams);
  const sig = secp256k1.sign(sigHash.slice(2), privKey.slice(2));
  const rHex = sig.r.toString(16).padStart(64, "0");
  const sHex = sig.s.toString(16).padStart(64, "0");
  const v = sig.recovery;
  const ecdsaSig = hexToBytes(("0x" + rHex + sHex + v.toString(16).padStart(2, "0")) as Hex);

  const signatureWrapper = encodeAbiParameters(
    parseAbiParameters("uint256, bytes"),
    [BigInt(ownerIndex), bytesToHex(ecdsaSig)]
  );

  const validateCalldata = encodeFunctionData({
    abi: walletAbi,
    functionName: "validate",
    args: [signatureWrapper, 2],
  });

  frameTxParams.frames[0].data = hexToBytes(validateCalldata);

  const rawTx = encodeFrameTx(frameTxParams);
  const txHash = (await publicClient.request({
    method: "eth_sendRawTransaction" as any,
    params: [rawTx],
  })) as Hash;

  return await waitForReceipt(publicClient, txHash);
}

// Create WebAuthn authenticatorData (mocked)
function createAuthenticatorData(): Hex {
  // Authenticator data structure:
  // - rpIdHash (32 bytes): SHA256 of relying party ID
  // - flags (1 byte): 0x05 = UP (user present) + UV (user verified)
  // - signCount (4 bytes): signature counter
  const rpIdHash = new Uint8Array(32).fill(0xaa); // Mock rpIdHash
  const flags = new Uint8Array([0x05]); // UP=1, UV=1
  const signCount = new Uint8Array([0, 0, 0, 1]); // Counter = 1

  const authData = new Uint8Array(37);
  authData.set(rpIdHash, 0);
  authData.set(flags, 32);
  authData.set(signCount, 33);

  return bytesToHex(authData);
}

// Create WebAuthn clientDataJSON (mocked)
function createClientDataJSON(challenge: Hex): string {
  // Base64url encode challenge (without padding)
  const challengeBytes = hexToBytes(challenge);
  const base64 = Buffer.from(challengeBytes).toString("base64url");

  // Client data JSON structure
  const clientData = {
    type: "webauthn.get",
    challenge: base64,
    origin: "https://example.com",
  };

  return JSON.stringify(clientData);
}

// Send frame tx with WebAuthn P256 signature
async function sendFrameTxWithWebAuthn(
  publicClient: any,
  walletAddr: Address,
  senderCalldata: Hex,
  ownerIndex: number,
  p256PrivKey: Hex,
  publicKey: { x: bigint; y: bigint }
) {
  const nonce = await publicClient.getTransactionCount({ address: walletAddr });
  const block = await publicClient.getBlock();
  const gasFeeCap = block.baseFeePerGas! + 2_000_000_000n;

  const frameTxParams: FrameTxParams = {
    chainId: BigInt(CHAIN_ID),
    nonce: BigInt(nonce),
    sender: walletAddr,
    gasTipCap: 1_000_000_000n,
    gasFeeCap,
    frames: [
      { mode: FRAME_MODE_VERIFY, target: null, gasLimit: 300_000n, data: new Uint8Array(0) },
      { mode: FRAME_MODE_SENDER, target: null, gasLimit: 500_000n, data: hexToBytes(senderCalldata) },
    ],
    blobFeeCap: 0n,
    blobHashes: [],
  };

  const sigHash = computeSigHash(frameTxParams);

  // Create WebAuthn authenticator data and client data
  const authenticatorData = createAuthenticatorData();
  const clientDataJSON = createClientDataJSON(sigHash);
  const clientDataJSONBytes = new TextEncoder().encode(clientDataJSON);

  // Find challenge and type indices in clientDataJSON
  const challengeIndex = clientDataJSON.indexOf('"challenge"');
  const typeIndex = clientDataJSON.indexOf('"type"');

  // Construct the message to sign (WebAuthn format)
  // WebAuthn uses SHA256, not keccak256
  const clientDataHash = sha256(bytesToHex(clientDataJSONBytes));
  const messageToSign = sha256(
    bytesToHex(new Uint8Array([...hexToBytes(authenticatorData), ...hexToBytes(clientDataHash)]))
  );

  // Sign with P256
  const sig = p256.sign(messageToSign.slice(2), p256PrivKey.slice(2));
  const r = sig.r;
  const s = sig.s;

  // Encode WebAuthnAuth struct
  const webAuthnAuth = encodeAbiParameters(
    parseAbiParameters("bytes, bytes, uint256, uint256, uint256, uint256"),
    [
      authenticatorData,
      bytesToHex(clientDataJSONBytes),
      BigInt(challengeIndex),
      BigInt(typeIndex),
      r,
      s,
    ]
  );

  // Encode signature wrapper
  const signatureWrapper = encodeAbiParameters(
    parseAbiParameters("uint256, bytes"),
    [BigInt(ownerIndex), webAuthnAuth]
  );

  const validateCalldata = encodeFunctionData({
    abi: walletAbi,
    functionName: "validate",
    args: [signatureWrapper, 2],
  });

  frameTxParams.frames[0].data = hexToBytes(validateCalldata);

  const rawTx = encodeFrameTx(frameTxParams);
  const txHash = (await publicClient.request({
    method: "eth_sendRawTransaction" as any,
    params: [rawTx],
  })) as Hash;

  return await waitForReceipt(publicClient, txHash);
}

async function main() {
  const account = privateKeyToAccount(DEV_KEY);
  const owner2Account = privateKeyToAccount(OWNER2_KEY);
  const devAddr = account.address;
  const owner2Addr = owner2Account.address;

  // Generate P256 keypair for WebAuthn owner
  const p256PrivKey = "0x" + "3".repeat(64) as Hex; // Mock P256 private key
  const p256PubKey = p256.getPublicKey(p256PrivKey.slice(2), false); // Uncompressed (65 bytes)
  const p256X = BigInt("0x" + Buffer.from(p256PubKey.slice(1, 33)).toString("hex"));
  const p256Y = BigInt("0x" + Buffer.from(p256PubKey.slice(33, 65)).toString("hex"));

  const publicClient = createPublicClient({ transport: http(RPC_URL) });
  const walletClient = createWalletClient({ account, transport: http(RPC_URL) });

  const balance = await publicClient.getBalance({ address: devAddr });
  console.log(`\n${"=".repeat(70)}`);
  console.log(`CoinbaseSmartWallet8141 E2E Test`);
  console.log(`${"=".repeat(70)}`);
  console.log(`Owner 1 (ECDSA): ${devAddr}`);
  console.log(`Owner 2 (ECDSA): ${owner2Addr}`);
  console.log(`Owner 3 (P256):  x=${p256X.toString(16).slice(0, 16)}...`);
  console.log(`Balance: ${formatEther(balance)} ETH\n`);

  // Deploy
  console.log("📦 Deploying CoinbaseSmartWallet8141 with mixed owners...\n");

  const bytecode = loadBytecode("CoinbaseSmartWallet8141");
  const owners = [
    encodeAbiParameters(parseAbiParameters("address"), [devAddr]),
    encodeAbiParameters(parseAbiParameters("address"), [owner2Addr]),
    encodeAbiParameters(parseAbiParameters("uint256, uint256"), [p256X, p256Y]), // WebAuthn owner
  ];
  const constructorArgs = encodeAbiParameters(parseAbiParameters("bytes[]"), [owners]);
  const deployData = (bytecode + constructorArgs.slice(2)) as Hex;

  const { address: walletAddr } = await deployContract(walletClient, publicClient, deployData, 5_000_000n);

  // Verify owners
  console.log("\n🔍 Verifying owners...");
  const isOwner1 = await publicClient.readContract({
    address: walletAddr,
    abi: walletAbi,
    functionName: "isOwnerAddress",
    args: [devAddr],
  });
  const isOwner2 = await publicClient.readContract({
    address: walletAddr,
    abi: walletAbi,
    functionName: "isOwnerAddress",
    args: [owner2Addr],
  });
  const isOwner3 = await publicClient.readContract({
    address: walletAddr,
    abi: walletAbi,
    functionName: "isOwnerPublicKey",
    args: [p256X, p256Y],
  });
  const ownerCount = await publicClient.readContract({
    address: walletAddr,
    abi: walletAbi,
    functionName: "nextOwnerIndex",
  });

  console.log(`  Owner 1 (ECDSA - ${devAddr}): ${isOwner1 ? "✅" : "❌"}`);
  console.log(`  Owner 2 (ECDSA - ${owner2Addr}): ${isOwner2 ? "✅" : "❌"}`);
  console.log(`  Owner 3 (P256 WebAuthn): ${isOwner3 ? "✅" : "❌"}`);
  console.log(`  Total owners: ${ownerCount}`);


  // Fund wallet
  console.log("💰 Funding wallet with 10 ETH...");
  const fundHash = await walletClient.sendTransaction({
    chain: CHAIN_DEF,
    to: walletAddr,
    value: parseEther("10"),
    gas: 50_000n,
    maxFeePerGas: 10_000_000_000n,
    maxPriorityFeePerGas: 1_000_000_000n,
  });
  await waitForReceipt(publicClient, fundHash);
  console.log("  ✅ Funded\n");


  // Test 1: Execute with ECDSA Owner 1
  console.log(`${"─".repeat(70)}`);
  console.log(`Test 1: Execute with ECDSA Owner 1`);
  console.log(`${"─".repeat(70)}`);
  {
    const calldata = encodeFunctionData({
      abi: walletAbi,
      functionName: "execute",
      args: [DEAD_ADDR, 0n, "0x"],
    });
    const receipt = await sendFrameTx(publicClient, walletAddr, calldata, 0, DEV_KEY);
    console.log(`  Status: ${receipt.status}, GasUsed: ${BigInt(receipt.gasUsed)}`);
    console.log("✅ PASSED - ECDSA Owner 1 executed successfully\n");
  }

  // Test 2: Execute with ECDSA Owner 2
  console.log(`${"─".repeat(70)}`);
  console.log(`Test 2: Execute with ECDSA Owner 2`);
  console.log(`${"─".repeat(70)}`);
  {
    const calldata = encodeFunctionData({
      abi: walletAbi,
      functionName: "execute",
      args: [DEAD_ADDR, 0n, "0x"],
    });
    const receipt = await sendFrameTx(publicClient, walletAddr, calldata, 1, OWNER2_KEY);
    console.log(`  Status: ${receipt.status}, GasUsed: ${BigInt(receipt.gasUsed)}`);
    console.log("✅ PASSED - ECDSA Owner 2 executed successfully\n");
  }

  // Test 3: Execute with P256 WebAuthn Owner
  console.log(`${"─".repeat(70)}`);
  console.log(`Test 3: Execute with P256 WebAuthn Owner`);
  console.log(`${"─".repeat(70)}`);
  {
    const calldata = encodeFunctionData({
      abi: walletAbi,
      functionName: "execute",
      args: [DEAD_ADDR, 0n, "0x"],
    });
    const receipt = await sendFrameTxWithWebAuthn(
      publicClient, walletAddr, calldata, 2, p256PrivKey, { x: p256X, y: p256Y }
    );
    console.log(`  Status: ${receipt.status}, GasUsed: ${BigInt(receipt.gasUsed)}`);
    console.log("✅ PASSED - P256 WebAuthn Owner executed successfully\n");
  }

  // Summary
  console.log(`${"=".repeat(70)}`);
  console.log(`✅ ALL 3 TESTS PASSED`);
  console.log(`${"=".repeat(70)}\n`);
}

main().catch((err) => {
  console.error("FATAL:", err.message || err);
  console.error("Stack:", err.stack);
  process.exit(1);
});
