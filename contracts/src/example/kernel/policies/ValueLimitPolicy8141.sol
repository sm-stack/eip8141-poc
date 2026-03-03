// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {IPolicy8141} from "../interfaces/IPolicy8141.sol";
import {FrameTxLib} from "../../../FrameTxLib.sol";
import {MODULE_TYPE_POLICY} from "../types/Constants8141.sol";

/// @title ValueLimitPolicy8141
/// @notice Stateful permission policy that enforces ETH value transfer limits.
/// @dev Two-phase policy:
///      - VERIFY phase (checkFrameTxPolicy): read-only value sufficiency check
///      - SENDER phase (consumeFrameTxPolicy): budget decrement (state write)
///
///      Designed for the permission system where SENDER frame always calls
///      executeHooked(bytes21 vId, bytes32 execMode, bytes executionCalldata).
///
///      executeHooked ABI layout in SENDER frame:
///        [0:4]     = selector
///        [4:36]    = vId (bytes21)
///        [36:68]   = execMode (bytes32, first byte = CallType)
///        [68:100]  = offset to executionCalldata (0x60)
///        [100:132] = length of executionCalldata
///        [132:...] = executionCalldata bytes
///
///      SINGLE executionCalldata (packed):
///        [0:20]  = target address
///        [20:52] = value (uint256)
///        [52:..] = callData
contract ValueLimitPolicy8141 is IPolicy8141 {
    struct ValueBudget {
        uint128 allowed;
        uint128 consumed;
    }

    mapping(address => mapping(bytes32 => ValueBudget)) public budgets;

    error BudgetExceeded(uint256 requested, uint256 available);
    error InvalidBudget();

    event BudgetSet(address indexed account, bytes32 indexed id, uint128 allowed);
    event BudgetConsumed(address indexed account, bytes32 indexed id, uint128 amount);

    // ── IPolicy8141: VERIFY phase (read-only) ─────────────────────────

    /// @inheritdoc IPolicy8141
    /// @dev Reads SENDER frame's executeHooked calldata to extract ETH value.
    ///      Compares against remaining budget.
    function checkFrameTxPolicy(bytes32 id, address, bytes32, uint256 senderFrameIndex)
        external
        view
        override
        returns (uint256)
    {
        uint256 value = _extractValue(senderFrameIndex);
        if (value > budgets[msg.sender][id].allowed) {
            return 1; // budget insufficient
        }
        return 0;
    }

    // ── IPolicy8141: SENDER phase (state write) ──────────────────────

    /// @inheritdoc IPolicy8141
    /// @dev Decrements the value budget. Called from executeHooked() via _consumeStatefulPolicies().
    function consumeFrameTxPolicy(bytes32 id, address account) external override {
        uint256 senderIdx = FrameTxLib.currentFrameIndex();
        uint256 value = _extractValue(senderIdx);
        if (value == 0) return;

        ValueBudget storage budget = budgets[account][id];
        if (value > budget.allowed) {
            revert BudgetExceeded(value, budget.allowed);
        }
        budget.allowed -= uint128(value);
        budget.consumed += uint128(value);
        emit BudgetConsumed(account, id, uint128(value));
    }

    /// @inheritdoc IPolicy8141
    function checkSignaturePolicy(bytes32 id, address, bytes32, bytes calldata)
        external
        view
        override
        returns (uint256)
    {
        return budgets[msg.sender][id].allowed > 0 ? 0 : 1;
    }

    // ── IModule8141 ───────────────────────────────────────────────────

    /// @dev initData format: abi.encodePacked(bytes32 permissionId, uint128 allowedBudget)
    function onInstall(bytes calldata data) external payable override {
        bytes32 id = bytes32(data[0:32]);
        uint128 allowed = uint128(bytes16(data[32:48]));
        if (allowed == 0) revert InvalidBudget();

        budgets[msg.sender][id] = ValueBudget({allowed: allowed, consumed: 0});
        emit BudgetSet(msg.sender, id, allowed);
    }

    function onUninstall(bytes calldata data) external payable override {
        bytes32 id = bytes32(data[0:32]);
        delete budgets[msg.sender][id];
    }

    function isModuleType(uint256 typeID) external pure override returns (bool) {
        return typeID == MODULE_TYPE_POLICY;
    }

    function isInitialized(address) external pure override returns (bool) {
        return true;
    }

    // ── Internal: Value extraction from SENDER frame ──────────────────

    /// @dev Extract total ETH value from the SENDER frame's executeHooked calldata.
    ///      executeHooked(bytes21 vId, bytes32 execMode, bytes executionCalldata):
    ///        ExecMode at offset 36 (first byte = CallType)
    ///        executionCalldata starts at offset 132 (4+32+32+32+32)
    ///
    ///      For SINGLE: value at executionCalldata[20:52] → absolute offset 152
    ///      For BATCH: sum all Execution[].value entries
    ///      For DELEGATECALL: no value transfer
    function _extractValue(uint256 frameIdx) internal pure returns (uint256) {
        uint8 callType = uint8(bytes1(FrameTxLib.frameDataLoad(frameIdx, 36)));

        if (callType == 0x00) {
            // SINGLE: value at offset 152 (132 + 20)
            return uint256(FrameTxLib.frameDataLoad(frameIdx, 152));
        } else if (callType == 0x01) {
            // BATCH: sum values from ABI-encoded Execution[]
            return _sumBatchValues(frameIdx);
        }
        // DELEGATECALL (0x02) and others: no value transfer
        return 0;
    }

    /// @dev Sum values from a batch execution's ABI-encoded Execution[] array.
    ///      executeHooked calldata layout for BATCH:
    ///        [132:...] = executionCalldata = abi.encode(Execution[])
    function _sumBatchValues(uint256 frameIdx) internal pure returns (uint256 total) {
        bytes memory data = FrameTxLib.frameData(frameIdx);

        // data = full executeHooked() calldata in memory:
        //   [0:4]     = selector
        //   [4:36]    = vId
        //   [36:68]   = execMode
        //   [68:100]  = offset to executionCalldata (0x60)
        //   [100:132] = length of executionCalldata
        //   [132:...] = executionCalldata = abi.encode(Execution[])
        //
        // executionCalldata ABI layout:
        //   [0:32]    = offset to array data (0x20)
        //   [32:64]   = array length (N)
        //   [64:...]  = per-element offsets, then element data
        //
        // Each Execution element:
        //   [0:32]  = target (address, padded)
        //   [32:64] = value (uint256)
        //   [64:96] = offset to callData
        //   [96:..] = callData (length + bytes)

        assembly {
            let contentStart := add(data, 0x20) // skip memory length prefix
            let ecStart := add(contentStart, 132) // executionCalldata bytes start

            // Read array: offset at ecStart, then length at ecStart+offset
            let arrDataOffset := mload(ecStart)
            let arrBase := add(ecStart, arrDataOffset)
            let arrLen := mload(arrBase)

            // Element offsets table starts at arrBase + 0x20
            let offsetsBase := add(arrBase, 0x20)

            for { let i := 0 } lt(i, arrLen) { i := add(i, 1) } {
                let elemOffset := mload(add(offsetsBase, mul(i, 0x20)))
                let elemPtr := add(offsetsBase, elemOffset)
                // value is the second 32-byte word in the element
                let value := mload(add(elemPtr, 0x20))
                total := add(total, value)
            }
        }
    }
}
