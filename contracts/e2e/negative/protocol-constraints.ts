/**
 * E2E: Frame ordering and approval constraint tests
 *
 * Tests that the framepool's static validation (validateFrameOrdering) and
 * post-simulation validation (validateScopeOrdering) correctly reject
 * transactions with invalid frame ordering or approval scope sequences.
 *
 * All tests expect eth_sendRawTransaction to return an RPC error.
 *
 * Usage: cd contracts && npx tsx e2e/negative/protocol-constraints.ts
 */

import {
  encodeAbiParameters,
  parseAbiParameters,
  hexToBytes,
  type Hex,
  type Address,
} from "viem";
import {
  CHAIN_ID,
  DEV_KEY,
  DEAD_ADDR,
  FRAME_MODE_VERIFY,
  FRAME_MODE_SENDER,
} from "../helpers/config.js";
import { createTestClients, fundAccount } from "../helpers/client.js";
import { loadBytecode, deployContract } from "../helpers/deploy.js";
import { computeSigHash, encodeFrameTx, type FrameTxParams } from "../helpers/frame-tx.js";
import { signFrameHash } from "../helpers/signing.js";
import { expectRpcRejection } from "../helpers/expect.js";
import { SIMPLE_VALIDATE_SELECTOR } from "../helpers/abis/simple.js";
import {
  banner,
  sectionHeader,
  info,
  step,
  testHeader,
  testPassed,
  summary,
  fatal,
} from "../helpers/log.js";

// ─── Helpers ────────────────────────────────────────────────────────────────

function encodeValidate(v: number, r: bigint, s: bigint, scope: number): Uint8Array {
  const selectorBytes = hexToBytes(SIMPLE_VALIDATE_SELECTOR as Hex);
  const calldata = new Uint8Array(4 + 32 * 4);
  calldata.set(selectorBytes, 0);
  calldata[35] = v + 27;
  const rHex = r.toString(16).padStart(64, "0");
  calldata.set(hexToBytes(("0x" + rHex) as Hex), 36);
  const sHex = s.toString(16).padStart(64, "0");
  calldata.set(hexToBytes(("0x" + sHex) as Hex), 68);
  calldata[131] = scope;
  return calldata;
}

/**
 * Sign frame tx, set VERIFY calldata, encode, and send expecting RPC rejection.
 */
async function sendExpectingRejection(
  publicClient: any,
  params: FrameTxParams,
  verifyFrameIndices: { index: number; scope: number }[],
  expectedError?: string
): Promise<string> {
  const sigHash = computeSigHash(params);
  const { r, s, v } = signFrameHash(sigHash, DEV_KEY);

  for (const { index, scope } of verifyFrameIndices) {
    params.frames[index].data = encodeValidate(v, r, s, scope);
  }

  const rawTx = encodeFrameTx(params);
  return expectRpcRejection(async () => {
    await publicClient.request({
      method: "eth_sendRawTransaction" as any,
      params: [rawTx],
    });
  }, expectedError);
}

// ─── Main ───────────────────────────────────────────────────────────────────

async function main() {
  const { publicClient, walletClient, devAddr } = createTestClients();
  let passed = 0;
  const total = 5;

  banner("Frame Ordering & Approval Constraint Tests");
  info(`Dev account: ${devAddr}`);

  // ── Deploy Simple8141Account ──────────────────────────────────────────

  sectionHeader("Deploy Simple8141Account");
  const initCode = loadBytecode("Simple8141Account");
  const constructorArg = encodeAbiParameters(parseAbiParameters("address"), [devAddr]);
  const deployData = (initCode + constructorArg.slice(2)) as Hex;
  const { address: accountAddr } = await deployContract(
    walletClient, publicClient, deployData, 1_000_000n, "Simple8141Account"
  );

  sectionHeader("Fund account");
  await fundAccount(walletClient, publicClient, accountAddr);

  async function getContext() {
    const nonce = BigInt(await publicClient.getTransactionCount({ address: accountAddr }));
    const block = await publicClient.getBlock();
    const gasFeeCap = block.baseFeePerGas! + 2_000_000_000n;
    return { nonce, gasFeeCap };
  }

  // ── Test 1: SENDER frame before VERIFY ────────────────────────────────
  // Caught by validateFrameOrdering: "SENDER frame before any VERIFY targeting sender"

  testHeader(1, "SENDER frame before VERIFY approval");
  try {
    const ctx = await getContext();
    const params: FrameTxParams = {
      chainId: BigInt(CHAIN_ID),
      nonce: ctx.nonce,
      sender: accountAddr,
      gasTipCap: 1_000_000_000n,
      gasFeeCap: ctx.gasFeeCap,
      frames: [
        { mode: FRAME_MODE_SENDER, target: DEAD_ADDR as Address | null, gasLimit: 50_000n, data: new Uint8Array(0) },
        { mode: FRAME_MODE_VERIFY, target: null, gasLimit: 200_000n, data: new Uint8Array(0) },
      ],
      blobFeeCap: 0n,
      blobHashes: [],
    };

    const msg = await sendExpectingRejection(
      publicClient, params,
      [{ index: 1, scope: 2 }],
      "sender frame before"
    );
    step(`Rejected: ${msg.slice(0, 120)}`);
    testPassed("SENDER before approval");
    passed++;
  } catch (err: any) {
    console.error(`  FAILED: ${err.message}`);
  }

  // ── Test 2: Payment approval before execution approval ────────────────
  // Caught by validateScopeOrdering: "payment approval without prior execution approval"

  testHeader(2, "Payment approval before execution approval");
  try {
    const ctx = await getContext();
    const params: FrameTxParams = {
      chainId: BigInt(CHAIN_ID),
      nonce: ctx.nonce,
      sender: accountAddr,
      gasTipCap: 1_000_000_000n,
      gasFeeCap: ctx.gasFeeCap,
      frames: [
        { mode: FRAME_MODE_VERIFY, target: null, gasLimit: 200_000n, data: new Uint8Array(0) },
        { mode: FRAME_MODE_SENDER, target: DEAD_ADDR as Address | null, gasLimit: 50_000n, data: new Uint8Array(0) },
      ],
      blobFeeCap: 0n,
      blobHashes: [],
    };

    const msg = await sendExpectingRejection(
      publicClient, params,
      [{ index: 0, scope: 1 }],
      "payment approval without prior execution"
    );
    step(`Rejected: ${msg.slice(0, 120)}`);
    testPassed("Payment before execution");
    passed++;
  } catch (err: any) {
    console.error(`  FAILED: ${err.message}`);
  }

  // ── Test 3: Missing payment approval ──────────────────────────────────
  // Caught by validateScopeOrdering: "no payer approved among VERIFY frames"

  testHeader(3, "Missing payment approval (execution only)");
  try {
    const ctx = await getContext();
    const params: FrameTxParams = {
      chainId: BigInt(CHAIN_ID),
      nonce: ctx.nonce,
      sender: accountAddr,
      gasTipCap: 1_000_000_000n,
      gasFeeCap: ctx.gasFeeCap,
      frames: [
        { mode: FRAME_MODE_VERIFY, target: null, gasLimit: 200_000n, data: new Uint8Array(0) },
        { mode: FRAME_MODE_SENDER, target: DEAD_ADDR as Address | null, gasLimit: 50_000n, data: new Uint8Array(0) },
      ],
      blobFeeCap: 0n,
      blobHashes: [],
    };

    const msg = await sendExpectingRejection(
      publicClient, params,
      [{ index: 0, scope: 0 }],
      "no payer approved"
    );
    step(`Rejected: ${msg.slice(0, 120)}`);
    testPassed("Missing payment approval");
    passed++;
  } catch (err: any) {
    console.error(`  FAILED: ${err.message}`);
  }

  // ── Test 4: Double execution approval ─────────────────────────────────
  // Caught by validateScopeOrdering: "execution re-approval"

  testHeader(4, "Double execution approval");
  try {
    const ctx = await getContext();
    const params: FrameTxParams = {
      chainId: BigInt(CHAIN_ID),
      nonce: ctx.nonce,
      sender: accountAddr,
      gasTipCap: 1_000_000_000n,
      gasFeeCap: ctx.gasFeeCap,
      frames: [
        { mode: FRAME_MODE_VERIFY, target: null, gasLimit: 200_000n, data: new Uint8Array(0) },
        { mode: FRAME_MODE_VERIFY, target: null, gasLimit: 200_000n, data: new Uint8Array(0) },
        { mode: FRAME_MODE_SENDER, target: DEAD_ADDR as Address | null, gasLimit: 50_000n, data: new Uint8Array(0) },
      ],
      blobFeeCap: 0n,
      blobHashes: [],
    };

    const msg = await sendExpectingRejection(
      publicClient, params,
      [{ index: 0, scope: 0 }, { index: 1, scope: 0 }],
      "re-approval"
    );
    step(`Rejected: ${msg.slice(0, 120)}`);
    testPassed("Double execution approval");
    passed++;
  } catch (err: any) {
    console.error(`  FAILED: ${err.message}`);
  }

  // ── Test 5: APPROVE from inner call (ADDRESS != frame.target) ───────
  // The account validates the signature correctly, then delegates APPROVE
  // to a separate relay contract via staticcall. The relay's ADDRESS differs
  // from frame.target (the account), so opApprove rejects the call.
  // The VERIFY frame reverts → no approval → tx rejected.

  testHeader(5, "APPROVE from inner call (ADDRESS != frame.target)");
  try {
    // Deploy ApproveRelay
    const relayBytecode = loadBytecode("ApproveRelay");
    const { address: relayAddr } = await deployContract(
      walletClient, publicClient, relayBytecode, 500_000n, "ApproveRelay"
    );

    // Deploy InnerApproveAccount(owner, relay)
    const innerBytecode = loadBytecode("InnerApproveAccount");
    const innerArgs = encodeAbiParameters(
      parseAbiParameters("address, address"),
      [devAddr, relayAddr]
    );
    const innerDeployData = (innerBytecode + innerArgs.slice(2)) as Hex;
    const { address: innerAddr } = await deployContract(
      walletClient, publicClient, innerDeployData, 1_000_000n, "InnerApproveAccount"
    );

    // Fund account
    await fundAccount(walletClient, publicClient, innerAddr);

    const innerNonce = BigInt(await publicClient.getTransactionCount({ address: innerAddr }));
    const innerBlock = await publicClient.getBlock();
    const innerGasFeeCap = innerBlock.baseFeePerGas! + 2_000_000_000n;
    const params: FrameTxParams = {
      chainId: BigInt(CHAIN_ID),
      nonce: innerNonce,
      sender: innerAddr,
      gasTipCap: 1_000_000_000n,
      gasFeeCap: innerGasFeeCap,
      frames: [
        { mode: FRAME_MODE_VERIFY, target: null, gasLimit: 200_000n, data: new Uint8Array(0) },
        { mode: FRAME_MODE_SENDER, target: DEAD_ADDR as Address | null, gasLimit: 50_000n, data: new Uint8Array(0) },
      ],
      blobFeeCap: 0n,
      blobHashes: [],
    };

    const msg = await sendExpectingRejection(
      publicClient, params,
      [{ index: 0, scope: 2 }]
    );
    step(`Rejected: ${msg.slice(0, 120)}`);
    testPassed("Inner call APPROVE rejected");
    passed++;
  } catch (err: any) {
    console.error(`  FAILED: ${err.message}`);
  }

  // ── Summary ──────────────────────────────────────────────────────────

  summary("Frame Ordering & Approval Constraints", passed, total);
  if (passed < total) process.exit(1);
}

main().catch((err) => {
  fatal(err);
  process.exit(1);
});
