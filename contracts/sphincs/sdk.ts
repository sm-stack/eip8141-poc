import { encodeAbiParameters, encodeFunctionData, keccak256, parseAbi, parseAbiParameters, zeroAddress, type Address, type Hex } from 'viem';
import { computeSigHash, type TransactionSerializableFrame } from 'viem/eip8141';
// The ARBITRARY signature entry costs 100 signature gas, which counts toward
// MAX_VERIFY_GAS together with the declared VERIFY execution gas.
export const SIGNATURE_ENTRY_GAS = 100n;
export const VERIFY_GAS = 99_999n - SIGNATURE_ENTRY_GAS;
export const KEYED_VERIFY_GAS = VERIFY_GAS;
export const SIGNATURE_BYTES = 3688;
export type KeyedFrame = Extract<TransactionSerializableFrame, { nonceKeys: bigint[] }>;
export type PublicKey = {seed: Hex; root: Hex};
const domain = keccak256(new TextEncoder().encode('8141.c13.transaction.v2'));
export const accountAbi = parseAbi([
 'constructor(bytes32 seed,bytes32 root)',
 'function validate(bytes32 seed,bytes32 root,uint64 epoch) view',
 'function execute(address target,uint256 value,bytes data) returns (bytes)',
 'function executeBatch((address target,uint256 value,bytes data)[] calls)',
 'function rotateOwner(bytes32 seed,bytes32 root)',
 'function ownerEpoch() view returns (uint64)',
 'function ownerCommitment() view returns (bytes32)',
 'function verifier() view returns (address)',
 'function challenge(bytes32 sigHash) pure returns (bytes32)',
]);
/** The C13 witness travels as the transaction's single ARBITRARY signature entry. */
const witness = (signature: Hex) => ({ scheme: 0 as const, signer: zeroAddress, msg: '0x' as Hex, signature });

/**
 * Message the C13 key signs. The canonical signature hash elides the bytes of
 * empty-message signature entries, so it covers the whole transaction (chain,
 * sender, nonce, fees, both frames including the key and epoch in VERIFY
 * calldata) without covering the witness itself.
 */
export function signatureChallenge(tx: TransactionSerializableFrame): Hex {
    if (tx.frames.length !== 2 || tx.frames[0].mode !== 'verify' || tx.frames[0].flags !== 3
        || tx.frames[1].mode !== 'sender' || (tx.frames[1].flags ?? 0) !== 0
        || tx.frames.some(f => (f.target !== null && f.target.toLowerCase() !== tx.sender.toLowerCase()) || (f.value ?? 0n) !== 0n)
        || tx.signatures.length !== 1 || tx.signatures[0].scheme !== 0 || tx.signatures[0].msg !== '0x'
        || tx.recentRootReferences.length !== 0 || (tx.blobVersionedHashes?.length ?? 0) !== 0
        || (tx.maxFeePerBlobGas ?? 0n) !== 0n || (tx.frames[1].data.length - 2) / 2 > 16384
        || (tx.frames[0].data.length - 2) / 2 !== 100) throw new Error('Unsupported signing envelope');
    if ((tx.nonceKeys ?? [0n]).length !== 1) throw new Error('Exactly one nonce key required');
    return keccak256(encodeAbiParameters(parseAbiParameters('bytes32,bytes32'), [domain, computeSigHash(tx)]));
}

export function buildTransaction(args: { chainId: number; sender: Address; key: PublicKey; epoch: bigint; nonceSeq: bigint; nonceKey?: bigint;
    executionData: Hex; maxFeePerGas: bigint; maxPriorityFeePerGas: bigint; executionGas?: bigint; stateGas?: bigint }): KeyedFrame {
    const data = encodeFunctionData({ abi: accountAbi, functionName: 'validate', args: [args.key.seed, args.key.root, args.epoch] });
    return { type: 'frame', chainId: args.chainId, sender: args.sender, nonceKeys: [args.nonceKey ?? 0n], nonceSeq: args.nonceSeq,
        maxFeePerGas: args.maxFeePerGas, maxPriorityFeePerGas: args.maxPriorityFeePerGas, signatures: [witness('0x')], recentRootReferences: [],
        frames: [
            { mode: 'verify', flags: 3, target: null, gasLimit: (args.nonceKey ?? 0n) === 0n ? VERIFY_GAS : KEYED_VERIFY_GAS, stateGasLimit: 100_000n, data },
            { mode: 'sender', flags: 0, target: null, gasLimit: args.executionGas ?? 300_000n, stateGasLimit: args.stateGas ?? 1_000_000n, data: args.executionData },
        ] };
}

export function attachSignature<T extends TransactionSerializableFrame>(tx: T, signature: Hex): T {
    if (!new RegExp(`^0x[0-9a-fA-F]{${SIGNATURE_BYTES * 2}}$`).test(signature)) throw new Error('C13 signature must be exactly 3688 bytes');
    if (tx.signatures.length !== 1 || tx.signatures[0].scheme !== 0 || tx.signatures[0].msg !== '0x') throw new Error('Unsupported signing envelope');
    return { ...tx, signatures: [witness(signature)] };
}
