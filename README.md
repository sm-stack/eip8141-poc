# EIP-8141 Proof of Concept

> **This is experimental, proof-of-concept code. It is NOT production-ready and may contain bugs.
> Do not use in any environment where real assets are at risk.**

A reference implementation for [EIP-8141](https://github.com/ethereum/EIPs/pull/8141) (Frame Transactions), demonstrating native account abstraction on Ethereum with a modified geth client and Solidity compiler.

## Repository Structure

```
├── 8141-geth/             # Modified go-ethereum with frame transaction support
├── solidity-eip8141/      # Modified solc with APPROVE, TXPARAM, FRAMEPARAM, and SIGPARAM
├── viem-eip8141/          # Modified viem with frame transaction client support
├── contracts/             # Solidity smart contracts (Foundry)
│   ├── src/
│   │   ├── FrameTxLib.sol            # Library wrapping EIP-8141 opcodes
│   │   ├── Simple8141Account.sol     # Minimal single-owner smart account
│   │   ├── SimplePaymaster.sol       # Gas sponsorship paymaster
│   │   ├── CanonicalPaymaster.sol    # Code-hash-pinned delayed-withdrawal paymaster
│   │   ├── ERC20Paymaster.sol        # ERC20 token paymaster
│   │   ├── Create2Deployer.sol       # Generic CREATE2 deployer for deploy-in-one-tx
│   │   └── example/
│   │       ├── kernel/                       # Kernel v3-style modular account
│   │       │   ├── Kernel8141.sol
│   │       │   ├── core/                    # ValidationManager, SelectorManager, HookManager, ExecutorManager
│   │       │   ├── factory/                 # Kernel8141Factory
│   │       │   ├── validators/              # ECDSA, SessionKey validators
│   │       │   ├── executors/               # Default, Batch executors
│   │       │   ├── hooks/                   # SpendingLimit, SessionKeyPermission hooks
│   │       │   ├── policies/                # GasPolicy8141, SelectorPolicy8141
│   │       │   ├── signers/                 # ECDSASigner8141
│   │       │   ├── handlers/                # ERC-1271 fallback handler
│   │       │   ├── interfaces/              # Module interfaces (IValidator, IHook, IPolicy, ...)
│   │       │   └── types/                   # Constants, Structs, Types
│   │       ├── mldsa/                          # ML-DSA post-quantum account
│   │       │   └── MLDSA8141Account.sol
│   │       ├── coinbase-smart-wallet/          # Coinbase-style smart wallet
│   │       │   ├── CoinbaseSmartWallet8141.sol
│   │       │   └── CoinbaseSmartWalletFactory8141.sol
│   │       └── light-account/                  # Alchemy LightAccount port
│   │           ├── LightAccount8141.sol
│   │           └── LightAccountFactory8141.sol
│   ├── test/              # Forge unit tests
│   └── e2e/               # TypeScript E2E tests (viem-eip8141)
├── devnet/                # Dev network launch script
├── build/                 # Build output (geth, solc binaries)
└── Makefile
```

## Prerequisites

- Go 1.21+
- CMake 3.13+
- [Foundry](https://getfoundry.sh)
- Node.js 18+
- [pnpm](https://pnpm.io) (for viem-eip8141)

## Build

Build all components from submodules:

```bash
make build
```

This will:
1. Pull git submodules (`8141-geth`, `solidity-eip8141`, `viem-eip8141`)
2. Install dependencies (`pnpm install` for viem-eip8141, `npm ci` for contracts)
3. Build geth → `build/bin/geth`
4. Build solc → `build/bin/solc`
5. Build viem-eip8141 → `viem-eip8141/src/_esm`, `_cjs`, `_types`

You can also build individually:

```bash
make build-geth
make build-solc
make build-viem
make install-deps
```

## Contracts

Build and test the Solidity contracts (requires `build/bin/solc`):

```bash
make contracts   # forge build
make test        # forge test -vv
```

## Devnet

Start a local dev node with EIP-8141 support:

```bash
make devnet        # starts geth --dev on port 18545
make devnet-stop   # stops the dev node
```

The developer genesis installs the expiry verifier at `0x0000000000000000000000000000000000008141`. Canonical paymaster instances are deployed as needed; their pinned runtime code hash is `0x753d8fb13a049dbfd7771540fce6add0de9fd73fa5ec5a74186942d01b65275e`.

## E2E Tests

E2E tests run against the local devnet. Start the devnet first, then:

```bash
make e2e                   # run all 13 E2E test suites
make benchmark             # gas benchmarks
```

Individual test targets:

```bash
# Simple8141Account
make e2e-simple            # deploy-in-one-tx

# Kernel8141
make e2e-kernel            # basic flow
make e2e-kernel-validator  # validator swap

# Kernel hooks/policies
make e2e-hooked            # SpendingLimitHook

# CoinbaseSmartWallet8141
make e2e-coinbase-ecdsa    # ECDSA
make e2e-coinbase-webauthn # WebAuthn

# LightAccount8141
make e2e-light-account     # ECDSA

# MLDSA8141Account (post-quantum)
make e2e-mldsa             # ML-DSA signature verification

# EOA Default Code
make e2e-eoa               # all EOA tests
make e2e-eoa-batching      # batch multiple calls
make e2e-eoa-sponsor       # gas sponsoring via paymaster
make e2e-eoa-p256          # P256 (passkey) signing

# Negative tests (mempool/protocol constraint violations)
make e2e-negative          # all negative tests
make e2e-negative-mempool  # mempool tracer violations
make e2e-negative-protocol # protocol constraint violations
```

## Gas Benchmark

EIP-8141 frame transactions achieve significant gas savings compared to ERC-4337 UserOperations by eliminating the application-layer EntryPoint overhead. Validation and execution happen as native protocol operations (VERIFY/SENDER frames) rather than nested contract calls.

Run `make benchmark` against the local devnet to reproduce:

| Account | Operation | Total Gas | Verify | Sender |
|---|---|---:|---:|---:|
| Simple8141 | ETH transfer | 58,017 | 5,854 | 34,803 |
| Simple8141 | ERC20 transfer | 56,760 | 5,854 | 32,814 |
| Kernel8141 | ETH transfer | 74,911 | 20,657 | 36,486 |
| Kernel8141 | ERC20 transfer | 73,425 | 20,657 | 34,384 |
| Coinbase | ETH transfer | 71,248 | 17,311 | 35,869 |
| Coinbase | ERC20 transfer | 70,137 | 17,311 | 34,002 |
| LightAccount | ETH transfer | 64,612 | 11,579 | 35,405 |
| LightAccount | ERC20 transfer | 63,486 | 11,579 | 33,535 |

> These numbers include first-time costs: account creation for the ETH recipient (G_newaccount = 25,000 gas) and zero-to-non-zero SSTORE for the ERC20 recipient balance (20,000 gas). In steady-state (sending to existing accounts with non-zero balances), total gas is roughly **~25,000 lower for ETH** and **~17,000 lower for ERC20** transfers. Each account uses a separate recipient address to ensure fair comparison regardless of benchmark execution order.

## Disclaimer

This repository is a **proof-of-concept** for research and demonstration purposes only.
It may contain bugs, incomplete features, and unaudited code.
Do not deploy or use any part of this codebase in production or with real funds.
