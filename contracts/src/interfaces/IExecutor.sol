// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

/// @title IExecutor
/// @notice Interface for execution modules in Kernel8141.
/// @dev Executors handle custom execution logic and can be installed per-selector.
///      They are called during SENDER frames via Kernel's _executeWithConfig().
interface IExecutor {
    /// @notice Execute with custom logic
    /// @param target The target address for the call
    /// @param value The ETH value to send
    /// @param data The calldata for the call
    /// @return result The return data from the execution
    function executeWithData(
        address target,
        uint256 value,
        bytes calldata data
    ) external payable returns (bytes memory result);

    /// @notice Called when the executor is installed
    /// @param data Initialization data (executor-specific)
    function onInstall(bytes calldata data) external;

    /// @notice Called when the executor is uninstalled
    function onUninstall() external;

    /// @notice Check if the executor is initialized for an account
    /// @param account The account address
    /// @return True if initialized
    function isInitialized(address account) external view returns (bool);
}
