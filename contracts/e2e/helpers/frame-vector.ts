import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { TransactionSerializableFrame } from "viem/eip8141";

type StoredTransaction = Omit<
  TransactionSerializableFrame,
  | "chainId"
  | "nonceKeys"
  | "nonceSeq"
  | "frames"
  | "maxPriorityFeePerGas"
  | "maxFeePerGas"
  | "maxFeePerBlobGas"
  | "recentRootReferences"
> & {
  chainId: string;
  nonceKeys: string[];
  nonceSeq: string;
  frames: Array<
    Omit<TransactionSerializableFrame["frames"][number], "gasLimit" | "value"> & {
      gasLimit: string;
      value: string;
    }
  >;
  maxPriorityFeePerGas: string;
  maxFeePerGas: string;
  maxFeePerBlobGas: string;
  recentRootReferences: Array<
    Omit<TransactionSerializableFrame["recentRootReferences"][number], "slot"> & { slot: string }
  >;
};

export type FrameTransactionVector = {
  name: string;
  transaction: TransactionSerializableFrame;
  sigHash: `0x${string}`;
  rawTransaction: `0x${string}`;
  intrinsicGas: bigint;
};

export function loadFrameTransactionVector(): FrameTransactionVector {
  const path = fileURLToPath(
    new URL("../../../.context/test-vectors/frame-transaction-v1.json", import.meta.url),
  );
  const stored = JSON.parse(readFileSync(path, "utf8")) as Omit<
    FrameTransactionVector,
    "transaction" | "intrinsicGas"
  > & { transaction: StoredTransaction; intrinsicGas: string };
  return {
    ...stored,
    transaction: {
      ...stored.transaction,
      chainId: Number(stored.transaction.chainId),
      nonceKeys: stored.transaction.nonceKeys.map(BigInt),
      nonceSeq: BigInt(stored.transaction.nonceSeq),
      frames: stored.transaction.frames.map((frame) => ({
        ...frame,
        gasLimit: BigInt(frame.gasLimit),
        value: BigInt(frame.value),
      })),
      maxPriorityFeePerGas: BigInt(stored.transaction.maxPriorityFeePerGas),
      maxFeePerGas: BigInt(stored.transaction.maxFeePerGas),
      maxFeePerBlobGas: BigInt(stored.transaction.maxFeePerBlobGas),
      recentRootReferences: stored.transaction.recentRootReferences.map((reference) => ({
        ...reference,
        slot: BigInt(reference.slot),
      })),
    } as TransactionSerializableFrame,
    intrinsicGas: BigInt(stored.intrinsicGas),
  };
}
