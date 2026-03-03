// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

// ── Custom types for Kernel8141 ──────────────────────────────────────
// Ported from ZeroDev Kernel v3 with EIP-8141 adaptations.

/// @dev Packed execution mode: [1B CallType][1B ExecType][4B reserved][4B ModeSelector][22B ModePayload]
type ExecMode is bytes32;

type CallType is bytes1;
type ExecType is bytes1;
type ExecModeSelector is bytes4;
type ExecModePayload is bytes22;

using {eqCallType as ==} for CallType global;
using {neqCallType as !=} for CallType global;
using {eqExecType as ==} for ExecType global;
using {eqModeSelector as ==} for ExecModeSelector global;

function eqCallType(CallType a, CallType b) pure returns (bool) {
    return CallType.unwrap(a) == CallType.unwrap(b);
}

function neqCallType(CallType a, CallType b) pure returns (bool) {
    return CallType.unwrap(a) != CallType.unwrap(b);
}

function eqExecType(ExecType a, ExecType b) pure returns (bool) {
    return ExecType.unwrap(a) == ExecType.unwrap(b);
}

function eqModeSelector(ExecModeSelector a, ExecModeSelector b) pure returns (bool) {
    return ExecModeSelector.unwrap(a) == ExecModeSelector.unwrap(b);
}

// ── Validation types ─────────────────────────────────────────────────

/// @dev Identifies a validator or permission: [1B ValidationType][20B address/permissionId]
type ValidationId is bytes21;

/// @dev 0x00=ROOT, 0x01=VALIDATOR, 0x02=PERMISSION
type ValidationType is bytes1;

/// @dev 4-byte permission identifier
type PermissionId is bytes4;

/// @dev Packed policy data: [2B PassFlag][20B policy address]
type PolicyData is bytes22;

/// @dev Bit flags: SKIP_FRAMETX(0x0001), SKIP_SIGNATURE(0x0002)
type PassFlag is bytes2;

using {vModeEqual as ==} for ValidationMode global;
using {vModeNotEqual as !=} for ValidationMode global;
using {vTypeEqual as ==} for ValidationType global;
using {vTypeNotEqual as !=} for ValidationType global;
using {vIdEqual as ==} for ValidationId global;
using {vIdNotEqual as !=} for ValidationId global;

/// @dev Not used for nonce encoding in EIP-8141 (no UserOp.nonce), but kept for enable mode.
type ValidationMode is bytes1;

function vModeEqual(ValidationMode a, ValidationMode b) pure returns (bool) {
    return ValidationMode.unwrap(a) == ValidationMode.unwrap(b);
}

function vModeNotEqual(ValidationMode a, ValidationMode b) pure returns (bool) {
    return ValidationMode.unwrap(a) != ValidationMode.unwrap(b);
}

function vTypeEqual(ValidationType a, ValidationType b) pure returns (bool) {
    return ValidationType.unwrap(a) == ValidationType.unwrap(b);
}

function vTypeNotEqual(ValidationType a, ValidationType b) pure returns (bool) {
    return ValidationType.unwrap(a) != ValidationType.unwrap(b);
}

function vIdEqual(ValidationId a, ValidationId b) pure returns (bool) {
    return ValidationId.unwrap(a) == ValidationId.unwrap(b);
}

function vIdNotEqual(ValidationId a, ValidationId b) pure returns (bool) {
    return ValidationId.unwrap(a) != ValidationId.unwrap(b);
}

// ── ERC-4337 compatible validation data ──────────────────────────────

type ValidationData is uint256;
type ValidAfter is uint48;
type ValidUntil is uint48;

function getValidationResult(ValidationData validationData) pure returns (address result) {
    assembly {
        result := validationData
    }
}

function packValidationData(ValidAfter validAfter, ValidUntil validUntil) pure returns (uint256) {
    return uint256(ValidAfter.unwrap(validAfter)) << 208 | uint256(ValidUntil.unwrap(validUntil)) << 160;
}

function parseValidationData(uint256 validationData)
    pure
    returns (ValidAfter validAfter, ValidUntil validUntil, address result)
{
    assembly {
        result := validationData
        validUntil := and(shr(160, validationData), 0xffffffffffff)
        switch iszero(validUntil)
        case 1 { validUntil := 0xffffffffffff }
        validAfter := shr(208, validationData)
    }
}
