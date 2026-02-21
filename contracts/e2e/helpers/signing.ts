import { hexToBytes, bytesToHex, type Hex } from "viem";
import { secp256k1 } from "@noble/curves/secp256k1";
import { computeSigHash, type FrameTxParams } from "./frame-tx.js";

/** Sign a hash with secp256k1, returning r, s, v and packed 65-byte signature. */
export function signFrameHash(sigHash: Hex, privKey: Hex) {
  const sig = secp256k1.sign(sigHash.slice(2), privKey.slice(2));
  const rHex = sig.r.toString(16).padStart(64, "0");
  const sHex = sig.s.toString(16).padStart(64, "0");
  const v = sig.recovery;
  const packed = hexToBytes(
    ("0x" + rHex + sHex + v.toString(16).padStart(2, "0")) as Hex
  );
  return { r: sig.r, s: sig.s, v, packed };
}

/** Compute sigHash for a FrameTx, sign it, return packed signature as Hex. */
export function signFrameTx(params: FrameTxParams, privKey: Hex): Hex {
  const sigHash = computeSigHash(params);
  const { packed } = signFrameHash(sigHash, privKey);
  return bytesToHex(packed);
}
