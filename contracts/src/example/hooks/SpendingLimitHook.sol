// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {IPreExecutionHook} from "../../interfaces/IHook.sol";

/// @title SpendingLimitHook
/// @notice Pre-execution hook that enforces daily spending limits.
/// @dev Tracks daily spending per account and reverts if limit is exceeded.
contract SpendingLimitHook is IPreExecutionHook {
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

    /// @inheritdoc IPreExecutionHook
    function preExecute(
        address, // target
        uint256 value,
        bytes calldata // data
    ) external {
        SpendingState storage state = spendingStates[msg.sender];

        // Reset if new day
        uint256 today = block.timestamp / 1 days;
        if (state.lastResetDay < today) {
            state.spentToday = 0;
            state.lastResetDay = today;
        }

        // Check limit
        uint256 available = state.dailyLimit - state.spentToday;
        if (value > available) {
            revert DailyLimitExceeded(value, available);
        }

        // Record spending
        state.spentToday += value;
        emit SpendingRecorded(msg.sender, value, state.spentToday);
    }

    /// @inheritdoc IPreExecutionHook
    /// @dev data is abi.encode(uint256 dailyLimit)
    function onInstall(bytes calldata data) external {
        uint256 dailyLimit = abi.decode(data, (uint256));
        if (dailyLimit == 0) revert InvalidDailyLimit();

        spendingStates[msg.sender] = SpendingState({
            dailyLimit: dailyLimit,
            spentToday: 0,
            lastResetDay: block.timestamp / 1 days
        });

        emit DailyLimitSet(msg.sender, dailyLimit);
    }

    /// @inheritdoc IPreExecutionHook
    function onUninstall() external {
        delete spendingStates[msg.sender];
    }

    /// @inheritdoc IPreExecutionHook
    function isInitialized(address account) external view returns (bool) {
        return spendingStates[account].dailyLimit > 0;
    }

    /// @notice Update the daily limit for the calling account
    /// @dev Must be called from the account itself (via kernel.execute)
    function setDailyLimit(uint256 newLimit) external {
        if (newLimit == 0) revert InvalidDailyLimit();
        spendingStates[msg.sender].dailyLimit = newLimit;
        emit DailyLimitSet(msg.sender, newLimit);
    }
}
