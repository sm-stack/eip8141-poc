/**
 * E2E: Kernel8141 Permission System (ECDSASigner8141 + SelectorPolicy8141)
 *
 * Tests:
 * 1. Install permission and execute with correct signer + allowed selector
 * 2. Wrong signer rejected
 * 3. Disallowed selector rejected
 *
 * Usage: cd contracts && npx tsx e2e/kernel/kernel-permission.ts
 */

import {
  encodeAbiParameters,
  parseAbiParameters,
  encodeFunctionData,
  hexToBytes,
  bytesToHex,
  concatHex,
  padHex,
  toFunctionSelector,
  type Hex,
  type Hash,
  type Address,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import {
  CHAIN_ID,
  DEV_KEY,
  SECOND_OWNER_KEY,
  DEAD_ADDR,
  FRAME_MODE_VERIFY,
  FRAME_MODE_SENDER,
} from "../helpers/config.js";
import { waitForReceipt } from "../helpers/client.js";
import { loadBytecode, deployContract } from "../helpers/deploy.js";
import { computeSigHash, encodeFrameTx, type FrameTxParams } from "../helpers/frame-tx.js";
import { signFrameHash } from "../helpers/signing.js";
import { printReceipt, verifyReceipt } from "../helpers/receipt.js";
import { kernelAbi } from "../helpers/abis/kernel.js";
import {
  testHeader,
  testPassed,
  testFailed,
  summary,
  fatal,
  sectionHeader,
  step,
  info,
  detail,
  success,
} from "../helpers/log.js";
import { deployKernelTestbed, type KernelTestContext } from "./setup.js";

// ── Constants ────────────────────────────────────────────────────────

const HOOK_INSTALLED = "0x0000000000000000000000000000000000000001" as Address;
const PERMISSION_ID = "0xdeadbeef" as Hex; // arbitrary 4-byte permission ID
// ValidationId = 0x02 (PERMISSION type) + permissionId padded to 21 bytes
const PERM_VID = `0x02${PERMISSION_ID.slice(2)}${"0".repeat(32)}` as Hex; // bytes21

const EXECUTE_SELECTOR = toFunctionSelector("execute(bytes32,bytes)");
const CHANGE_ROOT_SELECTOR = toFunctionSelector(
  "changeRootValidator(bytes21,address,bytes,bytes)"
);

// ── Helpers ──────────────────────────────────────────────────────────

function encodeExecMode(callType: string, execType: string): Hex {
  return padHex(`0x${callType.slice(2)}${execType.slice(2)}` as Hex, {
    size: 32,
    dir: "right",
  });
}

function encodeSingleExec(target: Address, value: bigint, data: Hex = "0x"): Hex {
  const targetHex = target.slice(2).toLowerCase().padStart(40, "0");
  const valueHex = value.toString(16).padStart(64, "0");
  const dataHex = data.slice(2);
  return `0x${targetHex}${valueHex}${dataHex}` as Hex;
}

/** Send frame tx validated by root validator. */
async function sendRootFrameTx(
  ctx: KernelTestContext,
  senderCalldata: Hex,
  senderGas = 500_000n
): Promise<any> {
  const { publicClient, kernelAddr } = ctx;
  const kernelNonce = await publicClient.getTransactionCount({ address: kernelAddr });
  const block = await publicClient.getBlock();
  const gasFeeCap = block.baseFeePerGas! + 2_000_000_000n;

  const frameTxParams: FrameTxParams = {
    chainId: BigInt(CHAIN_ID),
    nonce: BigInt(kernelNonce),
    sender: kernelAddr,
    gasTipCap: 1_000_000_000n,
    gasFeeCap,
    frames: [
      { mode: FRAME_MODE_VERIFY, target: null, gasLimit: 300_000n, data: new Uint8Array(0) },
      { mode: FRAME_MODE_SENDER, target: null, gasLimit: senderGas, data: hexToBytes(senderCalldata) },
    ],
    blobFeeCap: 0n,
    blobHashes: [],
  };

  const sigHash = computeSigHash(frameTxParams);
  const { packed: packedSig } = signFrameHash(sigHash, DEV_KEY);
  const validateCalldata = encodeFunctionData({
    abi: kernelAbi,
    functionName: "validate",
    args: [bytesToHex(packedSig), 2],
  });
  frameTxParams.frames[0].data = hexToBytes(validateCalldata);

  const rawTx = encodeFrameTx(frameTxParams);
  const txHash = (await publicClient.request({
    method: "eth_sendRawTransaction" as any,
    params: [rawTx],
  })) as Hash;
  return await waitForReceipt(publicClient, txHash);
}

/** Send frame tx validated by permission (validatePermission). */
async function sendPermissionFrameTx(
  ctx: KernelTestContext,
  signingKey: Hex,
  senderCalldata: Hex,
  senderGas = 500_000n
): Promise<any> {
  const { publicClient, kernelAddr } = ctx;
  const kernelNonce = await publicClient.getTransactionCount({ address: kernelAddr });
  const block = await publicClient.getBlock();
  const gasFeeCap = block.baseFeePerGas! + 2_000_000_000n;

  const frameTxParams: FrameTxParams = {
    chainId: BigInt(CHAIN_ID),
    nonce: BigInt(kernelNonce),
    sender: kernelAddr,
    gasTipCap: 1_000_000_000n,
    gasFeeCap,
    frames: [
      { mode: FRAME_MODE_VERIFY, target: null, gasLimit: 300_000n, data: new Uint8Array(0) },
      { mode: FRAME_MODE_SENDER, target: null, gasLimit: senderGas, data: hexToBytes(senderCalldata) },
    ],
    blobFeeCap: 0n,
    blobHashes: [],
  };

  const sigHash = computeSigHash(frameTxParams);
  const { packed: ecdsaSig } = signFrameHash(sigHash, signingKey);

  // sig format for validatePermission:
  // [0x02][4B permissionId][0xff signer prefix][65B ecdsa sig]
  const permSig = concatHex([
    PERMISSION_ID,    // 0x02 type is part of vId encoding, but validatePermission reads raw type+permId
    "0xff",           // signer prefix (no policy sig data for SelectorPolicy)
    bytesToHex(ecdsaSig),
  ]);
  // Full sig includes type byte: [0x02][4B permId][0xff][65B sig]
  const fullSig = concatHex(["0x02", permSig]);

  const validateCalldata = encodeFunctionData({
    abi: kernelAbi,
    functionName: "validatePermission",
    args: [fullSig, 2],
  });
  frameTxParams.frames[0].data = hexToBytes(validateCalldata);

  const rawTx = encodeFrameTx(frameTxParams);
  const txHash = (await publicClient.request({
    method: "eth_sendRawTransaction" as any,
    params: [rawTx],
  })) as Hash;
  return await waitForReceipt(publicClient, txHash);
}

/** Send permission frame tx expecting failure. */
async function sendPermissionFrameTxExpectFail(
  ctx: KernelTestContext,
  signingKey: Hex,
  senderCalldata: Hex,
  senderGas = 500_000n
): Promise<boolean> {
  try {
    const receipt = await sendPermissionFrameTx(ctx, signingKey, senderCalldata, senderGas);
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
  // The kernel's own allowedSelectors ACL (grantAccess) handles frame tx selector checks.
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
  const installReceipt = await sendRootFrameTx(ctx, installCalldata, 1_000_000n);
  verifyReceipt(installReceipt, ctx.kernelAddr, { expectVerifyStatus: "0x4|0x2" });
  success("Permission installed");

  // Grant selector access for execute()
  step("Granting selector access for execute()...");
  const grantCalldata = encodeFunctionData({
    abi: kernelAbi,
    functionName: "grantAccess",
    args: [PERM_VID, EXECUTE_SELECTOR, true],
  });
  const grantReceipt = await sendRootFrameTx(ctx, grantCalldata);
  verifyReceipt(grantReceipt, ctx.kernelAddr, { expectVerifyStatus: "0x4|0x2" });
  success("Selector access granted");

  // ── Test 1: Permission-based execution succeeds ─────────────────────
  testHeader(++total, "Permission-based execution with correct signer + allowed selector");
  {
    const execMode = encodeExecMode("0x00", "0x00"); // SINGLE + DEFAULT
    const execCalldata = encodeSingleExec(DEAD_ADDR, 0n);
    const senderCalldata = encodeFunctionData({
      abi: kernelAbi,
      functionName: "execute",
      args: [execMode, execCalldata],
    });

    const receipt = await sendPermissionFrameTx(ctx, SECOND_OWNER_KEY as Hex, senderCalldata);
    printReceipt(receipt);
    verifyReceipt(receipt, ctx.kernelAddr, { expectVerifyStatus: "0x4|0x2" });
    passed++;
    testPassed("Permission-based execution succeeded");
  }

  // ── Test 2: Wrong signer rejected ──────────────────────────────────
  testHeader(++total, "Wrong signer rejected (permission)");
  {
    const execMode = encodeExecMode("0x00", "0x00");
    const execCalldata = encodeSingleExec(DEAD_ADDR, 0n);
    const senderCalldata = encodeFunctionData({
      abi: kernelAbi,
      functionName: "execute",
      args: [execMode, execCalldata],
    });

    // Sign with DEV_KEY instead of SECOND_OWNER_KEY
    const rejected = await sendPermissionFrameTxExpectFail(ctx, DEV_KEY as Hex, senderCalldata);
    if (rejected) {
      passed++;
      testPassed("Wrong signer correctly rejected");
    } else {
      testFailed("Wrong signer was NOT rejected!");
    }
  }

  // ── Test 3: Disallowed selector rejected ───────────────────────────
  testHeader(++total, "Disallowed selector rejected (permission)");
  {
    // Use changeRootValidator which is NOT in the allowed selector list
    const senderCalldata = encodeFunctionData({
      abi: kernelAbi,
      functionName: "changeRootValidator",
      args: [
        PERM_VID,       // arbitrary validator id
        HOOK_INSTALLED, // hook
        "0x",           // validatorData
        "0x",           // hookData
      ],
    });

    const rejected = await sendPermissionFrameTxExpectFail(
      ctx,
      SECOND_OWNER_KEY as Hex,
      senderCalldata
    );
    if (rejected) {
      passed++;
      testPassed("Disallowed selector correctly rejected");
    } else {
      testFailed("Disallowed selector was NOT rejected!");
    }
  }

  summary("Kernel Permission", passed, total);
  if (passed < total) process.exit(1);
}

main().catch((err) => {
  fatal(err);
  process.exit(1);
});
