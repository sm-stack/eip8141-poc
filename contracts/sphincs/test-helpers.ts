/** PUBLIC deterministic test keys only. This CLI transport is not key custody. */
import {execFileSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {keccak256, toHex, type Hex} from 'viem';
import {type PublicKey} from './sdk.js';
const bin=fileURLToPath(new URL('./vendor/signer-wasm/target/release/signer-c13',import.meta.url));
export type TestKey=PublicKey & {sk_seed:Hex};
export function makeKey(label:string):TestKey {
 return JSON.parse(execFileSync(bin,['keygen',keccak256(toHex(`PUBLIC C13 TEST KEY: ${label}`))],{encoding:'utf8',stdio:['ignore','pipe','pipe']}));
}
export function sign(message:Hex,key:TestKey):Hex {
 return execFileSync(bin,['sign-with',key.seed,key.sk_seed,key.root,message],{encoding:'utf8',stdio:['ignore','pipe','pipe']}).trim() as Hex;
}
