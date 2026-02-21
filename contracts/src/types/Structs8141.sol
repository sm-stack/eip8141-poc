// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {ValidationData, PermissionId, PassFlag} from "./Types8141.sol";
import {IPolicy8141} from "../interfaces/IPolicy8141.sol";

/// @dev Standard execution struct (ERC-7579)
struct Execution {
    address target;
    uint256 value;
    bytes callData;
}

// ── Internal structs for permission signature processing ─────────────

struct PermissionSigMemory {
    uint8 idx;
    uint256 length;
    ValidationData validationData;
    PermissionId permission;
    PassFlag flag;
    IPolicy8141 policy;
    bytes permSig;
    address caller;
    bytes32 digest;
}

// ── Install/uninstall data formats (calldata layout helpers) ─────────

struct InstallValidatorDataFormat {
    bytes validatorData;
    bytes hookData;
    bytes selectorData;
}

struct InstallExecutorDataFormat {
    bytes executorData;
    bytes hookData;
}

struct InstallFallbackDataFormat {
    bytes selectorData;
    bytes hookData;
}

struct PermissionEnableDataFormat {
    bytes[] data;
}

struct PermissionDisableDataFormat {
    bytes[] data;
}

/// @dev Enable mode data packed in VERIFY frame calldata
struct EnableDataFormat {
    bytes validatorData;
    bytes hookData;
    bytes selectorData;
    bytes enableSig;
    bytes txSig;
}
