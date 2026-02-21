import { hexToBytes, bytesToHex, keccak256, type Address, type Hex } from "viem";
import { rlpEncodeBytes, rlpEncodeList, toMinimalBytes, addressToBytes } from "./rlp.js";
import { FRAME_TX_TYPE, FRAME_MODE_VERIFY } from "./config.js";

export type FrameTxParams = {
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
};

export function encodeFrame(
  mode: number,
  target: Address | null,
  gasLimit: bigint,
  data: Uint8Array
): Uint8Array {
  return rlpEncodeList([
    rlpEncodeBytes(toMinimalBytes(BigInt(mode))),
    target
      ? rlpEncodeBytes(addressToBytes(target))
      : rlpEncodeBytes(new Uint8Array(0)),
    rlpEncodeBytes(toMinimalBytes(gasLimit)),
    rlpEncodeBytes(data),
  ]);
}

/**
 * Compute sigHash for a FrameTx (EIP-8141).
 * VERIFY frame data is replaced with empty bytes per spec.
 */
export function computeSigHash(params: FrameTxParams): Hex {
  const framesForSig = params.frames.map((f) =>
    encodeFrame(
      f.mode,
      f.target,
      f.gasLimit,
      f.mode === FRAME_MODE_VERIFY ? new Uint8Array(0) : f.data
    )
  );
  const items: Uint8Array[] = [
    rlpEncodeBytes(toMinimalBytes(params.chainId)),
    rlpEncodeBytes(toMinimalBytes(params.nonce)),
    rlpEncodeBytes(addressToBytes(params.sender)),
    rlpEncodeList(framesForSig),
    rlpEncodeBytes(toMinimalBytes(params.gasTipCap)),
    rlpEncodeBytes(toMinimalBytes(params.gasFeeCap)),
    rlpEncodeBytes(toMinimalBytes(params.blobFeeCap)),
    rlpEncodeList(
      params.blobHashes.map((h) => rlpEncodeBytes(hexToBytes(h)))
    ),
  ];
  const payload = rlpEncodeList(items);
  const toHash = new Uint8Array(1 + payload.length);
  toHash[0] = FRAME_TX_TYPE;
  toHash.set(payload, 1);
  return keccak256(toHash);
}

/** RLP-encode a full FrameTx for eth_sendRawTransaction. */
export function encodeFrameTx(params: FrameTxParams): Hex {
  const items: Uint8Array[] = [
    rlpEncodeBytes(toMinimalBytes(params.chainId)),
    rlpEncodeBytes(toMinimalBytes(params.nonce)),
    rlpEncodeBytes(addressToBytes(params.sender)),
    rlpEncodeList(
      params.frames.map((f) =>
        encodeFrame(f.mode, f.target, f.gasLimit, f.data)
      )
    ),
    rlpEncodeBytes(toMinimalBytes(params.gasTipCap)),
    rlpEncodeBytes(toMinimalBytes(params.gasFeeCap)),
    rlpEncodeBytes(toMinimalBytes(params.blobFeeCap)),
    rlpEncodeList(
      params.blobHashes.map((h) => rlpEncodeBytes(hexToBytes(h)))
    ),
  ];
  const payload = rlpEncodeList(items);
  const raw = new Uint8Array(1 + payload.length);
  raw[0] = FRAME_TX_TYPE;
  raw.set(payload, 1);
  return bytesToHex(raw);
}
