/**
 * Shared frame transaction sender with pluggable VERIFY data builders.
 *
 * Core: nonce → baseFee → FrameTxParams → computeSigHash → buildVerifyData → encode → send
 * Customization: each account type provides its own BuildVerifyData callback.
 */

import {
  encodeAbiParameters,
  parseAbiParameters,
  encodeFunctionData,
  hexToBytes,
  bytesToHex,
  concatHex,
  type Hex,
  type Hash,
  type Address,
} from "viem";
import { CHAIN_ID, DEV_KEY, FRAME_MODE_VERIFY, FRAME_MODE_SENDER } from "./config.js";
import { computeSigHash, encodeFrameTx, type FrameTxParams } from "./frame-tx.js";
import { signFrameHash } from "./signing.js";
import { waitForReceipt } from "./client.js";
import { kernelAbi } from "./abis/kernel.js";
import { walletAbi as coinbaseAbi } from "./abis/coinbase.js";
import { walletAbi as lightAccountAbi } from "./abis/light-account.js";

// ── Core ────────────────────────────────────────────────────────────

/** Callback that takes sigHash and returns VERIFY frame calldata. */
export type BuildVerifyData = (sigHash: Hex) => Hex;

export interface SendFrameTxOptions {
  publicClient: any;
  sender: Address;
  senderCalldata: Hex;
  senderGas?: bigint;
  verifyGas?: bigint;
  buildVerifyData: BuildVerifyData;
}

export async function sendFrameTx(opts: SendFrameTxOptions): Promise<any> {
  const {
    publicClient,
    sender,
    senderCalldata,
    senderGas = 500_000n,
    verifyGas = 300_000n,
    buildVerifyData,
  } = opts;

  const nonce = await publicClient.getTransactionCount({ address: sender });
  const block = await publicClient.getBlock();
  const gasFeeCap = block.baseFeePerGas! + 2_000_000_000n;

  const frameTxParams: FrameTxParams = {
    chainId: BigInt(CHAIN_ID),
    nonce: BigInt(nonce),
    sender,
    gasTipCap: 1_000_000_000n,
    gasFeeCap,
    frames: [
      { mode: FRAME_MODE_VERIFY, target: null, gasLimit: verifyGas, data: new Uint8Array(0) },
      { mode: FRAME_MODE_SENDER, target: null, gasLimit: senderGas, data: hexToBytes(senderCalldata) },
    ],
    blobFeeCap: 0n,
    blobHashes: [],
  };

  const sigHash = computeSigHash(frameTxParams);
  const verifyCalldata = buildVerifyData(sigHash);
  frameTxParams.frames[0].data = hexToBytes(verifyCalldata);

  const rawTx = encodeFrameTx(frameTxParams);
  const txHash = (await publicClient.request({
    method: "eth_sendRawTransaction" as any,
    params: [rawTx],
  })) as Hash;

  return await waitForReceipt(publicClient, txHash);
}

// ── Kernel builders ─────────────────────────────────────────────────

/** Root validator: validate(packedSig, scope) */
export function kernelValidateVerify(privKey: Hex = DEV_KEY, scope = 2): BuildVerifyData {
  return (sigHash: Hex) => {
    const { packed } = signFrameHash(sigHash, privKey);
    return encodeFunctionData({
      abi: kernelAbi,
      functionName: "validate",
      args: [bytesToHex(packed), scope],
    });
  };
}

/** Non-root validator: validateFromSenderFrame([0x01][validatorAddr][sig], scope) */
export function kernelValidatorVerify(validatorAddr: Address, privKey: Hex, scope = 2): BuildVerifyData {
  return (sigHash: Hex) => {
    const { packed } = signFrameHash(sigHash, privKey);
    const sigPrefix = `0x01${validatorAddr.slice(2)}` as Hex;
    const prefixedSig = concatHex([sigPrefix, bytesToHex(packed)]);
    return encodeFunctionData({
      abi: kernelAbi,
      functionName: "validateFromSenderFrame",
      args: [prefixedSig, scope],
    });
  };
}

/** Permission: validatePermission([0x02][permId][0xff][sig], scope) */
export function kernelPermissionVerify(permissionId: Hex, privKey: Hex, scope = 2): BuildVerifyData {
  return (sigHash: Hex) => {
    const { packed } = signFrameHash(sigHash, privKey);
    const permSig = concatHex([
      permissionId,
      "0xff",
      bytesToHex(packed),
    ]);
    const fullSig = concatHex(["0x02", permSig]);
    return encodeFunctionData({
      abi: kernelAbi,
      functionName: "validatePermission",
      args: [fullSig, scope],
    });
  };
}

// ── Coinbase builder ────────────────────────────────────────────────

/** Coinbase: validate(abiEncode(ownerIndex, sig), scope) */
export function coinbaseVerify(ownerIndex: number, privKey: Hex, scope = 2): BuildVerifyData {
  return (sigHash: Hex) => {
    const { packed } = signFrameHash(sigHash, privKey);
    const signatureWrapper = encodeAbiParameters(
      parseAbiParameters("uint256, bytes"),
      [BigInt(ownerIndex), bytesToHex(packed)],
    );
    return encodeFunctionData({
      abi: coinbaseAbi,
      functionName: "validate",
      args: [signatureWrapper, scope],
    });
  };
}

// ── LightAccount builder ────────────────────────────────────────────

/** LightAccount: validate([0x00 (EOA)][65B sig], scope) */
export function lightAccountVerify(privKey: Hex = DEV_KEY, scope = 2): BuildVerifyData {
  return (sigHash: Hex) => {
    const { packed } = signFrameHash(sigHash, privKey);
    const typedSig = new Uint8Array(1 + packed.length);
    typedSig[0] = 0x00; // SignatureType.EOA
    typedSig.set(packed, 1);
    return encodeFunctionData({
      abi: lightAccountAbi,
      functionName: "validate",
      args: [bytesToHex(typedSig), scope],
    });
  };
}
