# EIP-8141 Frame Transactions

EIP-8141 adds typed transaction `0x06`. A frame transaction names its sender explicitly and executes an ordered list of frames. Authentication is performed by VERIFY frames and protocol-verified transaction signatures.

## Wire Format

The typed payload is:

```text
0x06 || rlp([
  chain_id,
  nonce_keys,
  nonce_seq,
  sender,
  frames,
  signatures,
  [max_priority_fee_per_gas, max_fee_per_gas, max_fee_per_blob_gas],
  blob_versioned_hashes,
  recent_root_references
])
```

The three fee fields are a nested list, giving nine top-level fields. Blob-carrying frame transactions wrap this payload with the EIP-4844 sidecar (`[payload, blobs, commitments, proofs]` or the version-1 cell-proof form) on the network and RPC submission path.

Each frame has six fields, with a two-dimensional gas limit (EIP-8037 execution and state gas):

```text
[mode, flags, target, [execution_gas_limit, state_gas_limit], value, data]
```

Each transaction signature has four fields:

```text
[scheme, signer, msg, signature]
```

Canonical RLP integer rules apply. Zero is encoded as an empty byte string. The maximum frame count is 64. EIP-8250 replaces the scalar nonce with one to sixteen strictly increasing nonce keys and a shared sequence. Key zero is valid only as singleton `[0]` and aliases the sender account nonce. See [eip-8250-keyed-nonces.md](eip-8250-keyed-nonces.md).

EIP-8272 appends up to 16 `[source_id, slot, root]` references. Both hashes are exactly 32 bytes and `slot` is a canonical uint64. References are signed and checked against transaction pre-state. See [eip-8272-recent-roots.md](eip-8272-recent-roots.md).

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

Supported schemes are ARBITRARY (`0`), secp256k1 (`1`), and P256 (`2`). The protocol validates protocol schemes and structurally checks ARBITRARY entries before frame execution.

- secp256k1 signature bytes are `v || r || s`, where `v` is raw parity `0` or `1`.
- P256 signature bytes are `r || s || qx || qy`.
- ARBITRARY entries have no signer and carry witness bytes for contract validation.
- Empty `msg` means the signature verifies the canonical transaction signature hash.
- A non-empty `msg` must be exactly 32 bytes and cannot be all zero.

The signature hash is `keccak256(typed_transaction)` over the same nine-field layout as the wire format, with only the raw signature bytes of empty-message signatures replaced by empty bytes. Frame data is not elided. `SIGPARAM` exposes signature metadata. `SIGDATACOPY` copies raw signature bytes, and only from ARBITRARY entries: the bytes and length of a protocol-validated signature are not introspectable, which keeps them eligible for later aggregation.

The two message forms serve different witnesses. A bespoke scheme that signs the transaction itself (for example the C13 hash-based account) places its witness in an ARBITRARY entry with an empty `msg`: the entry's bytes are elided from the signature hash, so the witness can sign that hash without circularity. A scheme whose signed message is fixed by an outside protocol (for example WebAuthn, which signs `sha256(authenticatorData || sha256(clientDataJSON))`) uses a protocol-validated entry with an explicit `msg`. Such an entry's bytes stay inside the signature hash, so the account binds the ceremony's challenge to an envelope hash of the transaction fields instead.

## Introspection Opcodes

| Opcode | Name | Purpose |
|---:|---|---|
| `0xB0` | TXPARAM | Read scalar transaction metadata |
| `0xB1` | FRAMEDATALOAD | Load 32 bytes from a frame's data |
| `0xB2` | FRAMEDATACOPY | Copy bytes from a frame's data |
| `0xB3` | FRAMEPARAM | Read frame metadata and earlier status |
| `0xB4` | SIGPARAM | Read signature signer, scheme, message, or (ARBITRARY only) length |
| `0xB5` | SIGDATACOPY | Copy raw bytes of an ARBITRARY signature entry |
| `0xB6` | RECENTROOTREFLOAD | Read source ID, slot, or root from a verified reference |
| `0xAA` | APPROVE | Terminate VERIFY execution and approve a scope |

FRAMEPARAM status is available only for earlier frames and returns `0` for failure, `1` for success, and `2` for skipped execution.

`TXPARAM(0x01)` returns `nonce_seq`. `TXPARAM(0x0C)` returns the state gas remaining in the current frame. `0x0D` through `0x0F` expose the nonce key count, key-set hash, and recent-root reference count; `0x10` and `0x11` expose the first nonce key and the pre-state legacy nonce.

`FRAMEPARAM(0x01)` returns a frame's execution gas limit and `0x09` its state gas limit. `0x0A` and `0x0B` return the execution and state gas used by an earlier frame.

## Gas Accounting

Gas is two-dimensional after Amsterdam (EIP-8037): each frame declares an execution gas limit and a state gas limit, and state growth (new storage slots, account creation, code deposit) is charged against the state dimension at 1,530 gas per byte.

```text
fixed_gas =
    12,000
  + 475 * len(frames)
  + 100 * arbitrary_signature_count
  + 2,800 * secp256k1_signature_count
  + 6,700 * p256_signature_count
  + (references > 0 ? 2,900 + 2,102 * references : 0)
  + 6,000 * value_transfer_frames   # EIP-2780; SENDER value to a non-self target

calldata_tokens = zero_bytes + 4 * nonzero_bytes over
    rlp(nonce_keys) || rlp(nonce_seq),
    each frame.data,
    each signature's signer || msg || signature,
    rlp(recent_root_references)

intrinsic_gas = fixed_gas + 4 * calldata_tokens
floor_gas     = fixed_gas + 16 * calldata_tokens          # EIP-7976
total_gas     = max(intrinsic_gas + sum(execution_gas_limit), floor_gas)
              + sum(state_gas_limit)
```

`intrinsic_gas + sum(execution_gas_limit)` is capped at 16,777,216 (EIP-7825). Unused frame gas in both dimensions, including gas assigned to skipped frames, is returned to the payer and block gas pool. `TXPARAM(0x06)` exposes the maximum transaction cost.

## Atomic Batches

If a frame with atomic flag `0x04` fails, state changes from the linked batch are rolled back and remaining linked frames are skipped. Receipt statuses are:

| Status | Meaning |
|---:|---|
| `0` | failed |
| `1` | successful |
| `2` | skipped by atomic rollback |

The transaction receipt also includes the resolved `payer` and one `frameReceipts` entry per frame. Each frame receipt reports `gasUsed` as an object with `execution` and `state` components.

## Expiry Verifier

Address `0x0000000000000000000000000000000000008141` is installed in genesis with the canonical expiry runtime. An expiry frame is a VERIFY frame with flags, value, and state gas limit equal to zero and exactly eight bytes of big-endian deadline data. Only one expiry frame is allowed. Expired transactions are rejected and dropped during framepool revalidation.

## Paymasters

A sender may approve execution while a second VERIFY frame approves payment. Non-canonical paymasters are limited to one pending public-mempool transaction.

Canonical paymasters are identified by exact runtime code hash. Nodes reserve pending maximum costs and compute:

```text
available = balance - reserved_pending_cost - pending_withdrawal_amount
```

The reference `CanonicalPaymaster` uses a seven-day delayed withdrawal. Its signer is storage-backed so every instance has the same runtime code. The current pinned runtime hash is documented in [reference-implementations.md](reference-implementations.md).
