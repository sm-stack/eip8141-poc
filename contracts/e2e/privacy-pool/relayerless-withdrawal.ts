import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { encodeAbiParameters, encodeFunctionData, parseAbi, parseAbiParameters, parseEther, type Address, type Hex } from "viem";
import { serializeFrameTransaction } from "viem/eip8141";
import { createTestClients, waitForReceipt } from "../helpers/client.js";
import { deployContract } from "../helpers/deploy.js";
import {
    CommitmentTree, MAX_GAS_CHARGE, VERIFY_GAS, buildDir, poolAbi, createNote,
    proveWithdrawal, statementHash, settleGasCharge, buildWithdrawalTransaction,
    nonceStorageSlot, verifyArtifacts,
} from "../../privacy-pool/src/index.mjs";

const D = parseEther("1");
const nonceManager = "0x0000000000000000000000000000000000008250" as Address;
const { publicClient, walletClient } = createTestClients(process.env.RPC_URL);
const report: any = { developmentOnly: true, rpcUrl: process.env.RPC_URL ?? "http://localhost:18545", declaredVerifyGas: VERIFY_GAS,
    configuredVerifyCap: process.env.FRAMEPOOL_MAX_VERIFY_GAS ?? "unspecified",
    configuredRevalidationCap: process.env.FRAMEPOOL_MAX_REVALIDATION_GAS ?? "unspecified",
    runs: [] };
const artifact = (name: string) => JSON.parse(readFileSync(resolve(buildDir, `${name}.json`), "utf8"));

async function main() {
    verifyArtifacts();
    const chainId = await publicClient.getChainId();
    assert.equal(chainId, 1337, "This test is restricted to the local devnet");
    const hasher = await deployContract(walletClient, publicClient, artifact("poseidon").bytecode, 3_000_000n, "Poseidon2");
    const constructor = encodeAbiParameters(parseAbiParameters("address,uint256"), [hasher.address, D]);

    for (const harness of [false, true]) {
        const name = harness ? "DevelopmentPrivacyPoolDeliveryHarness" : "Groth16PrivacyPool8141";
        const pool = await deployContract(walletClient, publicClient, `${artifact(harness ? "pool-harness" : "pool").bytecode}${constructor.slice(2)}` as Hex, 5_000_000n, name);
        const tree = await CommitmentTree.create();
        const notes = [await createNote(), await createNote()];
        let oldPath: any;
        for (let i = 0; i < notes.length; i++) {
            const inserted = await tree.insert(notes[i].commitment);
            const hash = await walletClient.writeContract({ address: pool.address, abi: poolAbi, functionName: "deposit", args: [notes[i].commitment], value: D });
            assert.equal((await waitForReceipt(publicClient, hash)).status, "0x1");
            assert.equal(await publicClient.readContract({ address: pool.address, abi: poolAbi, functionName: "currentRoot" }), inserted.root);
            if (i === 0) oldPath = tree.path(0);
        }
        // Use the older root after another deposit: no recent-root system or
        // next-slot wait is needed for append-only roots owned by tx.sender.
        const recipient = harness
            ? "0x000000000000000000000000000000000000ba02"
            : "0x000000000000000000000000000000000000ba01";
        const recipientBefore = await publicClient.getBalance({ address: recipient });
        let actualFailedFee = 0n;
        const attempts = harness ? 2 : 1;
        for (let attempt = 0; attempt < attempts; attempt++) {
            const seqRaw = await publicClient.getStorageAt({ address: nonceManager, slot: nonceStorageSlot(pool.address, notes[0].nullifierHash) });
            const nonceSeq = BigInt(seqRaw ?? "0x0");
            assert.equal(nonceSeq, BigInt(attempt));
            // A fixed authorization cap is not a gas-price guarantee. Wait
            // for the fresh devnet's base fee to fit, rather than raising it.
            let block = await publicClient.getBlock();
            const feeDeadline = Date.now() + 60_000;
            while ((block.baseFeePerGas ?? 0n) > MAX_GAS_CHARGE / 3_400_000n) {
                if (Date.now() > feeDeadline) throw new Error("Devnet fee did not fit the 0.001 ETH cap");
                await new Promise(resolve => setTimeout(resolve, 1000));
                block = await publicClient.getBlock();
            }
            const initial = { root: oldPath.root, nullifierHash: notes[0].nullifierHash, recipient,
                nonceSeq, maxGasCharge: MAX_GAS_CHARGE, gasCharge: 0n, verifyGasLimit: VERIFY_GAS,
                maxPriorityFeePerGas: 1n, maxFeePerGas: (block.baseFeePerGas ?? 1n) * 2n + 1n };
            const context = statementHash(chainId, pool.address, D, initial);
            assert.equal(await publicClient.readContract({ address: pool.address, abi: poolAbi, functionName: "withdrawStatementHash", args: [initial] }), context);
            const result = await proveWithdrawal(notes[0], oldPath, context);
            const intent = settleGasCharge(chainId, pool.address, result.encoded, initial, D);
            const tx = buildWithdrawalTransaction(chainId, pool.address, result.encoded, intent);
            if (!harness) {
                const rejected: string[] = [];
                const reject = async (candidate: any, label: string) => {
                    const serialized = serializeFrameTransaction(candidate);
                    await assert.rejects(
                        () => publicClient.request({ method: "eth_sendRawTransaction", params: [serialized] }),
                        /validation|revert|verify/i,
                        label,
                    );
                    rejected.push(label);
                };
                const changedRecipient = settleGasCharge(chainId, pool.address, result.encoded,
                    { ...initial, recipient: "0x000000000000000000000000000000000000ba03" }, D);
                await reject(buildWithdrawalTransaction(chainId, pool.address, result.encoded, changedRecipient), "proof cannot redirect payout");
                await reject({ ...tx, frames: [tx.frames[0], { ...tx.frames[1], data: "0x" }] }, "execution calldata is pinned");
                for (const [offset, label] of [[0, "selector"], [4, "nullifier"], [36, "recipient padding"], [68, "nonce padding"], [100, "gas charge"]] as const) {
                    const data = tx.frames[1].data;
                    const at = 2 + offset * 2;
                    const changed = (parseInt(data.slice(at, at + 2), 16) ^ 1).toString(16).padStart(2, "0");
                    const mutation = `${data.slice(0, at)}${changed}${data.slice(at + 2)}`;
                    await reject({ ...tx, frames: [tx.frames[0], { ...tx.frames[1], data: mutation }] }, `execution ${label} is pinned`);
                }
                await reject({ ...tx, frames: [tx.frames[0], { ...tx.frames[1], data: `${tx.frames[1].data}00` }] }, "trailing execution bytes rejected");
                await reject({ ...tx, frames: [tx.frames[0], { ...tx.frames[1], stateGasLimit: 1n }] }, "execution state budget is pinned");
                await reject({ ...tx, nonceKeys: [1n] }, "nullifier nonce key is pinned");
                // Exercise every independently mutable frame budget/value/target
                // in the branchless comparison groups (some also fail protocol gates).
                for (const index of [0, 1]) {
                    for (const [field, value] of [
                        ['gasLimit', tx.frames[index].gasLimit - 1n],
                        ['stateGasLimit', tx.frames[index].stateGasLimit - 1n],
                        ['value', 1n],
                        ['target', hasher.address],
                    ] as const) {
                        // The serializer itself prohibits VERIFY value and
                        // execution approval at another target. Do not count
                        // client-only failures as geth validation evidence.
                        if (index === 0 && (field === 'value' || field === 'target')) continue;
                        const frames = tx.frames.map((frame: any, i: number) => i === index ? { ...frame, [field]: value } : frame);
                        await reject({ ...tx, frames }, `frame ${index} ${field} is pinned`);
                    }
                }
                await reject({ ...tx, frames: [tx.frames[0]] }, "missing execution frame rejected");
                await reject({ ...tx, frames: [...tx.frames, tx.frames[1]] }, "extra execution frame rejected");
                await reject({ ...tx, frames: [{ ...tx.frames[0], flags: 1 }, tx.frames[1]] }, "verify approval flags are pinned");
                await reject({ ...tx, frames: [tx.frames[0], { ...tx.frames[1], mode: 'default' }] }, "execution mode is pinned");
                await reject({ ...tx, frames: [tx.frames[0], { ...tx.frames[1], flags: 1 }] }, "execution flags are pinned");
                await reject({ ...tx, frames: tx.frames.map((frame: any) => ({ ...frame, gasLimit: frame.gasLimit ^ 1n })) }, "two equal-bit mismatches cannot cancel");
                for (const field of ['gasCharge', 'verifyGasLimit', 'maxPriorityFeePerGas', 'maxFeePerGas'] as const) {
                    const changedIntent = { ...intent, [field]: intent[field] + 1n };
                    const data = encodeFunctionData({ abi: poolAbi, functionName: 'validateWithdrawal', args: [result.encoded, changedIntent] });
                    await reject({ ...tx, frames: [{ ...tx.frames[0], data }, tx.frames[1]] }, `intent ${field} matches transaction`);
                }
                assert.equal(await publicClient.getBalance({ address: pool.address }), 2n * D, "rejected transactions spend no deposits");
                report.rejections = rejected;
                console.log(`PASS ${rejected.length} invalid withdrawals rejected before payment`);
            }
            const poolBefore = await publicClient.getBalance({ address: pool.address });
            const hash = await publicClient.request({ method: "eth_sendRawTransaction", params: [serializeFrameTransaction(tx)] });
            const receipt = await waitForReceipt(publicClient, hash);
            assert.equal(receipt.payer.toLowerCase(), pool.address.toLowerCase());
            assert.equal(receipt.frameReceipts[0].status, "0x1");
            const actualFee = BigInt(receipt.gasUsed) * BigInt(receipt.effectiveGasPrice);
            assert.ok(actualFee <= intent.gasCharge);
            const spent = await publicClient.readContract({ address: pool.address, abi: poolAbi, functionName: "nullifierSpent", args: [notes[0].nullifierHash] });
            const failed = harness && attempt === 0;
            const poolAfter = await publicClient.getBalance({ address: pool.address });
            if (failed) {
                assert.equal(receipt.frameReceipts[1].status, "0x0");
                assert.equal(spent, false);
                assert.equal(poolBefore - poolAfter, actualFee);
                assert.equal(await publicClient.getBalance({ address: recipient }), recipientBefore);
                actualFailedFee = actualFee;
                const enable = await walletClient.sendTransaction({ to: pool.address, data: encodeFunctionData({ abi: parseAbi(['function enableDelivery()']), functionName: 'enableDelivery' }) });
                assert.equal((await waitForReceipt(publicClient, enable)).status, "0x1");
            } else {
                assert.equal(receipt.frameReceipts[1].status, "0x1");
                assert.equal(spent, true);
                const expectedPayout = D - nonceSeq * MAX_GAS_CHARGE - intent.gasCharge;
                assert.equal((await publicClient.getBalance({ address: recipient })) - recipientBefore, expectedPayout);
                assert.equal(poolBefore - poolAfter, expectedPayout + actualFee);
                const expectedSurplus = nonceSeq * MAX_GAS_CHARGE - actualFailedFee + intent.gasCharge - actualFee;
                assert.equal(poolAfter, D + expectedSurplus, "other note remains fully backed");
            }
            report.runs.push({ harness, attempt, hash, failed, provingMs: result.provingMs,
                reservedWei: intent.gasCharge, actualFeeWei: actualFee, gasUsed: receipt.gasUsed,
                effectiveGasPrice: receipt.effectiveGasPrice, proofBytes: (result.encoded.length - 2) / 2,
                verifyExecutionGas: BigInt(receipt.frameReceipts[0].gasUsed.execution), frameReceipts: receipt.frameReceipts });
            console.log(`PASS ${failed ? 'included delivery failure; note remains unspent' : 'real ZK ETH withdrawal'}: nonce=${nonceSeq}, prove=${result.provingMs}ms`);
        }
    }
    writeFileSync(resolve(buildDir, 'e2e-report.json'), JSON.stringify(report, (_, value) => typeof value === 'bigint' ? value.toString() : value, 2));
    console.log('PASS real proof, cross-language roots, pool payer, retry and reserve conservation');
}
main().then(() => process.exit(0)).catch(error => { console.error(error); process.exit(1); });
