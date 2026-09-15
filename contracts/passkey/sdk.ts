import { encodeAbiParameters, encodeFunctionData, keccak256, parseAbi, parseAbiParameters, bytesToHex, hexToBytes, type Address, type Hex } from 'viem';
import { type TransactionSerializableFrame } from 'viem/eip8141';

export const MAX_GAS_CHARGE = 10_000_000_000_000_000n; // Explicit signed ceiling: 0.01 ETH.
export const VERIFY_GAS = 35_000n;
export const KEYED_VERIFY_GAS = 55_000n; // Includes first-use keyed nonce surcharge.
export const accountAbi = parseAbi([
    'constructor(uint256 x,uint256 y,bytes32 rpHash,string origin,address recoveryGuardian,uint256 delay)',
    'function validate(uint256 x,uint256 y,uint64 epoch,uint256 maxGasCharge,(bytes authenticatorData,bytes clientDataJSON,uint256 r,uint256 s) assertion) view',
    'function execute(address target,uint256 value,bytes data) returns (bytes)',
    'function executeBatch((address target,uint256 value,bytes data)[] calls)',
    'function rotateOwner(uint256 x,uint256 y)',
    'function ownerEpoch() view returns (uint64)',
    'function ownerCommitment() view returns (bytes32)',
    'function rpIdHash() view returns (bytes32)',
    'function suffixHash() view returns (bytes32)',
    'function legacySuffixHash() view returns (bytes32)',
    'function guardian() view returns (address)',
    'function recoveryDelay() view returns (uint256)',
    'function pendingRecovery() view returns (bytes32)',
    'function recoveryReadyAt() view returns (uint256)',
    'function scheduleRecovery(uint256 x,uint256 y)',
    'function cancelRecovery()',
    'function finalizeRecovery(uint256 x,uint256 y)',
    'function challenge(bytes32 envelopeHash,uint64 epoch,uint256 maxGasCharge) view returns (bytes32)',
]);
const domain = keccak256(new TextEncoder().encode('8141.passkey.transaction.v1'));
const N = 0xffffffff00000000ffffffffffffffffbce6faada7179e84f3b9cac2fc632551n;
export type Credential = { id: string; x: bigint; y: bigint; rpId: string; origin: string };
export type KeyedFrame = Extract<TransactionSerializableFrame, { nonceKeys: bigint[] }>;
export type Assertion = { authenticatorData: Hex; clientDataJSON: Hex; r: bigint; s: bigint };

export function validatePolicy(rpId: string, origin: string) {
    const url = new URL(origin);
    if (url.protocol !== 'https:' || url.origin !== origin || url.username || url.password || origin.length > 200
        || rpId !== rpId.toLowerCase() || !rpId || /[^a-z0-9.-]/.test(rpId)
        || !(url.hostname === rpId || url.hostname.endsWith(`.${rpId}`))) throw new Error('Invalid RP ID or origin');
    // The browser additionally enforces registrable-domain/public-suffix rules.
}

export function assertionChallenge(tx: TransactionSerializableFrame, epoch: bigint, maxGasCharge = MAX_GAS_CHARGE): Hex {
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

export function attachAssertion<T extends TransactionSerializableFrame>(tx: T, key: Pick<Credential, 'x' | 'y'>, epoch: bigint, assertion: Assertion, maxGasCharge = MAX_GAS_CHARGE): T {
    const data = encodeFunctionData({ abi: accountAbi, functionName: 'validate', args: [key.x, key.y, epoch, maxGasCharge, assertion] });
    return { ...tx, frames: [{ ...tx.frames[0], data }, ...tx.frames.slice(1)] };
}

export function parseDerSignature(input: Uint8Array): { r: bigint; s: bigint } {
    if (input.length < 8 || input.length > 72 || input[0] !== 0x30 || input[1] !== input.length - 2) throw new Error('Invalid DER sequence');
    let offset = 2;
    const scalar = () => {
        if (input[offset++] !== 2) throw new Error('Invalid DER integer');
        const length = input[offset++];
        if (!length || length > 33 || offset + length > input.length) throw new Error('Invalid DER length');
        const b = input.slice(offset, offset + length); offset += length;
        if (b[0] & 0x80 || (length > 1 && b[0] === 0 && !(b[1] & 0x80))) throw new Error('Noncanonical DER integer');
        const v = BigInt(bytesToHex(b));
        if (v === 0n || v >= N) throw new Error('Invalid P256 scalar');
        return v;
    };
    const r = scalar(), s = scalar();
    if (offset !== input.length) throw new Error('Trailing DER bytes');
    return { r, s };
}

export function parseSpki(input: Uint8Array): { x: bigint; y: bigint } {
    const prefix = '3059301306072a8648ce3d020106082a8648ce3d03010703420004';
    if (input.length !== 91 || bytesToHex(input.slice(0, 27)).slice(2) !== prefix) {
        // SPKI header includes the uncompressed-point marker; prefix is 27 bytes.
        throw new Error('Expected P256 uncompressed SPKI');
    }
    return { x: BigInt(bytesToHex(input.slice(27, 59))), y: BigInt(bytesToHex(input.slice(59))) };
}

const base64url = (bytes: Uint8Array) => btoa(String.fromCharCode(...bytes)).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '');
const fromBase64url = (s: string) => Uint8Array.from(atob(s.replaceAll('-', '+').replaceAll('_', '/')), c => c.charCodeAt(0));

export function parseAssertion(response: { authenticatorData: ArrayBuffer; clientDataJSON: ArrayBuffer; signature: ArrayBuffer },
    challenge: Hex, credential: Credential): Assertion {
    const json = new TextDecoder('utf-8', { fatal: true }).decode(response.clientDataJSON);
    const base = { type: 'webauthn.get', challenge: base64url(hexToBytes(challenge)), origin: credential.origin };
    if (json !== JSON.stringify(base) && json !== JSON.stringify({ ...base, crossOrigin: false })) throw new Error('Unsupported clientDataJSON profile');
    const authenticatorData = new Uint8Array(response.authenticatorData);
    const flags = authenticatorData[32];
    if (authenticatorData.length !== 37 || (flags & 5) !== 5 || (flags & 0xe2) !== 0 || ((flags & 16) !== 0 && (flags & 8) === 0)) throw new Error('Unsupported authenticator flags');
    return { authenticatorData: bytesToHex(authenticatorData), clientDataJSON: bytesToHex(new Uint8Array(response.clientDataJSON)),
        ...parseDerSignature(new Uint8Array(response.signature)) };
}

/** Compute explicit direct-deployment constructor arguments from registered key metadata. */
export async function deploymentArgs(credential: Credential, guardian: Address, recoveryDelay: bigint) {
    validatePolicy(credential.rpId, credential.origin);
    const disabled = guardian.toLowerCase() === '0x0000000000000000000000000000000000000000';
    if (disabled ? recoveryDelay !== 0n : recoveryDelay < 172800n || recoveryDelay > 2592000n) throw new Error('Invalid recovery policy');
    const rpHash = bytesToHex(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(credential.rpId))));
    return [credential.x, credential.y, rpHash, credential.origin, guardian, recoveryDelay] as const;
}

export async function registerPasskey(rpId: string, origin: string, user: { id: Uint8Array; name: string; displayName: string }): Promise<Credential> {
    validatePolicy(rpId, origin);
    if (location.origin !== origin) throw new Error('Registration origin mismatch');
    const credential = await navigator.credentials.create({ publicKey: {
        challenge: crypto.getRandomValues(new Uint8Array(32)), rp: { id: rpId, name: rpId }, user: { ...user, id: Uint8Array.from(user.id) },
        pubKeyCredParams: [{ type: 'public-key', alg: -7 }], attestation: 'none',
        authenticatorSelection: { residentKey: 'required', userVerification: 'required' }, timeout: 60_000,
    } }) as PublicKeyCredential | null;
    if (!credential) throw new Error('Registration cancelled');
    const response = credential.response as AuthenticatorAttestationResponse;
    const spki = response.getPublicKey();
    if (!spki || response.getPublicKeyAlgorithm() !== -7) throw new Error('Expected ES256 credential');
    return { id: credential.id, ...parseSpki(new Uint8Array(spki)), rpId, origin };
}

export async function signTransaction(tx: TransactionSerializableFrame, epoch: bigint, credential: Credential, maxGasCharge = MAX_GAS_CHARGE): Promise<TransactionSerializableFrame> {
    validatePolicy(credential.rpId, credential.origin);
    if (location.origin !== credential.origin) throw new Error('Authentication origin mismatch');
    const challenge = assertionChallenge(tx, epoch, maxGasCharge);
    const result = await navigator.credentials.get({ publicKey: {
        challenge: Uint8Array.from(hexToBytes(challenge)), rpId: credential.rpId, userVerification: 'required',
        allowCredentials: [{ id: fromBase64url(credential.id), type: 'public-key' }], timeout: 60_000,
    } }) as PublicKeyCredential | null;
    if (!result || result.id !== credential.id) throw new Error('Unexpected or cancelled credential');
    const response = result.response as AuthenticatorAssertionResponse;
    const rpHash = bytesToHex(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(credential.rpId))));
    if (bytesToHex(new Uint8Array(response.authenticatorData).slice(0, 32)) !== rpHash) throw new Error('RP ID hash mismatch');
    return attachAssertion(tx, credential, epoch, parseAssertion(response, challenge, credential), maxGasCharge);
}
