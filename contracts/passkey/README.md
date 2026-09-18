# P-256 / WebAuthn account for EIP-8141

`PasskeyAccount8141` is a directly deployed, self-paying Solidity account. It supports ES256 WebAuthn assertions, a rotatable owner, atomic calls/batches and optional delayed recovery. The P-256 signature is an EIP-8141 protocol-validated signature entry: the protocol verifies it before any frame runs, and the VERIFY frame checks only the WebAuthn ceremony, its binding to the transaction, and the owner. No cryptography runs inside the frame, and its single mutable read is `ownerCommitment`. No separate Yul module, proxy, external verifier or mock cryptography is used on this path.

This is an implementation and test baseline for the experimental 8141 compiler/geth fork, **not an audited production release**. The older Coinbase example and `src/lib/WebAuthn.sol` are unchanged and are not the verifier used here.

## Authorization

The account accepts exactly two frames:

1. VERIFY, target=self, flags=3, value=0: validate the complete envelope, check the WebAuthn ceremony, require the signature entry's explicit `msg` to equal the ceremony digest, compare the entry's signer/epoch commitment with storage, APPROVE execution and payment.
2. SENDER, target=self, flags=0, value=0: invoke `execute`, `executeBatch`, `rotateOwner` or `cancelRecovery`. Transfer values live inside the signed execution calldata.

Exactly one transaction-level signature entry is required: scheme `P256`, signer `keccak256(qx || qy)[12:]`, `msg = sha256(authenticatorData || sha256(clientDataJSON))`, signature `r || s || qx || qy` with low-S. No recent roots, blobs, deployment frames or external payer frames are accepted. Exactly one nonce key is required. `[0]` uses the account nonce; nonzero keys support independent sequences and incur geth's 20,000 first-use surcharge. Included execution failure still consumes the protocol nonce and pays gas; it does not change the owner. Re-sign with the next sequence.

### Explicit signed envelope

WebAuthn fixes the signed message: an authenticator signs `sha256(authenticatorData || sha256(clientDataJSON))`, never a transaction hash. The signature entry therefore carries that digest as an explicit `msg`. EIP-8141 elides signature bytes from the canonical `sigHash` only for empty-message entries, so an explicit-message entry stays inside the hash and the hash cannot be the ceremony's challenge. The challenge instead commits to:

```
nonceKeysHash = keccak256(abi.encode(uint256(1), nonceKey))
envelopeHash  = keccak256(abi.encode(
    nonceKeysHash, nonceSeq, maxPriorityFeePerGas, maxFeePerGas,
    verifyExecutionGas, verifyStateGas, senderExecutionGas, senderStateGas,
    keccak256(senderCalldata)
))
challenge = keccak256(abi.encode(
    keccak256("8141.passkey.transaction.v1"), chainId, account,
    envelopeHash, ownerEpoch, maxGasCharge
))
```

The remaining envelope fields are pinned by the contract. The VERIFY calldata must exactly equal its canonical ABI re-encoding and be at most 1,024 bytes; SENDER calldata is at most 16,384 bytes. A signed `maxGasCharge` must cover `TXPARAM(max_cost)`. The SDK default cap is explicitly 0.01 ETH and can be overridden at signing; it is a ceiling, not a fixed fee. The protocol refunds unused reservation to the account. Both frame execution/state budgets and the fee caps are signed, so changing them requires a fresh assertion.

## WebAuthn profile

- Curve: ES256/P-256, verified by the protocol as an EIP-8141 `P256` signature entry (6,700 signature gas, charged outside the frame). The account never calls the `0x100` precompile. `StrictWebAuthn.verifyP256` remains as a library path with exact success/return-length checks and no software fallback, and is exercised by the Forge tests only.
- RP ID hash and accepted origin suffixes are immutable. The SDK validates HTTPS origin/domain correspondence, and the browser enforces RP/public-suffix rules during registration/authentication. Deployment constructor arguments remain security-critical.
- Authenticator data is exactly 37 bytes: RP hash, flags and counter. UP and UV must both be set. Invalid backup-flag combinations, reserved bits, attestation data and extensions are rejected.
- Client JSON must be exactly one of these two UTF-8 serializations, with the expected base64url challenge and deployment origin:

```json
{"type":"webauthn.get","challenge":"<43-character challenge>","origin":"https://wallet.example.com","crossOrigin":false}
```

or the same object with `crossOrigin` omitted. Additional fields, alternative ordering/whitespace/escaping, duplicate keys, cross-origin/topOrigin and embedded objects are rejected. This is a deliberately limited interoperability profile, **not support for every valid WebAuthn serialization or extension**. The SDK fails before submitting unsupported client JSON; browser/authenticator compatibility must be validated for the intended deployment.

The protocol scheme accepts low-S signatures only. Authenticators may emit either form, so the SDK normalizes `s` to `n - s` when needed; both forms verify under ECDSA. Transaction nonce and key epoch provide replay protection; signature bytes are not used as a replay identifier. The authenticator sign counter is authenticated but not required to increase: synced passkeys may report zero/non-monotonic counters. This account does not offer clone detection based on that counter. Registration requests ES256, resident credentials, UV and no attestation; no hardware provenance claim is made.

Sources: [W3C WebAuthn assertion verification](https://www.w3.org/TR/webauthn-3/#sctn-verifying-assertion), [EIP-7951](https://eips.ethereum.org/EIPS/eip-7951).

## Owner lifecycle and recovery

`ownerCommitment = keccak256(abi.encode(OWNER_DOMAIN, signer, ownerEpoch))`, where `signer = keccak256(x || y)[12:]` is the address EIP-8141 assigns to the key and reports through `SIGPARAM`. `keyCommitment(x, y, epoch)` and `signerAddress(x, y)` expose the derivation. Constructor and owner changes reject points outside the P-256 curve. `rotateOwner` is self-authorized: use a signed SENDER frame. Every change increments the epoch, even if restoring the same public key. Pending old-epoch assertions cannot become valid again after rotating away and back.

Recovery is an explicit deployment choice:

- `guardian=address(0), delay=0`: recovery disabled permanently.
- Nonzero guardian and delay between 2 and 30 days: guardian may schedule a specific replacement key. The owner or guardian can cancel. Anyone can finalize only that key after the delay. Owner rotation cancels outstanding recovery.

The guardian is a trusted takeover authority after the delay, not a co-signer or a permissionless recovery mechanism. A guardian contract/multisig may be used. Monitor `RecoveryScheduled` and allow time for cancellation. RP/origin and the recovery policy are immutable; this account has no proxy upgrade or origin migration. Credential IDs are off-chain discovery metadata, while public key/epoch control the on-chain account.

`executeBatch` is atomic and limited to 16 calls. Failed calls bubble their revert and roll back earlier calls in that batch. Recipient callbacks cannot invoke owner-only methods because `msg.sender` is not the account. No delegatecall execution or ERC-1271 message-signing API is exposed.

## SDK and deployment

`passkey/sdk.ts` contains no private-key signer. `registerPasskey` uses `navigator.credentials.create`, `signTransaction` uses `navigator.credentials.get`, and strict DER/SPKI adapters handle browser responses. `test-helpers.ts` is a separate test-only OpenSSL software authenticator; do not ship it as a passkey implementation.

```ts
import { zeroAddress, encodeFunctionData } from 'viem'
import { serializeFrameTransaction } from 'viem/eip8141'
import {
  registerPasskey, deploymentArgs, accountAbi, buildTransaction, signTransaction,
} from './sdk'

// On your actual HTTPS RP origin, obtain and persist credential metadata.
const credential = await registerPasskey('wallet.example.com', location.origin, {
  id: crypto.getRandomValues(new Uint8Array(32)),
  name: 'wallet-user', displayName: 'My wallet',
})
const args = await deploymentArgs(credential, zeroAddress, 0n)
// Deploy out/PasskeyAccount8141.sol/PasskeyAccount8141.json with these args
// using a funded deployer, verify configuration/code, then fund the account.

const epoch = await publicClient.readContract({ address: account, abi: accountAbi, functionName: 'ownerEpoch' })
const nonceSeq = BigInt(await publicClient.getTransactionCount({ address: account }))
const executionData = encodeFunctionData({ abi: accountAbi, functionName: 'execute', args: [recipient, value, '0x'] })
const tx = buildTransaction({ chainId, sender: account, nonceSeq, executionData, maxFeePerGas, maxPriorityFeePerGas })
// Display recipient/value, chain, account, gas limits and signed fee ceiling
// in the RP application before requesting UV. Read epoch/nonce from that chain.
const signed = await signTransaction(tx, epoch, credential)
await publicClient.request({ method: 'eth_sendRawTransaction', params: [serializeFrameTransaction(signed)] })
```

Deploy directly; this constructor/immutable design is not proxy-compatible. Save the credential ID, public key, RP/origin and account address in application metadata. For key rotation, register the replacement credential first and sign `rotateOwner(newX,newY)` with the current credential. Re-read the epoch after inclusion. There is no bundled wallet frontend, account discovery server or persistent credential store.

## Validation and gas

```sh
make passkey-test
RPC_URL=http://127.0.0.1:18546 make e2e-passkey
make test
```

The E2E runner refuses an occupied RPC endpoint and only shuts down its own fresh geth. Tests do not alter other devnets. It uses `MAX_VERIFY_GAS=100000`, `MAX_REVALIDATION_GAS=45000` and the repository's current state-gas policy. The recovery E2E uses the dev-only time-advance RPC; the contract still enforces the full two-day delay.

| Path | Measured VERIFY | Declared VERIFY | G-c (c=0) |
|---|---:|---:|---:|
| Ordinary transfer, linear/reused nonce | 12,999 | 25,000 | 25,000 |
| First use of a nonzero keyed nonce | 32,999 | 45,000 | 45,000 |
| Near-limit execution calldata (16,356 bytes), linear nonce | 21,268 | 25,000 | 25,000 |
| Near-limit calldata plus a fresh nonce key | 41,268 | 45,000 | 45,000 |

These are full WebAuthn-account measurements. SHA-256, base64url/JSON checks, envelope hashing and ABI processing are included. The curve verification is not: it is the entry's 6,700 signature gas, which counts toward `MAX_VERIFY_GAS` but is state-independent and outside the revalidation bound. With no cryptography in the frame there is no native memo credit, so G-c equals the declared VERIFY gas, and that is still below the previous design's `G-c` (28,100 and 48,100 with a 6,900 credit). G-c is a declared policy budget, not actual EVM gas saved on a replay. Limits depend on the pinned fork/compiler and input sizes; rebenchmark before changing either. Runtime size measured 5,338 bytes (viaIR, repository optimizer settings).

Validation covers 17 Forge tests (including 256 challenge cases and 256 flag cases), six Node SDK tests with OpenSSL DER/SPKI interoperability and low-S normalization, TypeScript checking, and real geth transactions: transfer, 29 rejected requests (envelope mutations, replay, a high-S, unsigned-message, wrong-signer, missing, duplicated or `ARBITRARY` signature entry, and ceremony data that does not match the signed digest), first/reused keyed nonce, included execution failure and next-nonce retry, key rotation, recovery cancellation, delayed recovery and restored-key epoch separation. A trace asserts exactly one SLOAD and no in-frame P256VERIFY call. Full repository tests pass with this implementation.

The browser API adapter is implemented and type-checked, but the end-to-end signer in these automated tests is a software authenticator. Real browser/hardware authentication and cross-browser interoperability have not been certified. Independent security review, real-device checks and production fork support remain release requirements.
