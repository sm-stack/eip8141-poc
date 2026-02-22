// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {IHook8141} from "../interfaces/IHook8141.sol";
import {MODULE_TYPE_HOOK} from "../types/Constants8141.sol";
import {FrameTxLib} from "../../../FrameTxLib.sol";

/// @title SpendingLimitHook
/// @notice Enforces daily spending limits as a DEFAULT frame target.
/// @dev Frame-native hook: called directly in a DEFAULT frame, uses TXPARAM
///      to read account identity (txSender) and execution value (frameDataLoad on SENDER frame).
///
///      Frame pattern:
///        Frame 0: DEFAULT(this) → check()           — pre-check spending limit
///        Frame 1: VERIFY(kernel) → validate()        — verifies frameStatus(0)==SUCCESS
///        Frame 2: SENDER(kernel) → execute()
///
///      Also retains IHook8141 interface for backward compatibility (fallback handler hooks).
contract SpendingLimitHook is IHook8141 {
    struct SpendingState {
        uint256 dailyLimit;
        uint256 spentToday;
        uint256 lastResetDay;
    }

    mapping(address => SpendingState) public spendingStates;

    error DailyLimitExceeded(uint256 requested, uint256 available);
    error InvalidDailyLimit();

    event DailyLimitSet(address indexed account, uint256 dailyLimit);
    event SpendingRecorded(address indexed account, uint256 amount, uint256 totalToday);

    // ── DEFAULT frame entry point ─────────────────────────────────────

    /// @notice Called from a DEFAULT frame. Uses TXPARAM to read account and spending value.
    /// @dev msg.sender = ENTRY_POINT (0xaa) in DEFAULT frames. Account identified via txSender().
    ///      Value extracted from SENDER frame's execute() calldata via frameDataLoad().
    function check() external {
        address account = FrameTxLib.txSender();

        // Find the SENDER frame to read execution value
        uint256 senderIdx = _findSenderFrame();
        uint256 totalValue = _extractValueFromSenderFrame(senderIdx);

        if (totalValue == 0) return;

        // Check and record spending
        SpendingState storage state = spendingStates[account];

        // Reset if new day
        uint256 today = block.timestamp / 1 days;
        if (state.lastResetDay < today) {
            state.spentToday = 0;
            state.lastResetDay = today;
        }

        uint256 available = state.dailyLimit - state.spentToday;
        if (totalValue > available) {
            revert DailyLimitExceeded(totalValue, available);
        }

        state.spentToday += totalValue;
        emit SpendingRecorded(account, totalValue, state.spentToday);
    }

    // ── IHook8141 (backward compatibility for fallback hooks) ─────────

    /// @inheritdoc IHook8141
    function preCheck(address, uint256 msgValue, bytes calldata)
        external
        payable
        override
        returns (bytes memory hookData)
    {
        SpendingState storage state = spendingStates[msg.sender];

        uint256 today = block.timestamp / 1 days;
        if (state.lastResetDay < today) {
            state.spentToday = 0;
            state.lastResetDay = today;
        }

        uint256 available = state.dailyLimit - state.spentToday;
        if (msgValue > available) {
            revert DailyLimitExceeded(msgValue, available);
        }

        state.spentToday += msgValue;
        emit SpendingRecorded(msg.sender, msgValue, state.spentToday);

        return abi.encode(msgValue);
    }

    /// @inheritdoc IHook8141
    function postCheck(bytes calldata) external payable override {}

    // ── IModule8141 ─────────────────────────────────────────────────────

    function onInstall(bytes calldata data) external payable override {
        uint256 dailyLimit = abi.decode(data, (uint256));
        if (dailyLimit == 0) revert InvalidDailyLimit();

        spendingStates[msg.sender] =
            SpendingState({dailyLimit: dailyLimit, spentToday: 0, lastResetDay: block.timestamp / 1 days});

        emit DailyLimitSet(msg.sender, dailyLimit);
    }

    function onUninstall(bytes calldata) external payable override {
        delete spendingStates[msg.sender];
    }

    function isModuleType(uint256 typeID) external pure override returns (bool) {
        return typeID == MODULE_TYPE_HOOK;
    }

    function isInitialized(address account) external view override returns (bool) {
        return spendingStates[account].dailyLimit > 0;
    }

    // ── Admin ───────────────────────────────────────────────────────────

    function setDailyLimit(uint256 newLimit) external {
        if (newLimit == 0) revert InvalidDailyLimit();
        spendingStates[msg.sender].dailyLimit = newLimit;
        emit DailyLimitSet(msg.sender, newLimit);
    }

    // ── Internal: Frame data parsing ────────────────────────────────────

    /// @dev Find the first SENDER frame in the transaction.
    function _findSenderFrame() internal pure returns (uint256) {
        uint256 count = FrameTxLib.frameCount();
        for (uint256 i = 0; i < count; i++) {
            if (FrameTxLib.frameMode(i) == 2) return i; // SENDER mode
        }
        revert("No SENDER frame");
    }

    /// @dev Extract the total ETH value from a SENDER frame's execute() calldata.
    ///      Supports CALLTYPE_SINGLE and CALLTYPE_BATCH.
    ///
    ///      SENDER frame calldata layout (ABI-encoded execute call):
    ///        [0:4]     = selector (execute)
    ///        [4:36]    = ExecMode (first byte = CallType)
    ///        [36:68]   = offset to executionCalldata
    ///        [68:100]  = length of executionCalldata
    ///        [100:...] = executionCalldata bytes
    ///
    ///      SINGLE executionCalldata (packed, not ABI-encoded):
    ///        [0:20]  = target address
    ///        [20:52] = value (uint256)
    ///        [52:..] = callData
    ///
    ///      BATCH executionCalldata = abi.encode(Execution[])
    function _extractValueFromSenderFrame(uint256 idx) internal pure returns (uint256) {
        // Read ExecMode to determine call type
        bytes32 execModeWord = FrameTxLib.frameDataLoad(idx, 4); // skip 4B selector
        uint8 callType = uint8(bytes1(execModeWord));

        if (callType == 0x00) {
            // SINGLE: value is at executionCalldata[20:52]
            // Frame offset: 4(sel) + 32(mode) + 32(offset) + 32(len) + 20(target) = 120
            return uint256(FrameTxLib.frameDataLoad(idx, 120));
        } else if (callType == 0x01) {
            // BATCH: sum values from ABI-encoded Execution[]
            return _sumBatchValues(idx);
        }
        // DELEGATECALL (0x02) and others: no value transfer
        return 0;
    }

    /// @dev Sum values from a batch execution's ABI-encoded Execution[] array.
    ///      Reads frame data into memory and walks the ABI structure.
    function _sumBatchValues(uint256 senderIdx) internal pure returns (uint256 total) {
        bytes memory data = FrameTxLib.frameData(senderIdx);

        // data (in memory) = full execute() calldata:
        //   [0:4]     = selector
        //   [4:36]    = ExecMode
        //   [36:68]   = offset to executionCalldata (0x40)
        //   [68:100]  = length of executionCalldata
        //   [100:...] = executionCalldata = abi.encode(Execution[])
        //
        // executionCalldata internal ABI layout:
        //   [0:32]    = offset to array data (0x20)
        //   [32:64]   = array length (N)
        //   [64:...]  = per-element offsets (32B each), then element data
        //
        // Each element:
        //   [0:32]  = target (address, padded)
        //   [32:64] = value (uint256)
        //   [64:96] = offset to callData
        //   [96:..] = callData (length + bytes)

        assembly {
            let contentStart := add(data, 0x20) // skip memory length prefix
            let ecStart := add(contentStart, 100) // executionCalldata bytes start

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
