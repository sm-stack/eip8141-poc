# C13Account8141

Self-paying EIP-8141 account with SPHINCS⁻ C13 verification, atomic execution/batching and PQ-authorized owner rotation. The account policy is Solidity. Its immutable external verifier specializes the pinned upstream Yul without changing the C13 signature format, hash inputs or parameters.

**Experimental, nonstandard, unaudited cryptography.** These engineering tests do not establish C13's cryptographic security or certify a production wallet. This example deliberately has no classical-signature recovery bypass.

## Measured result

Local geth, pinned project compiler, `FOUNDRY_PROFILE=sphincs` (viaIR, optimizer runs 10,000, Osaka, existing Yul optimizer workaround). Latest complete run:

| Scenario | VERIFY execution gas |
|---|---:|
| Ordinary transfer | 68,980 |
| First use of a nonzero nonce key, including initialization | 89,296 |
| Reused nonce key | 69,290 |
| Near-limit execution calldata (16,356 bytes) | 69,224 |
| Near-limit calldata plus a fresh nonce key | 89,826 |

All transactions declare **G = 99,899**, with **native reusable credit c = 0**. The C13 witness is the transaction's single `ARBITRARY` signature entry, which costs 100 signature gas; that gas counts toward `MAX_VERIFY_GAS`, so the declared frame gas plus the entry is 99,999. The runner sets `MAX_VERIFY_GAS=100000` and `MAX_REVALIDATION_GAS=99999`; admission therefore passes `G-c=99,899`, below 100k. It also configures state-dependent execution and validation state caps explicitly. No geth policy or cryptographic parameter was relaxed. These are frame execution costs, not total transaction charges: signature calldata/intrinsic gas and execution/state charges are separate. Results vary with the signed transaction and hash-chain digit distribution. This is measured coverage, not an exhaustive worst-case proof; the largest measured case has 10,073 gas headroom. Execution calldata size no longer affects VERIFY gas: the canonical signature hash already commits to it, so the account does not hash it again.

The optimized standalone warm verifier call measures about **62.2k**, compared with **107.7k** for the pinned original under the previous 200-run compiler setting. At the same 200-run setting the optimized implementation measures about **65.0k**. The dedicated C13 Foundry test measures 62,144 including its surrounding call glue; the isolated research harness measures 62,196. Neither standalone number includes the account or nonce initialization.

## Changes that reduce gas

- Specialize fixed FORS authentication paths and WOTS chain indices; retain the two-layer loop to avoid needless bytecode growth.
- Dispatch WOTS chains by the eight possible base-8 digits, using explicit hash steps instead of a loop. Check high digits first, matching the fixed-sum profile. The number and order of cryptographic hashes are unchanged.
- Replace 43 separate digit additions with masked broadword reductions. Only the low 129 bits participate; lane widths double so carries cannot contaminate neighboring sums. Independent arithmetic checks cover boundary bits and 10,000 random words.
- Replace root-array copy loops with overlapping `MCOPY` (same source, destination and bytes).
- Carry the witness as an `ARBITRARY` signature entry and sign the canonical signature hash. The account no longer builds its own envelope hash, so it neither copies nor hashes up to 16 KiB of execution calldata.
- `SIGDATACOPY` the witness straight into the verifier call's ABI buffer. Bytes past the end of the signature copy as zero, which is exactly the ABI padding, so there is no intermediate `bytes memory` copy.
- Use a dedicated 10,000-run compiler profile, leaving the default profile's optimizer setting unchanged.

The verifier's terminal assembly intentionally uses the free-memory-pointer and zero slots as scratch. It remains an **external** contract; every assembly exit returns or reverts. It is not marked memory-safe and is not copied into a returning internal library. The account's short scratch-memory block that assembles the verifier call follows Solidity's temporary-allocation rules.

## Authorization flow

1. Caller must be the frame validation entry point, `0xAA`.
2. Require exactly two frames: VERIFY at index 0, self-targeted, scope flags 3; SENDER at index 1, self-targeted, flags 0. Both frame values are zero. Require one nonce key and no recent-root references or blobs.
3. Require exactly one transaction-level signature entry: scheme `ARBITRARY`, empty `msg`, exactly 3,688 bytes. Bound execution calldata at 16,384 bytes and require VERIFY calldata to be exactly 100 bytes.
4. Take the canonical signature hash (`TXPARAM(0x08)`). EIP-8141 elides the raw bytes of empty-message signature entries from that hash, so the witness signs it without circularity, and it already commits to the chain, the account, the nonce, the fee caps, both frames' limits and data (including the key and epoch in VERIFY calldata). No explicit envelope hash or signed fee ceiling is needed. An explicit-message entry would keep its bytes inside the hash and is rejected.
5. Domain-separate with a scheme tag. `SIGDATACOPY` the witness into the verifier call and verify the C13 signature using the fixed verifier.
6. Read the current owner commitment and compare `(owner domain, seed, root, epoch)`. Call `APPROVE` for execution and payment.
7. Execute one call or an atomic batch (maximum 16 calls). Only an account self-call may execute or rotate the owner. A failed included execution still consumes its transaction nonce.

Public keys use two top-aligned 16-byte values in `bytes32`; low 128 bits must be zero, and the root cannot be zero. Signature size is exactly 3,688 bytes and travels in the signature entry; `validate(seed, root, epoch)` calldata is exactly 100 bytes. Public key and epoch are supplied as validation inputs; the stored commitment determines authority. Rotation increments the epoch, so restoring an old key does not restore its old transaction domain.

## Reproduce

Prerequisites: the workspace's geth/solc/viem builds, Foundry, Python 3, Rust/Cargo and installed `contracts` npm dependencies.

```sh
make sphincs-test
RPC_URL=http://127.0.0.1:18546 make e2e-sphincs
```

The runner builds the vendored Rust signer with `cargo build --locked --release`, builds the dedicated Solidity profile, refuses an occupied RPC endpoint, starts an isolated devnet and cleans up its own process. Budget environment overrides are supported and the actual revalidation cap is recorded in the report. Artifacts are in `contracts/out-sphincs`, separate from other examples. Running `npm run sphincs:e2e --prefix contracts` directly requires those artifacts, the signer binary and an already configured local node.

Evidence: `.context/sphincs/e2e-report.json` and `verify-trace.json`; research/build/test logs are in `.context/sphincs-research/`. Re-run the runner to regenerate local evidence.

The Solidity tests cover original-versus-optimized verification, five positive vectors across multiple keys/messages, four differential fuzz properties, canonical key rejection, domain/epoch separation, access control, callback resistance and batch rollback. The actual geth test covers 20 rejections (altered signed fields, a tampered, truncated, padded, missing, duplicated or explicit-message witness, a wrong key or epoch), replay, first/reused nonce keys, failed execution, owner rotation and large calldata. The default full Solidity suite passed 188 tests.

## Source and signer boundary

`vendor-manifest.json` pins all vendored source hashes to upstream revision `55b2f3e25d8d7cc0df33ccdb13becca1a168b26f`. The MIT license is retained. `generate-verifier.py` checks the original source hash before specializing it; `--check` verifies the committed generated file. Regenerate with:

```sh
python3 contracts/sphincs/generate-verifier.py
```

`fixtures/` and `test-helpers.ts` use deliberately **public deterministic test keys**. The native CLI's `sign <message>` derives its key from a public message, and `sign-with` accepts a private seed on argv. These interfaces must not be used as production key custody. The SDK computes the signing challenge and attaches a signature; it does not claim to implement secure private-key storage or a production signer.

The upstream C13 analysis assumes a per-key signature-use bound (2^22). Account nonces do not enforce the number of signatures released offchain, replaced or shared across devices/backups. A real signer needs independent PQ entropy, durable usage accounting and fresh-key rotation; changing the account epoch does not reset a reused cryptographic key's exposure. Deriving the PQ seed from an exposed ECDSA private key, or adding an ECDSA-only recovery path, would undermine the intended PQ account policy.

References: [pinned upstream](https://github.com/nconsigny/SPHINCS-/tree/55b2f3e25d8d7cc0df33ccdb13becca1a168b26f), [security analysis](https://github.com/nconsigny/SPHINCS-/blob/55b2f3e25d8d7cc0df33ccdb13becca1a168b26f/docs/SECURITY-ANALYSIS.md), [formal-proof boundary](https://github.com/nconsigny/SPHINCS-/blob/55b2f3e25d8d7cc0df33ccdb13becca1a168b26f/verity/SphincsMinusVerifiers/AXIOMS.md).
