/**
 * E2E: EOA P256 default-code rejection
 *
 * Protocol-level P256 signatures remain valid for smart accounts, but the
 * EIP-8141 default code recognizes only SECP256K1. An empty-code P256-derived
 * sender must therefore be rejected during validation-prefix simulation.
 *
 * Usage: cd contracts && npx tsx e2e/eoa/eoa-p256.ts
 */

import { formatEther, keccak256, concatHex, type Hex, type Address } from "viem";
import {
  computeSigHash,
  serializeFrameTransaction,
  type TransactionSerializableFrame,
} from "viem/eip8141";
import { p256 } from "@noble/curves/p256";
import { DEAD_ADDR } from "../helpers/config.js";
import { createTestClients, fundAccount } from "../helpers/client.js";
import {
  banner, sectionHeader, info, step, success,
  testHeader, testPassed, summary, fatal,
} from "../helpers/log.js";

// ── P256 key helpers ─────────────────────────────────────────────────

function generateP256Key() {
  const privKey = p256.utils.randomPrivateKey();
  const pubKey = p256.getPublicKey(privKey, false); // uncompressed: 0x04 + x(32) + y(32)

  const x = (`0x${Buffer.from(pubKey.slice(1, 33)).toString("hex")}`) as Hex;
  const y = (`0x${Buffer.from(pubKey.slice(33, 65)).toString("hex")}`) as Hex;

  // EOA address for P256: keccak256(x || y)[12:]
  const address = (`0x${keccak256(concatHex([x, y])).slice(26)}`) as Address;

  return {
    privKey: (`0x${Buffer.from(privKey).toString("hex")}`) as Hex,
    publicKey: { x, y },
    address,
  };
}

async function p256Sign(hash: Hex, privKey: Hex): Promise<{ r: Hex; s: Hex }> {
  const sig = p256.sign(hash.slice(2), privKey.slice(2));
  return {
    r: (`0x${sig.r.toString(16).padStart(64, "0")}`) as Hex,
    s: (`0x${sig.s.toString(16).padStart(64, "0")}`) as Hex,
  };
}

// ── Main ─────────────────────────────────────────────────────────────

async function main() {
  const { publicClient, walletClient, devAddr } = createTestClients();

  const balance = await publicClient.getBalance({ address: devAddr });
  banner("EOA P256 Default-Code Rejection");
  info(`Dev account: ${devAddr}`);
  info(`Balance: ${formatEther(balance)} ETH`);

  // ── 1. Generate P256 key pair ──
  sectionHeader("Generate P256 Key Pair");
  const { privKey, publicKey, address: p256Addr } = generateP256Key();
  step(`P256 EOA address: ${p256Addr}`);
  info(`Public key X: ${publicKey.x.slice(0, 18)}...`);
  info(`Public key Y: ${publicKey.y.slice(0, 18)}...`);

  // ── 2. Fund the P256 EOA ──
  sectionHeader("Fund P256 EOA");
  await fundAccount(walletClient, publicClient, p256Addr);

  // ── 3. Submit an otherwise-valid P256 frame transaction ──
  testHeader(1, "P256 Empty-Code Sender Rejection");
  const fees = await publicClient.estimateFeesPerGas();
  const placeholder = {
    scheme: 2 as const,
    signer: p256Addr,
    msg: "0x" as Hex,
    signature: `0x${"00".repeat(128)}` as Hex,
  };
  const unsigned: TransactionSerializableFrame = {
    chainId: 1337,
    nonce: 0,
    sender: p256Addr,
    frames: [
      { mode: "verify", flags: 3, target: null, gasLimit: 90_000n, value: 0n, data: "0x" },
      { mode: "sender", flags: 0, target: DEAD_ADDR, gasLimit: 30_000n, value: 1n, data: "0x" },
    ],
    signatures: [placeholder],
    recentRootReferences: [],
    maxPriorityFeePerGas: fees.maxPriorityFeePerGas,
    maxFeePerGas: fees.maxFeePerGas,
    type: "frame",
  };
  const { r, s } = await p256Sign(computeSigHash(unsigned), privKey);
  const signed = {
    ...unsigned,
    signatures: [{ ...placeholder, signature: concatHex([r, s, publicKey.x, publicKey.y]) }],
  };

  step("Submitting P256 signature against the SECP256K1-only default code...");
  try {
    await publicClient.request({
      method: "eth_sendRawTransaction",
      params: [serializeFrameTransaction(signed)],
    });
  } catch {
    success("P256 empty-code sender rejected");
    testPassed("EOA P256 default-code rejection");
    summary("EOA P256 Default-Code Rejection", 1);
    return;
  }
  throw new Error("P256 empty-code sender was unexpectedly accepted");
}

main().catch((err) => {
  fatal(err);
  process.exit(1);
});
