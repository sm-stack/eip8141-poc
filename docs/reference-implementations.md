# Reference Implementations

This repository contains six smart contract implementations demonstrating EIP-8141 frame transactions: three standalone contracts and three ports of production ERC-4337 accounts.

## FrameTxLib

`contracts/src/FrameTxLib.sol`

Solidity wrapper library for EIP-8141 opcodes. All functions are `internal pure` with inline assembly, providing zero-overhead abstractions:

- **APPROVE**: `approveEmpty(scope)`, `approveWithData(scope, offset, length)`
- **TXPARAM**: `sigHash()`, `txSender()`, `nonce()`, `maxCost()`, `frameCount()`, `currentFrameIndex()`, `currentFrameMode()`
- **Frame inspection**: `frameTarget(idx)`, `frameDataLoad(idx, offset)`, `frameDataSize(idx)`, `frameData(idx)`, `frameGas(idx)`, `frameMode(idx)`, `frameStatus(idx)`
- **Scope constants**: `SCOPE_EXECUTION` (0), `SCOPE_PAYMENT` (1), `SCOPE_BOTH` (2)

---

## Standalone Contracts

### Simple8141Account

`contracts/src/Simple8141Account.sol` (~67 lines)

Minimal single-owner ECDSA account.

**Validation (VERIFY frame):**
```
validate(v, r, s, scope)
  -> sigHash = FrameTxLib.sigHash()
  -> ecrecover(sigHash, v, r, s) == owner
  -> APPROVE(scope)
```

**Execution (SENDER frame):**
```
execute(target, value, data)
  -> target.call{value}(data)
```

**vs ERC-4337:** No UserOperation struct parsing, no entrypoint simulation, no hash computation. The protocol provides `sigHash` directly, and frame sequencing replaces entrypoint orchestration.

### SimplePaymaster

`contracts/src/SimplePaymaster.sol` (~52 lines)

Off-chain signer-approved gas sponsor for ETH-only sponsorship.

**Validation (VERIFY frame):**
```
validate(signature)
  -> ecrecover(FrameTxLib.sigHash(), v, r, s) == signer
  -> APPROVE(SCOPE_PAYMENT)
```

**vs ERC-4337:** No EntryPoint deposit/stake management. No balance tracking. The protocol handles gas collection directly from the paymaster's ETH balance when APPROVE(payment) is called.

### ERC20Paymaster

`contracts/src/ERC20Paymaster.sol` (~122 lines)

ERC-20 token gas sponsor using cross-frame introspection.

**Validation (VERIFY frame):**
```
validate()
  -> nextFrame = currentFrameIndex() + 1
  -> verify frameDataLoad(nextFrame, 0) == transfer selector
  -> verify transfer recipient == address(this)
  -> verify token is accepted (exchangeRates[token] > 0)
  -> verify amount >= maxCost * rate / 1e18
  -> verify sender balanceOf(token) >= amount
  -> APPROVE(SCOPE_PAYMENT)
```

The paymaster reads the next frame's calldata via `frameDataLoad()` to verify the ERC-20 transfer is valid before approving payment. This is a pattern unique to EIP-8141 — the paymaster can inspect future frames without any off-chain coordination.

**Post-op (DEFAULT frame):**
```
postOp(transferFrameIdx)
  -> verify frameStatus(transferFrameIdx) == SUCCESS
```

**vs ERC-4337 (Pimlico ERC20PaymasterV07):**

| | ERC-4337 (Pimlico) | EIP-8141 |
|---|---|---|
| Payment model | Pull (`transferFrom`) | Push (user calls `transfer`) |
| Token approval | User must `approve()` paymaster | Not needed |
| Refunds | `postOp` refunds excess based on `actualGasCost` | No refund — user pays `maxCost` amount |
| Oracle | On-chain oracle for pricing | `exchangeRates` mapping (oracle possible) |
| Signature | Optional (mode 0 = no sig) | Not required |
| Guarantor | Supported (modes 2, 3) | Not applicable |

The key limitation: EIP-8141 has no `actualGasCost` available to any frame, so exact-cost refunds aren't possible. Users pay based on `maxCost` (worst case).

---

## Ported ERC-4337 Accounts

### CoinbaseSmartWallet8141

`contracts/src/example/coinbase-smart-wallet/` (~519 lines)

Port of [Coinbase Smart Wallet](https://github.com/coinbase/smart-wallet). Multi-owner account supporting ECDSA and WebAuthn (passkeys).

**Owners:** Two types stored as `bytes[]`:
- Ethereum address (32 bytes) — ECDSA validation via `ecrecover`
- P256 public key (64 bytes) — WebAuthn validation via RIP-7212 precompile

**Validation modes:**
- `validate(signature, scope)` — standard sigHash validation with owner index routing
- `validateCrossChain(signature, scope)` — reads SENDER frame calldata via `frameDataLoad()` to compute a chain-agnostic hash for cross-chain replay protection

**Execution:**
- `execute(target, value, data)` — single call
- `executeBatch(Call[])` — batch calls
- `executeWithoutChainIdValidation(bytes[])` — cross-chain replayable calls (restricted selector set)

**vs Original (ERC-4337):**

| | Coinbase SW (4337) | CoinbaseSmartWallet8141 |
|---|---|---|
| Signature hash | Computed from UserOp fields | Protocol-provided `sigHash` |
| Cross-chain | Off-chain hash wrapping | `frameDataLoad()` to read SENDER calldata |
| Execution entry | `executeUserOp()` via EntryPoint | Direct `execute()` in SENDER frame |
| Owner management | Same | Same (`addOwnerAddress`, `addOwnerPublicKey`) |
| ERC-1271 | Same | Same |
| Proxy pattern | UUPS (ERC-1967) | UUPS (ERC-1967) |

### LightAccount8141

`contracts/src/example/light-account/` (~367 lines)

Port of [Alchemy LightAccount](https://github.com/alchemyplatform/light-account). Single-owner account with EOA and contract owner support.

**Signature types:**
- `0x00` prefix — EOA owner, ECDSA via `ecrecover`
- `0x01` prefix — Contract owner, ERC-1271 via `isValidSignature()`

**Execution:**
- `execute(dest, value, func)` — single call
- `executeBatch(dest[], func[])` / `executeBatch(dest[], value[], func[])` — batch
- `performCreate(value, initCode)` — CREATE deployment
- `performCreate2(value, initCode, salt)` — CREATE2 deployment

**vs Original (ERC-4337):**

| | LightAccount (4337) | LightAccount8141 |
|---|---|---|
| Signature hash | Computed from UserOp | Protocol-provided `sigHash` |
| Execution entry | Via EntryPoint callback | Direct SENDER frame calls |
| Contract owners | ERC-1271 supported | Same |
| CREATE/CREATE2 | Via calldata encoding | Direct `performCreate`/`performCreate2` |

### Kernel8141

`contracts/src/example/kernel/` (~667 lines core + modules)

Port of [Kernel v3](https://github.com/zerodevapp/kernel) by ZeroDev. Fully modular account with pluggable validators, executors, hooks, and policies.

**Architecture:**
```
Kernel8141
  -> ValidationManager8141  (validation, enable mode, ERC-1271)
      -> SelectorManager8141   (fallback routing by selector)
      -> HookManager8141       (pre/post execution hooks)
      -> ExecutorManager8141   (executor module registry)
```

**Module types:**
| Type | Interface | Purpose |
|------|-----------|---------|
| VALIDATOR (1) | `IValidator8141` | Signature validation |
| EXECUTOR (2) | `IExecutor8141` | Alternative execution flows |
| FALLBACK (3) | — | Selector-based call routing |
| HOOK (4) | `IHook8141` | Pre/post execution wrappers |
| POLICY (5) | `IPolicy8141` | Permission constraints |
| SIGNER (6) | `ISigner8141` | Permission signature verification |

**Validation modes:**
1. `validate(sig, scope)` — root validator
2. `validateFromSenderFrame(sig, scope)` — non-root validator with sigHash-bound selector ACL
3. `validatePermission(sig, scope)` — ISigner + IPolicy[] permission validation

**Cross-frame selector ACL:**
```solidity
uint256 senderFrameIdx = ... // find SENDER frame
bytes4 senderSelector = bytes4(FrameTxLib.frameDataLoad(senderFrameIdx, 0));
if (!allowedSelectors[validatorId][senderSelector]) revert InvalidSelector();
```

Instead of decoding the selector from UserOp calldata, the validator reads the actual SENDER frame's selector via `frameDataLoad()`. This is more direct and eliminates encoding/decoding overhead.

**Bundled modules:**
- `ECDSAValidator` — ECDSA validation + hook (dual-role: validator and direct-call gatekeeper)
- `SessionKeyValidator` — session key with policy enforcement
- `SpendingLimitHook` — daily spending limit enforcement
- `SessionKeyPermissionHook` — session key permission checking
- `DefaultExecutor` / `BatchExecutor` — single and batch execution

**vs Original (Kernel v3, ERC-4337):**

| | Kernel v3 (4337) | Kernel8141 |
|---|---|---|
| Signature hash | Computed from UserOp | Protocol `sigHash` |
| Selector ACL | Decode from `userOp.callData` | `frameDataLoad()` cross-frame read |
| Hook resolution | Passed via UserOp context | Read from storage in SENDER frame |
| Enable mode | Works (writes during validation) | **Non-functional** (VERIFY is read-only) |
| Policy context | Limited to UserOp fields | `senderFrameIndex` + `frameDataLoad()` |
| Post-op | Gas tracking + refund logic | Simple frame status check |

**Known limitation:** `validateWithEnable()` cannot work in VERIFY frames because it calls `_installValidation()` which writes to storage. Enable mode requires a separate pre-transaction or must be moved to a SENDER frame.

---

## Shared Simplifications

All EIP-8141 implementations benefit from:

1. **No UserOperation encoding** — `sigHash` is a canonical protocol value, not derived from struct hashing.
2. **No EntryPoint contract** — The protocol entry point (`0x00..00aa`) is a protocol-level construct, not a deployed contract.
3. **No simulation overhead** — Validation runs natively in VERIFY frames, not via `eth_estimateGas` workarounds.
4. **Scope-based approval** — Fine-grained control over execution vs payment authorization, enabling clean separation of concerns.
5. **Cross-frame introspection** — VERIFY frames can read any non-VERIFY frame's calldata, enabling on-chain validation of execution intent without off-chain coordination.
