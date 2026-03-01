/**
 * E2E: Kernel8141 Permission System (ECDSASigner8141 + SelectorPolicy8141)
 *
 * Tests permission-based frame tx validation using the inline hook model:
 *   Frame 0: VERIFY(kernel)  → validatePermission(sig, 2)   → enforces executeHooked selector
 *   Frame 1: SENDER(kernel)  → executeHooked(vId, mode, data) → policy consume + execution
 *
 * Tests:
 * 1. Install permission and execute via executeHooked with correct signer
 * 2. Wrong signer rejected
 * 3. Non-executeHooked SENDER selector rejected (enforcePermissionExecution)
 *
 * Usage: cd contracts && npx tsx e2e/kernel/kernel-permission.ts
 */

import {
  encodeAbiParameters,
  encodeFunctionData,
  concatHex,
  toFunctionSelector,
  type Hex,
  type Address,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import {
  DEV_KEY,
  SECOND_OWNER_KEY,
  DEAD_ADDR,
  HOOK_INSTALLED,
} from "../helpers/config.js";
import { loadBytecode, deployContract } from "../helpers/deploy.js";
import { verifyReceipt } from "../helpers/receipt.js";
import { kernelAbi } from "../helpers/abis/kernel.js";
import {
  printReceipt,
  testHeader,
  testPassed,
  testFailed,
  summary,
  fatal,
  sectionHeader,
  step,
  detail,
  success,
} from "../helpers/log.js";
import { deployKernelTestbed, type KernelTestContext } from "./setup.js";
import { encodeExecMode, encodeSingleExec } from "../helpers/exec-encoding.js";
import { createKernelAccount, createKernelPermissionAccount, sendAndWait } from "../helpers/send-frame-tx.js";

// ── Constants ────────────────────────────────────────────────────────

const PERMISSION_ID = "0xdeadbeef" as Hex; // arbitrary 4-byte permission ID
// ValidationId = 0x02 (PERMISSION type) + permissionId padded to 21 bytes
const PERM_VID = `0x02${PERMISSION_ID.slice(2)}${"0".repeat(32)}` as Hex; // bytes21

const EXECUTE_SELECTOR = toFunctionSelector("execute(bytes32,bytes)");

// ── Helpers ──────────────────────────────────────────────────────────

const sendRoot = (ctx: KernelTestContext, senderCalldata: Hex, senderGas?: bigint) => {
  const account = createKernelAccount(ctx.kernelAddr, undefined, senderGas ? { senderGas } : {});
  return sendAndWait(ctx.publicClient, account, senderCalldata);
};

const sendPermission = (ctx: KernelTestContext, signingKey: Hex, senderCalldata: Hex) => {
  const account = createKernelPermissionAccount(ctx.kernelAddr, PERMISSION_ID, signingKey);
  return sendAndWait(ctx.publicClient, account, senderCalldata);
};

/** Send permission frame tx expecting failure. */
async function sendPermissionExpectFail(
  ctx: KernelTestContext,
  signingKey: Hex,
  senderCalldata: Hex,
): Promise<boolean> {
  try {
    const receipt = await sendPermission(ctx, signingKey, senderCalldata);
    detail(`Receipt status: ${receipt.status}`);
    if (receipt.frameReceipts) {
      for (let i = 0; i < receipt.frameReceipts.length; i++) {
        detail(`  Frame[${i}] status: ${receipt.frameReceipts[i].status}`);
      }
    }
    // VERIFY frame must fail for the security check to pass
    const verifyStatus = receipt.frameReceipts?.[0]?.status;
    if (verifyStatus === "0x0") return true;
    if (receipt.status !== "0x1") return true;
    return false;
  } catch (err: any) {
    detail(`Rejected: ${err.message?.slice(0, 100) || err}`);
    return true;
  }
}

// ── Main ─────────────────────────────────────────────────────────────

async function main() {
  const ctx = await deployKernelTestbed();
  let passed = 0;
  let total = 0;

  const secondOwnerAccount = privateKeyToAccount(SECOND_OWNER_KEY);
  const secondOwnerAddr = secondOwnerAccount.address;

  sectionHeader("Deploy Permission Modules");

  // Deploy ECDSASigner8141
  step("Deploying ECDSASigner8141...");
  const { address: signerAddr } = await deployContract(
    ctx.walletClient,
    ctx.publicClient,
    loadBytecode("ECDSASigner8141"),
    3_000_000n,
    "ECDSASigner8141"
  );

  // Deploy SelectorPolicy8141
  step("Deploying SelectorPolicy8141...");
  const { address: policyAddr } = await deployContract(
    ctx.walletClient,
    ctx.publicClient,
    loadBytecode("SelectorPolicy8141"),
    3_000_000n,
    "SelectorPolicy8141"
  );

  // ── Install permission ──────────────────────────────────────────────
  sectionHeader("Install Permission");

  // Build permission data: PermissionEnableDataFormat { bytes[] data }
  // data[0] = policy entry: [2B PassFlag][20B policyAddr][extra: 4B selector]
  // data[1] = signer entry: [2B PassFlag][20B signerAddr][extra: 20B signerAddress]
  // PassFlag 0x0001 = SKIP_FRAMETX: skip policy during frame tx validation.
  // SelectorPolicy's triple-nested mapping triggers STO-021 in VERIFY frames.
  // Frame tx selector enforcement is handled by _enforcePermissionExecution (executeHooked only).
  const policyEntry = concatHex([
    "0x0001",            // PassFlag: SKIP_FRAMETX (policy checked in ERC-1271 only)
    policyAddr as Hex,   // SelectorPolicy address
    EXECUTE_SELECTOR,    // allowed selector for policy onInstall
  ]);
  const signerEntry = concatHex([
    "0x0000",              // PassFlag: no skip
    signerAddr as Hex,     // ECDSASigner address
    secondOwnerAddr as Hex, // signer address for onInstall
  ]);
  const permData = encodeAbiParameters(
    [{ name: "data", type: "bytes[]" }],
    [[policyEntry, signerEntry]]
  );

  step("Installing permission via installValidations...");
  const installCalldata = encodeFunctionData({
    abi: kernelAbi,
    functionName: "installValidations",
    args: [
      [PERM_VID],                    // vIds: bytes21[]
      [{ nonce: 1, hook: HOOK_INSTALLED }], // configs: (uint32, address)[]
      [permData],                    // validationData: bytes[]
      ["0x"],                        // hookData: bytes[]
    ],
  });
  const installReceipt = await sendRoot(ctx, installCalldata, 1_000_000n);
  verifyReceipt(installReceipt, ctx.kernelAddr, { expectVerifyStatus: "0x4|0x2" });
  success("Permission installed");

  // ── Test 1: Permission-based execution via executeHooked ────────────
  testHeader(++total, "Permission-based execution via executeHooked with correct signer");
  {
    const execMode = encodeExecMode("0x00", "0x00"); // SINGLE + DEFAULT
    const execCalldata = encodeSingleExec(DEAD_ADDR, 0n);
    const senderCalldata = encodeFunctionData({
      abi: kernelAbi,
      functionName: "executeHooked",
      args: [PERM_VID, execMode, execCalldata],
    });

    const receipt = await sendPermission(ctx, SECOND_OWNER_KEY as Hex, senderCalldata);
    printReceipt(receipt);
    verifyReceipt(receipt, ctx.kernelAddr, { expectVerifyStatus: "0x4|0x2" });
    passed++;
    testPassed("Permission-based execution via executeHooked succeeded");
  }

  // ── Test 2: Wrong signer rejected ──────────────────────────────────
  testHeader(++total, "Wrong signer rejected (permission)");
  {
    const execMode = encodeExecMode("0x00", "0x00");
    const execCalldata = encodeSingleExec(DEAD_ADDR, 0n);
    const senderCalldata = encodeFunctionData({
      abi: kernelAbi,
      functionName: "executeHooked",
      args: [PERM_VID, execMode, execCalldata],
    });

    // Sign with DEV_KEY instead of SECOND_OWNER_KEY
    const rejected = await sendPermissionExpectFail(ctx, DEV_KEY as Hex, senderCalldata);
    if (rejected) {
      passed++;
      testPassed("Wrong signer correctly rejected");
    } else {
      testFailed("Wrong signer was NOT rejected!");
    }
  }

  // ── Test 3: Non-executeHooked SENDER selector rejected ─────────────
  testHeader(++total, "Non-executeHooked SENDER selector rejected (enforcePermissionExecution)");
  {
    // Use execute() instead of executeHooked() — _enforcePermissionExecution rejects
    const execMode = encodeExecMode("0x00", "0x00");
    const execCalldata = encodeSingleExec(DEAD_ADDR, 0n);
    const senderCalldata = encodeFunctionData({
      abi: kernelAbi,
      functionName: "execute",
      args: [execMode, execCalldata],
    });

    const rejected = await sendPermissionExpectFail(
      ctx,
      SECOND_OWNER_KEY as Hex,
      senderCalldata
    );
    if (rejected) {
      passed++;
      testPassed("Non-executeHooked selector correctly rejected");
    } else {
      testFailed("Non-executeHooked selector was NOT rejected!");
    }
  }

  summary("Kernel Permission", passed, total);
  if (passed < total) process.exit(1);
}

main().catch((err) => {
  fatal(err);
  process.exit(1);
});
