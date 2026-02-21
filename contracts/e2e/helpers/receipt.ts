import type { Address } from "viem";

export const FRAME_STATUS_NAMES: Record<string, string> = {
  "0x0": "Failed",
  "0x1": "Success",
  "0x2": "ApproveExecution",
  "0x3": "ApprovePayment",
  "0x4": "ApproveBoth",
};

export function printReceipt(r: any) {
  const statusName = FRAME_STATUS_NAMES[r.status] || r.status;
  console.log(
    `  Status: ${statusName}, GasUsed: ${BigInt(r.gasUsed)}, Type: ${r.type}`
  );
  if (r.payer) console.log(`  Payer: ${r.payer}`);
  if (r.frameReceipts) {
    for (let i = 0; i < r.frameReceipts.length; i++) {
      const fr = r.frameReceipts[i];
      const name = FRAME_STATUS_NAMES[fr.status] || `Unknown(${fr.status})`;
      console.log(`  Frame ${i}: ${name}, GasUsed: ${BigInt(fr.gasUsed)}`);
    }
  }
}

export function verifyReceipt(
  receipt: any,
  accountAddr: Address,
  options: {
    expectVerifyStatus?: string;
    expectSenderStatus?: string;
    expectFrameCount?: number;
  } = {}
) {
  const {
    expectVerifyStatus = "0x4",
    expectSenderStatus = "0x1",
    expectFrameCount = 2,
  } = options;

  if (receipt.status !== "0x1") {
    throw new Error(`TX failed: status=${receipt.status}`);
  }
  if (receipt.type !== "0x6") {
    throw new Error(`Wrong type: got ${receipt.type}, want 0x6`);
  }
  if (
    receipt.payer &&
    receipt.payer.toLowerCase() !== accountAddr.toLowerCase()
  ) {
    throw new Error(
      `Wrong payer: got ${receipt.payer}, want ${accountAddr}`
    );
  }
  if (receipt.frameReceipts) {
    if (receipt.frameReceipts.length !== expectFrameCount) {
      throw new Error(
        `Frame receipts count: got ${receipt.frameReceipts.length}, want ${expectFrameCount}`
      );
    }
    // VERIFY frame (frame 0)
    const verifyStatus = receipt.frameReceipts[0].status;
    if (expectVerifyStatus.includes("|")) {
      const allowed = expectVerifyStatus.split("|");
      if (!allowed.includes(verifyStatus)) {
        throw new Error(
          `VERIFY frame: got ${verifyStatus}, want one of [${allowed.join(", ")}]`
        );
      }
    } else if (verifyStatus !== expectVerifyStatus) {
      throw new Error(
        `VERIFY frame: got ${verifyStatus}, want ${expectVerifyStatus}`
      );
    }
    // SENDER frame (frame 1)
    if (receipt.frameReceipts[1].status !== expectSenderStatus) {
      throw new Error(
        `SENDER frame: got ${receipt.frameReceipts[1].status}, want ${expectSenderStatus}`
      );
    }
  }
  if (BigInt(receipt.gasUsed) === 0n) {
    throw new Error("Gas used should be > 0");
  }
}
