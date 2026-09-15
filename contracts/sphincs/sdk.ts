import { encodeAbiParameters, encodeFunctionData, keccak256, parseAbi, parseAbiParameters, type Address, type Hex } from 'viem';
import { type TransactionSerializableFrame } from 'viem/eip8141';
export const MAX_GAS_CHARGE = 10_000_000_000_000_000n;
export const VERIFY_GAS = 99_999n;
export const KEYED_VERIFY_GAS = 99_999n;
export type KeyedFrame = Extract<TransactionSerializableFrame, { nonceKeys: bigint[] }>;
export type PublicKey = {seed: Hex; root: Hex};
const domain = keccak256(new TextEncoder().encode('8141.c13.transaction.v1'));
export const accountAbi = parseAbi([
 'constructor(bytes32 seed,bytes32 root)',
 'function validate(bytes32 seed,bytes32 root,uint64 epoch,uint256 maxGasCharge,bytes signature) view',
 'function execute(address target,uint256 value,bytes data) returns (bytes)',
 'function executeBatch((address target,uint256 value,bytes data)[] calls)',
 'function rotateOwner(bytes32 seed,bytes32 root)',
 'function ownerEpoch() view returns (uint64)',
 'function ownerCommitment() view returns (bytes32)',
 'function verifier() view returns (address)',
 'function challenge(bytes32 envelopeHash,uint64 epoch,uint256 maxGasCharge) view returns (bytes32)',
]);
export function signatureChallenge(tx: TransactionSerializableFrame, epoch: bigint, maxGasCharge = MAX_GAS_CHARGE): Hex {
    if (tx.frames.length !== 2 || tx.frames[0].mode !== 'verify' || tx.frames[0].flags !== 3
        || tx.frames[1].mode !== 'sender' || (tx.frames[1].flags ?? 0) !== 0
        || tx.frames.some(f => (f.target !== null && f.target.toLowerCase() !== tx.sender.toLowerCase()) || (f.value ?? 0n) !== 0n)
        || tx.signatures.length !== 0 || tx.recentRootReferences.length !== 0 || (tx.blobVersionedHashes?.length ?? 0) !== 0
        || (tx.maxFeePerBlobGas ?? 0n) !== 0n || (tx.frames[1].data.length - 2) / 2 > 16384 || maxGasCharge <= 0n) throw new Error('Unsupported signing envelope');
    const keys = tx.nonceKeys ?? [0n];
    if (keys.length !== 1) throw new Error('Exactly one nonce key required');
    const keysHash = keccak256(encodeAbiParameters(parseAbiParameters('uint256,uint256'), [1n, keys[0]]));
    const envelopeHash = keccak256(encodeAbiParameters(parseAbiParameters('bytes32,uint256,uint256,uint256,uint256,uint256,uint256,uint256,bytes32'),
        [keysHash, tx.nonceSeq ?? BigInt(tx.nonce!), tx.maxPriorityFeePerGas ?? 0n, tx.maxFeePerGas ?? 0n,
            tx.frames[0].gasLimit, tx.frames[0].stateGasLimit ?? 0n, tx.frames[1].gasLimit, tx.frames[1].stateGasLimit ?? 0n, keccak256(tx.frames[1].data)]));
    return keccak256(encodeAbiParameters(parseAbiParameters('bytes32,uint256,address,bytes32,uint64,uint256'),
        [domain, BigInt(tx.chainId), tx.sender, envelopeHash, epoch, maxGasCharge]));
}

export function buildTransaction(args: { chainId: number; sender: Address; nonceSeq: bigint; nonceKey?: bigint;
    executionData: Hex; maxFeePerGas: bigint; maxPriorityFeePerGas: bigint; executionGas?: bigint; stateGas?: bigint }): KeyedFrame {
    return { type: 'frame', chainId: args.chainId, sender: args.sender, nonceKeys: [args.nonceKey ?? 0n], nonceSeq: args.nonceSeq,
        maxFeePerGas: args.maxFeePerGas, maxPriorityFeePerGas: args.maxPriorityFeePerGas, signatures: [], recentRootReferences: [],
        frames: [
            { mode: 'verify', flags: 3, target: null, gasLimit: (args.nonceKey ?? 0n) === 0n ? VERIFY_GAS : KEYED_VERIFY_GAS, stateGasLimit: 100_000n, data: '0x' },
            { mode: 'sender', flags: 0, target: null, gasLimit: args.executionGas ?? 300_000n, stateGasLimit: args.stateGas ?? 1_000_000n, data: args.executionData },
        ] };
}

export function attachSignature<T extends TransactionSerializableFrame>(tx: T, key: PublicKey, epoch: bigint, signature: Hex, maxGasCharge = MAX_GAS_CHARGE): T {
    if (!/^0x[0-9a-fA-F]{7376}$/.test(signature)) throw new Error('C13 signature must be exactly 3688 bytes');
    const data = encodeFunctionData({ abi: accountAbi, functionName: 'validate', args: [key.seed, key.root, epoch, maxGasCharge, signature] });
    return { ...tx, frames: [{ ...tx.frames[0], data }, ...tx.frames.slice(1)] };
}
