// Test-only software authenticator: private keys never enter the browser SDK.
import { generateKeyPairSync, createHash, sign, type KeyObject } from 'node:crypto';
import { bytesToHex, type Hex } from 'viem';
import { parseDerSignature, parseSpki, type Assertion } from './sdk.js';
export const RP = 'wallet.example.com';
export const ORIGIN = `https://${RP}`;
export const rpHash = bytesToHex(createHash('sha256').update(RP).digest());
export function makeKey() {
    const { privateKey, publicKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
    return { privateKey, publicKey, ...parseSpki(publicKey.export({ type: 'spki', format: 'der' })) };
}
export function makeAssertion(challenge: Hex, key: KeyObject, overrides: { rp?: string; flags?: number; json?: string; crossOrigin?: boolean } = {}): Assertion {
    const auth = Buffer.concat([createHash('sha256').update(overrides.rp ?? RP).digest(), Buffer.from([overrides.flags ?? 5, 0, 0, 0, 0])]);
    const json = overrides.json ?? JSON.stringify({ type: 'webauthn.get', challenge: Buffer.from(challenge.slice(2), 'hex').toString('base64url'), origin: ORIGIN, crossOrigin: overrides.crossOrigin ?? false });
    const raw = Buffer.concat([auth, createHash('sha256').update(json).digest()]);
    return { authenticatorData: bytesToHex(auth), clientDataJSON: bytesToHex(Buffer.from(json)), ...parseDerSignature(sign('sha256', raw, key)) };
}
