import { hexToBytes, type Address, type Hex } from "viem";

export function rlpEncodeLength(len: number, offset: number): Uint8Array {
  if (len < 56) return new Uint8Array([len + offset]);
  const hexLen = len.toString(16);
  const lenBytes = Math.ceil(hexLen.length / 2);
  const buf = new Uint8Array(1 + lenBytes);
  buf[0] = offset + 55 + lenBytes;
  let tmp = len;
  for (let i = lenBytes - 1; i >= 0; i--) {
    buf[1 + i] = tmp & 0xff;
    tmp >>= 8;
  }
  return buf;
}

export function rlpEncodeBytes(data: Uint8Array): Uint8Array {
  if (data.length === 1 && data[0] < 0x80) return data;
  const prefix = rlpEncodeLength(data.length, 0x80);
  const r = new Uint8Array(prefix.length + data.length);
  r.set(prefix);
  r.set(data, prefix.length);
  return r;
}

export function rlpEncodeList(items: Uint8Array[]): Uint8Array {
  let totalLen = 0;
  for (const item of items) totalLen += item.length;
  const prefix = rlpEncodeLength(totalLen, 0xc0);
  const r = new Uint8Array(prefix.length + totalLen);
  r.set(prefix);
  let off = prefix.length;
  for (const item of items) {
    r.set(item, off);
    off += item.length;
  }
  return r;
}

export function toMinimalBytes(n: bigint): Uint8Array {
  if (n === 0n) return new Uint8Array(0);
  let hex = n.toString(16);
  if (hex.length % 2) hex = "0" + hex;
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < bytes.length; i++)
    bytes[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return bytes;
}

export function addressToBytes(addr: Address): Uint8Array {
  return hexToBytes(addr as Hex);
}
