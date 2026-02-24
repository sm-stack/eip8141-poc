// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {
    CallType, ExecType, ExecModeSelector,
    PassFlag, ValidationMode, ValidationType, ValidationData
} from "./Types8141.sol";

// ── ERC-7579 call types ──────────────────────────────────────────────
CallType constant CALLTYPE_SINGLE = CallType.wrap(0x00);
CallType constant CALLTYPE_BATCH = CallType.wrap(0x01);
CallType constant CALLTYPE_STATIC = CallType.wrap(0xFE);
CallType constant CALLTYPE_DELEGATECALL = CallType.wrap(0xFF);

// ── ERC-7579 exec types ─────────────────────────────────────────────
ExecType constant EXECTYPE_DEFAULT = ExecType.wrap(0x00);
ExecType constant EXECTYPE_TRY = ExecType.wrap(0x01);

// ── ERC-7579 mode selector ──────────────────────────────────────────
ExecModeSelector constant EXEC_MODE_DEFAULT = ExecModeSelector.wrap(bytes4(0x00000000));

// ── Kernel8141 PassFlags ─────────────────────────────────────────────
/// @dev Skip this policy/permission during frame tx validation (replaces SKIP_USEROP)
PassFlag constant SKIP_FRAMETX = PassFlag.wrap(0x0001);
/// @dev Skip this policy/permission during ERC-1271 signature validation
PassFlag constant SKIP_SIGNATURE = PassFlag.wrap(0x0002);

// ── Validation modes ────────────────────────────────────────────────
ValidationMode constant VALIDATION_MODE_DEFAULT = ValidationMode.wrap(0x00);
ValidationMode constant VALIDATION_MODE_ENABLE = ValidationMode.wrap(0x01);

// ── Validation types ────────────────────────────────────────────────
ValidationType constant VALIDATION_TYPE_ROOT = ValidationType.wrap(0x00);
ValidationType constant VALIDATION_TYPE_VALIDATOR = ValidationType.wrap(0x01);
ValidationType constant VALIDATION_TYPE_PERMISSION = ValidationType.wrap(0x02);

// ── Module types (ERC-7579) ─────────────────────────────────────────
uint256 constant MODULE_TYPE_VALIDATOR = 1;
uint256 constant MODULE_TYPE_EXECUTOR = 2;
uint256 constant MODULE_TYPE_FALLBACK = 3;
uint256 constant MODULE_TYPE_HOOK = 4;
uint256 constant MODULE_TYPE_POLICY = 5;
uint256 constant MODULE_TYPE_SIGNER = 6;

// ── Hook sentinel addresses ─────────────────────────────────────────
/// @dev Hook not installed — validator/executor/selector is not active
address constant HOOK_NOT_INSTALLED = address(0);
/// @dev Hook installed but no hook module required
address constant HOOK_INSTALLED = address(1);
/// @dev Only the entry point can interact with this selector
address constant HOOK_ONLY_ENTRYPOINT = address(0xFFfFfFffFFfffFFfFFfFFFFFffFFFffffFfFFFfF);

// ── Namespaced storage slots (keccak-1, matching Kernel v3) ─────────
/// @dev bytes32(uint256(keccak256('kernel.v3.validation')) - 1)
bytes32 constant VALIDATION_STORAGE_SLOT = 0x7bcaa2ced2a71450ed5a9a1b4848e8e5206dbc3f06011e595f7f55428cc6f84f;
/// @dev bytes32(uint256(keccak256('kernel.v3.selector')) - 1)
bytes32 constant SELECTOR_STORAGE_SLOT = 0x7c341349a4360fdd5d5bc07e69f325dc6aaea3eb018b3e0ea7e53cc0bb0d6f3b;
/// @dev bytes32(uint256(keccak256('kernel.v3.executor')) - 1)
bytes32 constant EXECUTOR_STORAGE_SLOT = 0x1bbee3173dbdc223633258c9f337a0fff8115f206d302bea0ed3eac003b68b86;
/// @dev ERC-1967 implementation slot
bytes32 constant ERC1967_IMPLEMENTATION_SLOT = 0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc;

// ── EIP-712 type hashes ─────────────────────────────────────────────
bytes32 constant KERNEL_WRAPPER_TYPE_HASH = keccak256("Kernel8141(bytes32 hash)");
/// @dev keccak256("Enable(bytes21 validationId,uint32 nonce,address hook,bytes validatorData,bytes hookData,bytes selectorData,bytes enableData)")
bytes32 constant ENABLE_TYPE_HASH = 0xb17ab1224aca0d4255ef8161acaf2ac121b8faa32a4b2258c912cc5f8308c505;

// ── Nonce management ────────────────────────────────────────────────
uint32 constant MAX_NONCE_INCREMENT_SIZE = 10;

// ── Replayable signature magic ──────────────────────────────────────
bytes32 constant MAGIC_VALUE_SIG_REPLAYABLE = keccak256("kernel.replayable.signature");

// ── Validation data constants ───────────────────────────────────────
uint256 constant SIG_VALIDATION_FAILED_UINT = 1;
ValidationData constant SIG_VALIDATION_FAILED = ValidationData.wrap(SIG_VALIDATION_FAILED_UINT);

// ── ERC-1271 ────────────────────────────────────────────────────────
bytes4 constant ERC1271_MAGICVALUE = 0x1626ba7e;
bytes4 constant ERC1271_INVALID = 0xffffffff;
