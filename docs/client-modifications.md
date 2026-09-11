# Client Modifications For EIP-8141

This document describes the implemented changes in `8141-geth` (branch `eip8141-benchmark`, based on go-ethereum v1.17.x with the Amsterdam and Bogota forks).

## Fork Activation

Frame transactions, the introspection opcodes, and the EIP-8250/8272 system contracts activate at the **Bogota** fork, which requires Amsterdam (EIP-8037 two-dimensional gas, EIP-7843 slot numbers, block access lists) to be active. geth's built-in `--dev` genesis stops at Osaka, so `devnet/run.sh` initialises an ephemeral datadir from `devnet/genesis.json` with `amsterdamTime` and `bogotaTime` set to zero.

## Transaction Model

`core/types/tx_frame.go` defines transaction type `0x06` with nine RLP fields; the three fee fields form a nested list. `nonce_keys` and `nonce_seq` replace the scalar nonce. Frames contain `mode`, `flags`, `target`, `[execution_gas_limit, state_gas_limit]`, `value`, and `data`. Transaction-level signatures contain `scheme`, `signer`, `msg`, and raw signature bytes. The final field contains EIP-8272 recent-root references. Blob frame transactions carry an EIP-4844 sidecar wrapper on the network and RPC path.

Decoding performs strict field-count, canonical RLP, nonce-key ordering, frame-count, mode, flags, value, atomic-batch, expiry, signature, recent-root, and execution-gas-cap validation. Legacy frame transaction schemas (flat fees, scalar frame gas) are rejected.

`FrameTx` implements `EncodeRLP` so the transaction hash and signature hash use exactly the wire layout. The signature hash copies the transaction and clears raw signature bytes only where `msg` is empty.

## Signature Verification

All transaction signatures are verified before validation-frame simulation:

- secp256k1: 65-byte `v || r || s`, raw parity, recovered address equals `signer`.
- P256: 128-byte `r || s || qx || qy`, public-key-derived address equals `signer`.

Signature verification gas is included in the 100,000 validation-prefix gas budget (`--framepool.maxverifygas`).

## Execution

The state transition executes DEFAULT, VERIFY, and SENDER frames in order. VERIFY uses static execution and must call APPROVE. SENDER uses the explicit transaction sender as caller and applies `frame.value` as CALLVALUE.

Atomic batches journal ordinary state and approval effects independently. A failure rolls back linked state and approval changes, then marks remaining linked frames skipped. Skipped frame gas is refunded.

## Introspection

Bogota registers the following opcodes (the Solidity fork gates them on `evm_version = "osaka"` or later):

| Opcode | Name | Gas model |
|---:|---|---|
| `0xB0` | TXPARAM | base |
| `0xB1` | FRAMEDATALOAD | very low |
| `0xB2` | FRAMEDATACOPY | copy plus memory expansion |
| `0xB3` | FRAMEPARAM | base |
| `0xB4` | SIGPARAM | base |
| `0xB5` | RECENTROOTREFLOAD | very low |
| `0xAA` | APPROVE | terminating |

Removed opcodes `TXPARAMLOAD`, `TXPARAMSIZE`, and `TXPARAMCOPY` are not accepted. The Solidity fork exposes `txparam`, `framedataload`, `framedatacopy`, `frameparam`, `sigparam`, `recentrootrefload`, and `approve` as Yul builtins.

`TXPARAM` selectors: `0x00` type, `0x01` nonce sequence, `0x02` sender, `0x03`-`0x05` fee caps, `0x06` max cost, `0x07` blob hash count, `0x08` signature hash, `0x09` frame count, `0x0A` frame index, `0x0B` signature count, `0x0C` state gas left, `0x0D` nonce key count, `0x0E` nonce keys hash, `0x0F` recent-root reference count, `0x10` first nonce key, `0x11` legacy nonce. `FRAMEPARAM` adds `0x09` state gas limit, `0x0A` execution gas used, and `0x0B` state gas used. A failing `APPROVE` (bad scope, wrong caller) reverts instead of raising an invalid-opcode error.

## Gas

`FrameTx.TotalGas()` applies:

```text
12,000 + 475/frame
+ 4 gas per calldata token over nonce data, frame data, signature bytes, and recent-root references
+ signature verification gas
+ 2,900 + 2,102/reference when references are present
+ 6,000 per SENDER value transfer to a non-self target (EIP-2780)
+ sum(frame execution gas limits), floored by the EIP-7976 data floor
+ sum(frame state gas limits)
```

State growth is charged in the state dimension at `CostPerStateByte = 1530`: 64 bytes per new storage slot, 120 bytes per new account, and one byte per deposited code byte. Overflow clamps or rejects at the relevant validation boundary.

## Framepool

The dedicated framepool performs:

1. static transaction and signature validation;
2. keyed nonce state and same-domain replacement fee-bump validation;
3. validation-prefix recognition, skipping the canonical expiry frame;
4. expiry deadline checking and rechecking;
5. validation-prefix gas budgeting;
6. EIP-8141 validation-prefix tracing for ordinary VERIFY frames;
7. payer solvency and reservation accounting.

The canonical paymaster is recognized by runtime hash. Its pay frame is exempt from the generic validation tracer but must execute successfully and approve payment. Solvency subtracts both locally reserved pending maximum costs and the pending withdrawal amount in canonical storage slot 1. Non-canonical paymasters remain limited to one pending transaction.

The public-mempool policy caps declared validation-prefix execution gas at 100,000 (`--framepool.maxverifygas`) and declared validation-prefix state gas at 500,000 (`--framepool.maxverifystategas`). Raising either requires `--framepool.allow-unsafe-benchmark-policy` and disabled peer discovery; `devnet/run.sh` does this so the example accounts (which declare larger VERIFY and deploy-frame limits) are admitted.

Reset and reorg handling rebuild reservations by revalidating retained transactions against the new state. The benchmark branch additionally bounds state-dependent revalidation (`--framepool.maxrevalidationgas`, `--framepool.maxstatedependentverifygas`), caches validation precompile results, indexes validation dependencies for selective revalidation, and drops transactions whose validation program (sender, payer, delegation, or factory code) changed since admission. See `core/txpool/framepool/VALIDATION_SPLIT.md` in the geth tree.

Recent-root references are checked against the transaction pre-state immediately after keyed nonces. Same-slot, future, expired, and mismatched entries are rejected. Framepool reset rechecks every retained reference and evicts entries once `current_slot - slot >= 8192`. The current slot is the EIP-7843 header `slotNumber`; the developer-mode simulated beacon derives it as `timestamp / 12` so `dev_advanceTime` advances slots.

Payment APPROVE consumes the selected nonce domain. Singleton key zero increments the account nonce. Non-zero keys update protocol-managed storage at `0x0000000000000000000000000000000000008250`; each first-used key costs 20,000 gas. Approval effects survive later frame and atomic-batch rollback.

## RPC And Receipts

Frame transaction JSON includes `nonceKeys`, `nonceSeq`, frame flags/value, the complete signatures list, and `recentRootReferences`. Raw transaction submission follows the same strict decoder as block transactions.

Frame receipts include:

```text
payer
frameReceipts[] { status, gasUsed: { execution, state }, logs }
```

Frame JSON exposes `gasLimit` (execution) and `stateGasLimit`. `eth_call`, `eth_estimateGas`, and `eth_simulateV1` reject frame transactions.

Status values are normalized to failed `0`, successful `1`, or skipped `2`. Transaction-level cumulative gas remains available through the standard receipt field.

## Genesis

Developer genesis (and `devnet/genesis.json`) installs the expiry verifier at `0x0000000000000000000000000000000000008141`, NONCE_MANAGER at `0x0000000000000000000000000000000000008250`, and RECENT_ROOT at `0x0000000000000000000000000000000000008272`. The recent-root address accepts exactly `salt || root` with zero value and records the current slot's entry.
