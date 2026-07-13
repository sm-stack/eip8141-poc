# EIP-8250 Keyed Nonces

EIP-8250 extends EIP-8141 frame transactions with independent nonce domains. A transaction commits to one shared sequence and one to sixteen keys:

```text
0x06 || rlp([
  chain_id,
  nonce_keys,
  nonce_seq,
  sender,
  frames,
  signatures,
  max_priority_fee_per_gas,
  max_fee_per_gas,
  max_fee_per_blob_gas,
  blob_versioned_hashes,
  recent_root_references
])
```

## Canonical Form

- `1 <= len(nonce_keys) <= 16`.
- Keys are canonical uint256 RLP integers in strictly increasing order.
- Key zero is valid only as singleton `[0]`.
- `nonce_seq` is a canonical uint64 and must be below `2^64 - 1` for execution.
- Legacy frame transaction wire formats are invalid. EIP-8272 adds the eleventh field shown above.

Client APIs may accept a scalar `nonce` as an input alias. It is normalized to `nonce_keys=[0]` and `nonce_seq=nonce` before signing and serialization.

## State

Key zero aliases the sender account nonce. Non-zero keys use NONCE_MANAGER:

```text
address = 0x0000000000000000000000000000000000008250
slot    = keccak256(left_pad_32(sender) || bytes32(key))
value   = current nonce sequence, absent storage means zero
runtime = 0x60006000fd
```

All selected keys must equal `nonce_seq` in pre-state. NONCE_MANAGER has nonce 1 and rejects direct calls; its storage is modified only by protocol bookkeeping.

## Consumption And Gas

The nonce domain is consumed when a frame successfully approves payment:

- `[0]` increments the sender account nonce.
- Non-zero keys are all written to `nonce_seq + 1`.
- Every non-zero key whose raw pre-state value is zero costs an additional 20,000 gas on first use.
- Protocol reads and writes do not warm EIP-2929 access-list entries.

Nonce consumption, payer selection, and gas collection are approval effects. They survive later frame failure and atomic-batch rollback.

## Introspection

| TXPARAM | Value |
|---:|---|
| `0x01` | `nonce_seq` |
| `0x0C` | `nonce_keys[0]` |
| `0x0D` | sender account nonce in transaction pre-state |
| `0x0E` | `len(nonce_keys)` |
| `0x0F` | `keccak256(bytes32(len) || bytes32(k0) || ...)` |

## Framepool Rules

State validation checks every selected domain. A replacement must use the same sender, exact key set, and sequence, and satisfy the normal fee bump. The proof of concept retains up to 16 pending frame transactions per sender so independent nonce domains can be mined together.

`eth_getTransactionCount` remains the legacy account nonce API. viem's `getKeyedNonce` reads key zero through that API and non-zero keys through `eth_getStorageAt` on NONCE_MANAGER.

## Security Pattern

Applications should bind validation to the intended domain, not only to a sequence. `NullifierValidator.sol` checks key count, key-set hash, and sequence zero, producing a one-time authorization whose key cannot be substituted by the transaction sender.
