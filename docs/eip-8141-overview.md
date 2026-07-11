# EIP-8141 Frame Transactions

EIP-8141 adds typed transaction `0x06`. A frame transaction names its sender explicitly and executes an ordered list of frames. Authentication is performed by VERIFY frames and protocol-verified transaction signatures.

## Wire Format

The typed payload is:

```text
0x06 || rlp([
  chain_id,
  nonce,
  sender,
  frames,
  signatures,
  max_priority_fee_per_gas,
  max_fee_per_gas,
  max_fee_per_blob_gas,
  blob_versioned_hashes
])
```

Each frame has six fields:

```text
[mode, flags, target, gas_limit, value, data]
```

Each transaction signature has four fields:

```text
[scheme, signer, msg, signature]
```

Canonical RLP integer rules apply. Zero is encoded as an empty byte string. The maximum frame count is 64.

## Frame Modes And Flags

| Mode | Value | Caller and behavior |
|---|---:|---|
| DEFAULT | 0 | Normal call from the protocol entry point |
| VERIFY | 1 | Static validation call that must terminate with APPROVE |
| SENDER | 2 | Call as `tx.sender`; `value` is exposed as CALLVALUE |

Flag bits 0 and 1 are the allowed APPROVE scope. Bit 2 (`0x04`) joins the current frame to the following frame as an atomic batch. The final frame cannot set the atomic flag.

| Scope | Value |
|---|---:|
| payment | `0x01` |
| execution | `0x02` |
| execution and payment | `0x03` |

APPROVE is rejected if its scope contains bits not allowed by the current frame flags.

## Transaction Signatures

Supported schemes are secp256k1 (`0`) and P256 (`1`). The protocol validates every signature before frame execution.

- secp256k1 signature bytes are `v || r || s`, where `v` is raw parity `0` or `1`.
- P256 signature bytes are `r || s || qx || qy`.
- Empty `msg` means the signature verifies the canonical transaction signature hash.
- A non-empty `msg` must be exactly 32 bytes and cannot be all zero.

The signature hash is `keccak256(typed_transaction)`, with only the raw signature bytes of empty-message signatures replaced by empty bytes. Frame data is not elided. `SIGPARAM` exposes signature metadata but never raw signature bytes.

## Introspection Opcodes

| Opcode | Name | Purpose |
|---:|---|---|
| `0xB0` | TXPARAM | Read scalar transaction metadata |
| `0xB1` | FRAMEDATALOAD | Load 32 bytes from a frame's data |
| `0xB2` | FRAMEDATACOPY | Copy bytes from a frame's data |
| `0xB3` | FRAMEPARAM | Read frame metadata and earlier status |
| `0xB4` | SIGPARAM | Read signature signer, scheme, message, or length |
| `0xAA` | APPROVE | Terminate VERIFY execution and approve a scope |

FRAMEPARAM status is available only for earlier frames and returns `0` for failed or skipped execution and `1` for success. Receipts retain the distinct skipped status described below.

## Gas Accounting

```text
total_gas =
    15,000
  + 475 * len(frames)
  + calldata7623(rlp(frames))
  + calldata7623(rlp(signatures))
  + 2,800 * secp256k1_signature_count
  + 6,700 * p256_signature_count
  + sum(frame.gas_limit)
```

Unused frame gas, including gas assigned to skipped frames, is returned to the payer and block gas pool. `TXPARAM(0x06)` exposes the maximum transaction cost.

## Atomic Batches

If a frame with atomic flag `0x04` fails, state changes from the linked batch are rolled back and remaining linked frames are skipped. Receipt statuses are:

| Status | Meaning |
|---:|---|
| `0` | failed |
| `1` | successful |
| `3` | skipped by atomic rollback |

The transaction receipt also includes the resolved `payer` and one `frameReceipts` entry per frame.

## Expiry Verifier

Address `0x0000000000000000000000000000000000008141` is installed in genesis with the canonical expiry runtime. An expiry frame is a VERIFY frame with flags and value equal to zero and exactly eight bytes of big-endian deadline data. Only one expiry frame is allowed. Expired transactions are rejected and dropped during framepool revalidation.

## Paymasters

A sender may approve execution while a second VERIFY frame approves payment. Non-canonical paymasters are limited to one pending public-mempool transaction.

Canonical paymasters are identified by exact runtime code hash. Nodes reserve pending maximum costs and compute:

```text
available = balance - reserved_pending_cost - pending_withdrawal_amount
```

The reference `CanonicalPaymaster` uses a seven-day delayed withdrawal. Its signer is storage-backed so every instance has the same runtime code. The current pinned runtime hash is documented in [reference-implementations.md](reference-implementations.md).
