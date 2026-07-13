# EIP-8272 Recent Roots

EIP-8272 lets a frame transaction commit to application roots that were recorded during a recent slot. The proof of concept uses `timestamp / 12` behind a `SlotProvider`; production consensus integration must supply the beacon slot directly.

## Transaction Field

The eleventh frame transaction field is:

```text
recent_root_references = [[source_id, slot, root], ...]
```

- At most 16 references are allowed.
- `source_id` and `root` are exactly 32 bytes.
- `slot` is a canonical uint64 RLP integer.
- The complete list is included in the transaction hash and signature hash.

## Writing Roots

The native system contract is `0x0000000000000000000000000000000000008272`. A call must have zero value and exactly 64 calldata bytes: `salt || root`.

```text
source_id  = keccak256(caller || salt)
index      = current_slot mod 8192
entry_hash = keccak256(ENTRY_DOMAIN || source_id || uint64_be(current_slot) || root)
storage_key = keccak256(STORAGE_DOMAIN || source_id || uint64_be(index))
```

The last write for a source in a slot wins. Static calls, delegate calls, malformed calldata, and nonzero value revert.

## Validation Window

A reference is valid against transaction pre-state when:

```text
1 <= current_slot - reference.slot <= 8191
storage[storage_key] == entry_hash
```

Therefore a root written in slot `S` can first be referenced in `S+1`. Same-slot and future references are invalid. A reference expires when the difference reaches 8192. Valid references warm the system address and referenced storage slot for frame execution.

## Introspection

| Interface | Value |
|---|---:|
| `TXPARAM(0x10)` | reference count |
| `RECENTROOTREFLOAD(0, index)` | source ID |
| `RECENTROOTREFLOAD(1, index)` | zero-extended slot |
| `RECENTROOTREFLOAD(2, index)` | root |

`RECENTROOTREFLOAD` is opcode `0xB5`, costs 3 gas, and halts on an out-of-range index or field. `0xB4` remains assigned to `SIGPARAM`.

## Intrinsic Gas

Reference RLP bytes participate in EIP-7623 calldata charging. When at least one reference is present, intrinsic gas also adds:

```text
2,400 + 2,002 * len(recent_root_references)
```

The viem helpers `computeSourceId`, `writeRecentRoot`, and `makeRootReference` build the canonical values. `FrameTxLib.recentRootRefLoad` and `RootAnchoredValidator` demonstrate validation-side introspection.
