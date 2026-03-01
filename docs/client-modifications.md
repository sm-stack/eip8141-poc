# Client Modifications

This document describes the changes made to go-ethereum (geth) and the Solidity compiler to support EIP-8141 frame transactions.

## Geth (8141-geth)

### Transaction Type

`core/types/tx_frame.go`

Frame transactions are type `0x06`. The transaction struct differs from standard transactions:

```go
type FrameTx struct {
    ChainID    *uint256.Int
    Nonce      uint64
    Sender     common.Address   // explicit sender, no signature recovery
    Frames     []Frame
    GasTipCap  *uint256.Int
    GasFeeCap  *uint256.Int
    BlobFeeCap *uint256.Int
    BlobHashes []common.Hash
    // no signature fields
}

type Frame struct {
    Mode     uint8            // 0=DEFAULT, 1=VERIFY, 2=SENDER
    Target   *common.Address  // nil = tx.sender
    GasLimit uint64
    Data     []byte
}
```

No signature fields exist. Authentication is delegated to VERIFY frames. The `Sender` field is explicit — no `ecrecover` needed.

**Gas calculation:**
```
total_gas = 15,000 (intrinsic) + calldata_gas(rlp(frames)) + sum(frame.gas_limit)
```

EIP-7623 floor data gas is also computed for Prague fork compatibility.

**Signature hash:** `keccak256(rlp(tx))` with VERIFY frame data zeroed out. Non-VERIFY frame targets, gas limits, and calldata are all covered.

### State Transition

`core/state_transition.go`

The `execute()` function was modified to handle frame transactions:

1. **Gas pre-payment skipped** — Unlike regular transactions, the sender does not prepay gas. Payment happens when a frame APPROVEs `SCOPE_PAYMENT`.

2. **Sender code allowed** — Frame transactions permit `tx.sender` to have deployed code (smart accounts), unlike regular transactions which require EOA senders.

3. **Frame execution** — Instead of a single `Call`/`Create`, the state transition calls `executeFrames()` which iterates through each frame:

```
for each frame:
  1. Reset transient storage (TSTORE/TLOAD state)
  2. Set caller:
     - DEFAULT/VERIFY: entry point (0x00..00aa)
     - SENDER: tx.sender
  3. Execute:
     - VERIFY: StaticCall (read-only)
     - DEFAULT/SENDER: regular Call
  4. Process APPROVE status:
     - Status 2: set sender_approved = true
     - Status 3: collect gas from payer, set payer_approved = true
     - Status 4: both
  5. Revert frame on invalid approval sequence
```

**Approval rules enforced:**
- Execution approval must come before payment approval
- Each approval type can only occur once
- Payment approval triggers `collectGasFromPayer()` which charges the payer's ETH balance
- Transaction is invalid if `payer_approved == false` at the end

**Gas refunds** go to the payer address, not the sender.

### EVM Opcodes

`core/vm/instructions_frame.go`

Four new opcodes:

**APPROVE (`0xaa`)** — Terminates execution with an approval signal.
- Stack: `[offset, length, scope]`
- Scope 0 = execution, 1 = payment, 2 = both
- Works like `RETURN` but sets the frame's exit status to 2/3/4
- Gas: 0 + memory expansion

**TXPARAMLOAD (`0xb0`)** — Load 32 bytes from a transaction parameter.
- Stack: `[in1, in2, offset] -> [value]`
- `in1` selects the parameter (0x00-0x15), `in2` is the frame index for frame-specific parameters
- Gas: 3 (VeryLow)

**TXPARAMSIZE (`0xb1`)** — Get the byte length of a transaction parameter.
- Stack: `[in1, in2] -> [size]`
- Gas: 2 (Base)

**TXPARAMCOPY (`0xb2`)** — Copy parameter data to memory.
- Stack: `[in1, in2, destOffset, offset, size]`
- Gas: 3 + memory expansion + copy cost

Parameter `0x12` (frame data) returns size 0 for VERIFY frames — their calldata is hidden from other frames. Parameter `0x15` (frame status) reverts if querying the current or a future frame.

### Frame Mempool

`core/txpool/framepool/framepool.go`

A dedicated transaction pool for frame transactions, separate from the legacy and blob pools.

**Pool limits:**
- 4 pending frame transactions per sender (per ERC-7562 `SAME_SENDER_MEMPOOL_COUNT`)
- 256 total pooled frame transactions
- 500,000 gas cap per VERIFY frame (`verifyFrameGasCap`)
- 500,000 gas cap per DEFAULT frame (`defaultFrameGasCap`)
- 512 KB max transaction size

**Admission flow (two-phase simulation):**
1. Basic validation (size, gas, chain ID)
2. **Phase 1: Pre-execute DEFAULT frames** appearing before the first VERIFY frame. These are deploy/setup frames (analogous to ERC-4337 `initCode`) whose side-effects (e.g., deployed contract code) must be visible to VERIFY frames. Each DEFAULT frame's gas is checked against `defaultFrameGasCap`. The resulting state is captured as `baseState`.
3. **Phase 2: Simulate each VERIFY frame** against a copy of `baseState` with the ERC-7562 validation tracer. DEFAULT frames after the first VERIFY are skipped (e.g., paymaster `postOp` frames that depend on SENDER frame state changes).
4. Reject if any VERIFY frame violates validation rules
5. Reject if any VERIFY frame doesn't exit with APPROVE (status 2-4)
6. Check per-sender and global pool limits

The two-phase approach enables deploy-in-one-tx patterns where account deployment (DEFAULT frame) and validation (VERIFY frame) occur in the same transaction. The simulation runs on a copy of the state to avoid polluting the pool.

### ERC-7562 Validation Tracer

`core/vm/frame_validation_tracer.go`

The validation tracer enforces ERC-7562 rules during VERIFY frame simulation in the mempool. This ensures that transactions accepted into the mempool will also be valid when included in a block, preventing DoS attacks against block proposers.

**Banned opcodes [OP-011]:**
Forbidden in VERIFY frames to prevent context-dependent validation:
- `ORIGIN`, `GASPRICE`, `BLOCKHASH`, `COINBASE`, `TIMESTAMP`, `NUMBER`, `PREVRANDAO`, `GASLIMIT`, `BASEFEE`, `BLOBHASH`, `BLOBBASEFEE`
- `CREATE`, `CREATE2`, `SELFDESTRUCT`, `INVALID`
- `BALANCE`, `SELFBALANCE` [OP-080]

**GAS usage restriction [OP-012]:**
The `GAS` opcode must immediately precede a `CALL` opcode. This prevents gas limit probing which could make validation results differ between mempool simulation and block execution.

**Out-of-gas forbidden [OP-020]:**
If a VERIFY frame runs out of gas during mempool simulation, the transaction is rejected. This prevents validators from passing only when gas is plentiful.

**EXTCODE/CALL target validation [OP-041]:**
Targets of `EXTCODESIZE`, `EXTCODECOPY`, `EXTCODEHASH`, and `CALL` must have deployed code. Exception: precompiles and the sender address (OP-042).

**BALANCE restriction [OP-080]:**
`BALANCE` and `SELFBALANCE` are included in the banned opcodes map to prevent balance-dependent validation that could differ between mempool simulation and block execution.

**Sender storage access [STO-010]:**
`SLOAD` from the sender's own storage is always permitted.

**Associated storage rules [STO-021]:**
External storage reads (not from sender) must be "associated" with the sender. A storage slot is associated if:
1. The slot value equals the sender address, OR
2. The slot matches `keccak256(sender || x) + n` where `n` is in `[0, 128]`

This validates Solidity mapping access patterns like `mapping(address => ...)` where the sender is the key. The tracer collects `KECCAK256` preimages during execution to verify this relationship post-execution.

**Implementation:**
The tracer hooks into `CaptureState` (per-opcode) and `CaptureExit` (per-call depth). It records the first violation encountered and short-circuits on subsequent checks. Storage association validation runs at call depth 1 when the VERIFY frame's top-level execution completes.

## Solidity Compiler (solidity-eip8141)

### New Opcodes

`libevmasm/Instruction.h`, `libevmasm/Instruction.cpp`

Four opcodes added to the instruction set:

```
APPROVE     = 0xaa  (3 inputs, 0 outputs, has side effects, Zero gas tier)
TXPARAMLOAD = 0xb0  (3 inputs, 1 output,  no side effects, VeryLow gas tier)
TXPARAMSIZE = 0xb1  (2 inputs, 1 output,  no side effects, Base gas tier)
TXPARAMCOPY = 0xb2  (5 inputs, 0 outputs, has side effects, VeryLow gas tier)
```

APPROVE is marked as having side effects (it terminates execution). TXPARAMLOAD/SIZE are pure reads.

### Gas Metering

`libevmasm/GasMeter.cpp`

- **APPROVE**: Base cost 0 + memory expansion (same model as RETURN)
- **TXPARAMCOPY**: Base cost 3 (VeryLow) + memory expansion + copy cost (`copyWords * CopyGas`, same model as CALLDATACOPY)
- TXPARAMLOAD and TXPARAMSIZE use their tier gas (3 and 2 respectively)

### EVM Version Gating

`liblangutil/EVMVersion.cpp`

Frame opcodes are only available when the EVM version supports frame transactions (gated behind `hasFrameTransaction()`). Using these opcodes on an unsupported EVM version produces compiler errors (codes 8150-8153).

The project uses `evm_version = "osaka"` in `foundry.toml` to enable these opcodes.

### Yul/Assembly Support

Frame opcodes are available in inline assembly and Yul IR, with proper stack depth tracking for the optimizer. The `via_ir = true` pipeline handles these opcodes correctly, though some Solady library functions are incompatible with the modified compiler (notably `ECDSA.recover` which uses an assembly trick that breaks under `via_ir`).
