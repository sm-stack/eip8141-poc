import { randomBytes, createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildPoseidon } from 'circomlibjs';
import * as snarkjs from 'snarkjs';
import { encodeAbiParameters, encodeFunctionData, keccak256, parseAbi, parseAbiParameters, toHex } from 'viem';
import { getFrameTransactionGas } from 'viem/eip8141';

export const FIELD = 21888242871839275222246405745257275088548364400416034343698204186575808495617n;
export const DEPTH = 20;
export const MAX_GAS_CHARGE = 1_000_000_000_000_000n;
// Leaves about 2.4k gas above the measured first-use paths (229,861/229,883).
export const VERIFY_GAS = 232_300n;
export const VERIFY_STATE_GAS = 100_000n;
export const EXECUTE_GAS = 200_000n;
export const EXECUTE_STATE_GAS = 800_000n;
export const buildDir = resolve(dirname(fileURLToPath(import.meta.url)), '../build');
export const poolAbi = parseAbi([
    'constructor(address hasher, uint256 denomination)',
    'function deposit(bytes32 commitment) payable returns (uint64 leafIndex, bytes32 root)',
    'function currentRoot() view returns (bytes32)',
    'function acceptedRoots(bytes32) view returns (bool)',
    'function nullifierSpent(bytes32) view returns (bool)',
    'function withdrawalAmount(uint64 nonceSeq, uint256 gasCharge) view returns (uint256)',
    'function withdrawStatementHash((bytes32 root, bytes32 nullifierHash, address recipient, uint64 nonceSeq, uint256 maxGasCharge, uint256 gasCharge, uint256 verifyGasLimit, uint256 maxPriorityFeePerGas, uint256 maxFeePerGas) intent) view returns (bytes32)',
    'function validateWithdrawal(bytes proof, (bytes32 root, bytes32 nullifierHash, address recipient, uint64 nonceSeq, uint256 maxGasCharge, uint256 gasCharge, uint256 verifyGasLimit, uint256 maxPriorityFeePerGas, uint256 maxFeePerGas) intent) view',
    'function executeWithdrawal(bytes32 nullifierHash, address recipient, uint64 nonceSeq, uint256 gasCharge)',
    'event Deposit(bytes32 indexed commitment, uint64 indexed leafIndex, bytes32 root)',
    'event Withdrawal(bytes32 indexed nullifierHash, address indexed recipient, uint256 amount, uint256 gasCharge, uint256 failedAttemptCharge)',
]);
const DOMAIN = keccak256(toHex('privacy-pool-8141.nullifier.v2'));
const TYPEHASH = keccak256(toHex('WithdrawalStatementV2(uint256 chainId,address pool,uint256 denomination,bytes32 root,bytes32 nullifierHash,address recipient,uint64 nonceSeq,uint256 maxGasCharge)'));
let poseidonPromise;
export async function poseidon(values) {
    poseidonPromise ??= buildPoseidon();
    const p = await poseidonPromise;
    return p.F.toObject(p(values));
}
export function bytes32(n) { return toHex(BigInt(n), { size: 32 }); }
function scalar(n) {
    n = BigInt(n);
    if (n < 0n || n >= FIELD) throw new Error('Noncanonical field element');
    return n;
}
function randomScalar() {
    for (;;) {
        const n = BigInt(`0x${randomBytes(32).toString('hex')}`);
        if (n > 0n && n < FIELD) return n;
    }
}
export async function createNote() { return noteFromSecrets(randomScalar(), randomScalar()); }
export async function noteFromSecrets(secret, nullifierSecret) {
    secret = scalar(secret); nullifierSecret = scalar(nullifierSecret);
    if (secret === 0n || nullifierSecret === 0n) throw new Error('Zero note secret');
    return { version: 2, secret, nullifierSecret,
        commitment: bytes32(await poseidon([1n, nullifierSecret, secret])),
        nullifierHash: bytes32(await poseidon([2n, nullifierSecret])),
    };
}

// Reconstruct from canonical Deposit events in (block, tx, log) order. Reorg
// handling belongs to the caller: replay canonical events into a new tree.
export class CommitmentTree {
    static async create() {
        const tree = new CommitmentTree();
        tree.zeros = [0n];
        tree.nodes = Array.from({ length: DEPTH + 1 }, () => new Map());
        tree.count = 0; tree.seen = new Set();
        for (let i = 0; i < DEPTH; i++) tree.zeros.push(await poseidon([tree.zeros[i], tree.zeros[i]]));
        return tree;
    }
    get root() { return bytes32(this.nodes[DEPTH].get(0) ?? this.zeros[DEPTH]); }
    async insert(commitment) {
        const leaf = scalar(commitment);
        if (leaf === 0n || this.seen.has(leaf.toString())) throw new Error('Zero or duplicate commitment');
        if (this.count >= 2 ** DEPTH) throw new Error('Tree full');
        const leafIndex = this.count++;
        this.seen.add(leaf.toString());
        let index = leafIndex;
        this.nodes[0].set(index, leaf);
        for (let level = 0; level < DEPTH; level++) {
            const left = index & ~1;
            const parent = await poseidon([
                this.nodes[level].get(left) ?? this.zeros[level],
                this.nodes[level].get(left + 1) ?? this.zeros[level],
            ]);
            index >>= 1; this.nodes[level + 1].set(index, parent);
        }
        return { leafIndex, root: this.root };
    }
    path(leafIndex) {
        if (!Number.isInteger(leafIndex) || leafIndex < 0 || leafIndex >= this.count) throw new Error('Unknown leaf');
        let index = leafIndex;
        const siblings = [];
        for (let level = 0; level < DEPTH; level++) {
            siblings.push(this.nodes[level].get(index ^ 1) ?? this.zeros[level]); index >>= 1;
        }
        return { leafIndex, siblings, root: this.root };
    }
}
export function statementHash(chainId, pool, denomination, intent) {
    return keccak256(encodeAbiParameters(
        parseAbiParameters('bytes32,uint256,address,uint256,bytes32,bytes32,address,uint64,uint256'),
        [TYPEHASH, BigInt(chainId), pool, denomination, intent.root, intent.nullifierHash, intent.recipient, intent.nonceSeq, intent.maxGasCharge],
    ));
}
export function nonceKey(nullifierHash) {
    const key = BigInt(keccak256(encodeAbiParameters(parseAbiParameters('bytes32,bytes32'), [DOMAIN, nullifierHash])));
    return key === 0n ? 1n : key;
}
export function nonceStorageSlot(pool, nullifierHash) {
    return keccak256(encodeAbiParameters(parseAbiParameters('address,uint256'), [pool, nonceKey(nullifierHash)]));
}
export function verifyArtifacts() {
    const manifest = JSON.parse(readFileSync(resolve(buildDir, 'manifest.json')));
    const hash = (p) => createHash('sha256').update(readFileSync(p)).digest('hex');
    if (manifest.sourceHash !== hash(resolve(buildDir, '../circuits/withdraw.circom')) ||
        manifest.lockHash !== hash(resolve(buildDir, '../../package-lock.json')) ||
        manifest.scriptHash !== hash(resolve(buildDir, '../scripts/setup.mjs'))) throw new Error('Build inputs changed: rerun privacy:setup');
    for (const [p, h] of Object.entries(manifest.contractHashes)) {
        if (hash(resolve(buildDir, '../..', p)) !== h) throw new Error(`Contract changed: rerun privacy:setup (${p})`);
    }
    for (const [p, h] of Object.entries(manifest.files)) {
        if (hash(resolve(buildDir, p)) !== h) throw new Error(`Artifact integrity mismatch: ${p}`);
    }
    return manifest;
}
export async function proveWithdrawal(note, path, context) {
    verifyArtifacts();
    const digest = BigInt(context);
    const input = {
        root: scalar(path.root), nullifierHash: scalar(note.nullifierHash),
        context: digest % FIELD,
        secret: scalar(note.secret), nullifierSecret: scalar(note.nullifierSecret),
        leafIndex: path.leafIndex, siblings: path.siblings,
    };
    const start = performance.now();
    const { proof, publicSignals } = await snarkjs.groth16.fullProve(input,
        resolve(buildDir, 'O2/withdraw_js/withdraw.wasm'), resolve(buildDir, 'withdraw.zkey'),
        undefined, undefined, { singleThread: true });
    const calldata = JSON.parse(`[${await snarkjs.groth16.exportSolidityCallData(proof, publicSignals)}]`);
    const encoded = encodeAbiParameters(parseAbiParameters('uint256[2],uint256[2][2],uint256[2]'),
        [calldata[0].map(BigInt), calldata[1].map(row => row.map(BigInt)), calldata[2].map(BigInt)]);
    return { encoded, proof, publicSignals, provingMs: Math.round(performance.now() - start) };
}
export function buildWithdrawalTransaction(chainId, pool, proof, intent) {
    return {
        type: 'frame', chainId: Number(chainId), sender: pool,
        nonceKeys: [nonceKey(intent.nullifierHash)], nonceSeq: intent.nonceSeq,
        signatures: [], recentRootReferences: [],
        maxPriorityFeePerGas: intent.maxPriorityFeePerGas, maxFeePerGas: intent.maxFeePerGas,
        frames: [
            { mode: 'verify', flags: 3, target: null, gasLimit: intent.verifyGasLimit, stateGasLimit: VERIFY_STATE_GAS,
                value: 0n, data: encodeFunctionData({ abi: poolAbi, functionName: 'validateWithdrawal', args: [proof, intent] }) },
            { mode: 'sender', flags: 0, target: null, gasLimit: EXECUTE_GAS, stateGasLimit: EXECUTE_STATE_GAS,
                value: 0n, data: encodeFunctionData({ abi: poolAbi, functionName: 'executeWithdrawal',
                    args: [intent.nullifierHash, intent.recipient, intent.nonceSeq, intent.gasCharge] }) },
        ],
    };
}
export function settleGasCharge(chainId, pool, proof, initialIntent, denomination) {
    for (let bump = 0n; bump < 64n; bump++) {
        let intent = { ...initialIntent, gasCharge: 0n, maxFeePerGas: initialIntent.maxFeePerGas + bump };
        const seen = new Set();
        for (let i = 0; i < 32; i++) {
            const tx = buildWithdrawalTransaction(chainId, pool, proof, intent);
            const charge = getFrameTransactionGas(tx) * intent.maxFeePerGas;
            if (charge > intent.maxGasCharge || charge > MAX_GAS_CHARGE) throw new Error('Gas reservation exceeds note authorization');
            if (intent.nonceSeq * MAX_GAS_CHARGE + charge >= denomination) throw new Error('Retry budget exhausted');
            if (charge === intent.gasCharge) return intent;
            if (seen.has(charge)) break;
            seen.add(charge); intent = { ...intent, gasCharge: charge };
        }
    }
    throw new Error('Gas reservation did not converge within bounded fee adjustments');
}
