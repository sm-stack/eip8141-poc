# Client Modifications For EIP-8141

This document describes the implemented changes in `8141-geth`.

## Transaction Model

`core/types/tx_frame.go` defines transaction type `0x06` with nine RLP fields. Frames contain `mode`, `flags`, `target`, `gas_limit`, `value`, and `data`. Transaction-level signatures contain `scheme`, `signer`, `msg`, and raw signature bytes.

Decoding performs strict field-count, canonical RLP, frame-count, mode, flags, value, atomic-batch, expiry, and signature validation. Legacy eight-field transactions and four-field frames are rejected.

The transaction hash includes the complete payload. The signature hash copies the transaction and clears raw signature bytes only where `msg` is empty.

## Signature Verification

All transaction signatures are verified before validation-frame simulation:

- secp256k1: 65-byte `v || r || s`, raw parity, recovered address equals `signer`.
- P256: 128-byte `r || s || qx || qy`, public-key-derived address equals `signer`.

Signature verification gas is included in the 100,000 validation-prefix gas budget.

## Execution

The state transition executes DEFAULT, VERIFY, and SENDER frames in order. VERIFY uses static execution and must call APPROVE. SENDER uses the explicit transaction sender as caller and applies `frame.value` as CALLVALUE.

Atomic batches journal ordinary state and approval effects independently. A failure rolls back linked state and approval changes, then marks remaining linked frames skipped. Skipped frame gas is refunded.

## Introspection

Osaka registers the following opcodes:

| Opcode | Name | Gas model |
|---:|---|---|
| `0xB0` | TXPARAM | base |
| `0xB1` | FRAMEDATALOAD | very low |
| `0xB2` | FRAMEDATACOPY | copy plus memory expansion |
| `0xB3` | FRAMEPARAM | base |
| `0xB4` | SIGPARAM | base |
| `0xAA` | APPROVE | terminating |

Removed opcodes `TXPARAMLOAD`, `TXPARAMSIZE`, and `TXPARAMCOPY` are not accepted. The Solidity fork exposes `txparam`, `framedataload`, `framedatacopy`, `frameparam`, `sigparam`, and `approve` as Yul builtins.

## Gas

`FrameTx.TotalGas()` applies:

```text
15,000 + 475/frame
+ EIP-7623 cost of RLP frames and signatures
+ signature verification gas
+ sum(frame gas limits)
```

The EIP-7623 floor equals the full intrinsic metadata gas. Overflow clamps or rejects at the relevant validation boundary.

## Framepool

The dedicated framepool performs:

1. static transaction and signature validation;
2. sender nonce and replacement fee-bump validation;
3. validation-prefix recognition, skipping the canonical expiry frame;
4. expiry deadline checking and rechecking;
5. validation-prefix gas budgeting;
6. ERC-7562-style tracing for ordinary VERIFY frames;
7. payer solvency and reservation accounting.

The canonical paymaster is recognized by runtime hash. Its pay frame is exempt from the generic validation tracer but must execute successfully and approve payment. Solvency subtracts both locally reserved pending maximum costs and the pending withdrawal amount in canonical storage slot 1. Non-canonical paymasters remain limited to one pending transaction.

Reset and reorg handling rebuild reservations by revalidating retained transactions against the new state.

## RPC And Receipts

Frame transaction JSON includes frame flags/value and the complete signatures list. Raw transaction submission follows the same strict decoder as block transactions.

Frame receipts include:

```text
payer
frameReceipts[] { status, gasUsed, logs }
```

Status values are normalized to failed `0`, successful `1`, or skipped `3`. Transaction-level cumulative gas remains available through the standard receipt field.

## Genesis

Developer genesis installs the expiry verifier at `0x0000000000000000000000000000000000008141` with nonce 1 and the canonical runtime from `params.FrameExpiryVerifierCode`.
