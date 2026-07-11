# EIP-8141 Reference Implementations

All contracts are research code and require the custom EIP-8141 Solidity compiler and geth client.

## FrameTxLib

`contracts/src/FrameTxLib.sol` wraps the current opcode surface:

- `txParam(param)`
- `frameDataLoad(offset, frameIndex)`
- `frameDataCopy(memoryOffset, dataOffset, length, frameIndex)`
- `frameParam(param, frameIndex)`
- `sigParam(param, signatureIndex)`
- `approveEmpty(scope)` and `approveWithData(data, scope)`

Scope constants are bitmasks: payment `1`, execution `2`, and both `3`. The library includes typed helpers for frame flags/value/status, signature metadata, the canonical signature hash, and expiry deadline encoding.

## Simple8141Account

`contracts/src/Simple8141Account.sol` demonstrates protocol-verified transaction signatures.

```text
Frame 0: VERIFY(sender, flags=3) -> validate(signatureIndex)
Frame 1: SENDER(target, value)   -> execute(target, value, data)
```

`validate` reads SIGPARAM metadata and requires a canonical-message secp256k1 signature whose signer equals the account owner. Raw signature verification is performed by the protocol. The frame's allowed scope is passed to APPROVE.

## CanonicalPaymaster

`contracts/src/CanonicalPaymaster.sol` is the public-mempool canonical paymaster implementation.

- Single storage-backed secp256k1 signer.
- `validate(signatureIndex)` accepts a protocol-verified canonical-message secp256k1 signature from the configured signer and approves payment.
- `initiateWithdrawal(amount)` schedules a signer withdrawal.
- `finalizeWithdrawal()` transfers only to the signer after seven days.
- `pendingWithdrawal()` exposes the amount excluded from framepool solvency.
- No immediate or alternate-recipient ETH withdrawal path exists.

The signer is deliberately not immutable: constructor-patched immutable values would produce a different runtime code hash for every instance.

Pinned integration values for compiler `0.8.33-develop.2026.7.11+commit.2bacd4c1`:

| Item | Value |
|---|---|
| Runtime code hash | `0x753d8fb13a049dbfd7771540fce6add0de9fd73fa5ec5a74186942d01b65275e` |
| Signer storage slot | `0` |
| Pending withdrawal amount slot | `1` |
| Withdrawal availability slot | `2` |
| Withdrawal delay | 7 days |

Any source, compiler, optimizer, metadata, or storage-layout change requires a new runtime hash and coordinated geth update.

## Other Paymasters

`SimplePaymaster.sol` and `ERC20Paymaster.sol` demonstrate application-specific sponsorship. They are non-canonical and are therefore subject to the one-pending-transaction public framepool limit.

## EOA Default Code

EOAs use protocol default code when they have no deployed code.

```text
Frame 0: VERIFY(sender, flags=3), data empty
Frame 1: SENDER(recipient, value), call data
```

Authentication comes from a transaction-level secp256k1 or P256 signature with empty `msg`. The VERIFY frame flags determine the approval scope. With a paymaster, the sender uses execution scope `2` and the paymaster uses payment scope `1`.

## Expiry Verifier

The canonical verifier is installed at `0x0000000000000000000000000000000000008141`. Its VERIFY frame carries an eight-byte big-endian deadline, zero flags, and zero value. geth permits TIMESTAMP only for this exact verifier/runtime combination.

## LightAccount8141

`contracts/src/example/light-account/` ports a proxy-based single-owner account with batch execution, ERC-1271 support, EIP-712 domain separation, ownership transfer, and deterministic factory deployment.

## CoinbaseSmartWallet8141

`contracts/src/example/coinbase-smart-wallet/` supports indexed ECDSA and WebAuthn owners, replay-safe ERC-1271 hashing, EIP-712 metadata, and deterministic factory deployment.

## Kernel8141

`contracts/src/example/kernel/` demonstrates a modular account architecture:

- root and installed validators;
- executors and execution modes;
- hooks and policies;
- ERC-1271 fallback handling;
- deterministic factory deployment.

VERIFY frames use the allowed-scope bitmask. Hook pre/post checks execute inside the SENDER call so hook and account state changes remain atomic.

## MLDSA8141Account

`contracts/src/example/mldsa/MLDSA8141Account.sol` demonstrates post-quantum validation through the ML-DSA-ETH precompile at `0x13`. It retains a bespoke frame-data signature flow for comparison with protocol transaction signatures.

## Client Libraries

`viem-eip8141/src/eip8141/` provides:

- strict nine-field transaction and six-field frame serialization/parsing;
- geth-compatible signature hashing;
- LocalAccount, EOA, P256, and Simple8141Account adapters;
- official frame transaction gas calculation;
- receipt formatting for status `0/1/3`;
- expiry and atomic-batch helpers.

## Test Coverage

- Forge unit tests cover contract behavior and storage/runtime invariants.
- geth tests cover frame execution, signatures, gas, expiry, atomic rollback, receipt normalization, framepool rules, and canonical paymaster accounting.
- viem vectors match geth raw transaction and signature-hash vectors.
- TypeScript E2E tests under `contracts/e2e/` target the local devnet.
