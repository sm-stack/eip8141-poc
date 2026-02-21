/**
 * E2E: CoinbaseSmartWallet8141 ERC-1271 signature validation
 *
 * Tests:
 * 1. replaySafeHash returns non-zero and is deterministic
 * 2. isValidSignature accepts valid ECDSA signature
 * 3. isValidSignature rejects invalid signature
 *
 * Usage: cd contracts && npx tsx e2e/coinbase/coinbase-erc1271.ts
 */

import {
  encodeAbiParameters,
  parseAbiParameters,
  keccak256,
  toBytes,
  hexToBytes,
  bytesToHex,
  type Hex,
} from "viem";
import { secp256k1 } from "@noble/curves/secp256k1";
import { DEV_KEY } from "../helpers/config.js";
import { walletAbi } from "../helpers/abis/coinbase.js";
import { testHeader, testPassed, summary, fatal } from "../helpers/log.js";
import { deployCoinbaseTestbed } from "./setup.js";

async function main() {
  const ctx = await deployCoinbaseTestbed();

  testHeader(1, "replaySafeHash is deterministic and non-zero");
  {
    const hash = keccak256(toBytes("test message"));
    const safeHash1 = await ctx.publicClient.readContract({
      address: ctx.walletAddr,
      abi: walletAbi,
      functionName: "replaySafeHash",
      args: [hash],
    }) as Hex;

    if (safeHash1 === "0x0000000000000000000000000000000000000000000000000000000000000000") {
      throw new Error("replaySafeHash returned zero");
    }

    // Same input → same output
    const safeHash2 = await ctx.publicClient.readContract({
      address: ctx.walletAddr,
      abi: walletAbi,
      functionName: "replaySafeHash",
      args: [hash],
    }) as Hex;

    if (safeHash1 !== safeHash2) {
      throw new Error(`replaySafeHash not deterministic: ${safeHash1} !== ${safeHash2}`);
    }

    // Different input → different output
    const safeHash3 = await ctx.publicClient.readContract({
      address: ctx.walletAddr,
      abi: walletAbi,
      functionName: "replaySafeHash",
      args: [keccak256(toBytes("other"))],
    }) as Hex;

    if (safeHash1 === safeHash3) {
      throw new Error("Different hashes produced same replaySafeHash");
    }

    testPassed("replaySafeHash is deterministic and non-zero");
  }

  testHeader(2, "isValidSignature accepts valid ECDSA signature");
  {
    const hash = keccak256(toBytes("hello ERC-1271"));

    // Get the replay-safe hash that the wallet will verify against
    const safeHash = await ctx.publicClient.readContract({
      address: ctx.walletAddr,
      abi: walletAbi,
      functionName: "replaySafeHash",
      args: [hash],
    }) as Hex;

    // Sign the replay-safe hash with owner 1's key (index 0)
    const sig = secp256k1.sign(safeHash.slice(2), DEV_KEY.slice(2));
    const rHex = sig.r.toString(16).padStart(64, "0");
    const sHex = sig.s.toString(16).padStart(64, "0");
    const v = sig.recovery;
    const ecdsaSig = ("0x" + rHex + sHex + v.toString(16).padStart(2, "0")) as Hex;

    // Encode as SignatureWrapper(ownerIndex=0, signatureData=ecdsaSig)
    const signatureWrapper = encodeAbiParameters(
      parseAbiParameters("uint256, bytes"),
      [0n, ecdsaSig]
    );

    const result = await ctx.publicClient.readContract({
      address: ctx.walletAddr,
      abi: walletAbi,
      functionName: "isValidSignature",
      args: [hash, signatureWrapper],
    }) as Hex;

    const ERC1271_MAGICVALUE = "0x1626ba7e";
    if (result !== ERC1271_MAGICVALUE) {
      throw new Error(`Expected magic value ${ERC1271_MAGICVALUE}, got ${result}`);
    }

    testPassed("isValidSignature accepted valid ECDSA signature");
  }

  testHeader(3, "isValidSignature rejects invalid signature");
  {
    const hash = keccak256(toBytes("should fail"));

    // Sign a DIFFERENT hash (not the replay-safe hash)
    const wrongHash = keccak256(toBytes("wrong message"));
    const sig = secp256k1.sign(wrongHash.slice(2), DEV_KEY.slice(2));
    const rHex = sig.r.toString(16).padStart(64, "0");
    const sHex = sig.s.toString(16).padStart(64, "0");
    const v = sig.recovery;
    const ecdsaSig = ("0x" + rHex + sHex + v.toString(16).padStart(2, "0")) as Hex;

    const signatureWrapper = encodeAbiParameters(
      parseAbiParameters("uint256, bytes"),
      [0n, ecdsaSig]
    );

    const result = await ctx.publicClient.readContract({
      address: ctx.walletAddr,
      abi: walletAbi,
      functionName: "isValidSignature",
      args: [hash, signatureWrapper],
    }) as Hex;

    const ERC1271_INVALID = "0xffffffff";
    if (result !== ERC1271_INVALID) {
      throw new Error(`Expected invalid ${ERC1271_INVALID}, got ${result}`);
    }

    testPassed("isValidSignature rejected invalid signature");
  }

  summary("Coinbase ERC-1271", 3);
}

main().catch((err) => {
  fatal(err);
  process.exit(1);
});
