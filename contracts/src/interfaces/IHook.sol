// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

/// @title IPreExecutionHook
/// @notice Interface for pre-execution hooks in Kernel8141.
/// @dev Pre-hooks are called before execution in _executeWithConfig().
///      They can revert to block execution (e.g., policy enforcement).
interface IPreExecutionHook {
    /// @notice Called before execute() - can revert to block execution
    /// @param target The target address for the call
    /// @param value The ETH value to send
    /// @param data The calldata for the call
    function preExecute(
        address target,
        uint256 value,
        bytes calldata data
    ) external;

    /// @notice Called when the hook is installed
    /// @param data Initialization data (hook-specific)
    function onInstall(bytes calldata data) external;

    /// @notice Called when the hook is uninstalled
    function onUninstall() external;

    /// @notice Check if the hook is initialized for an account
    /// @param account The account address
    /// @return True if initialized
    function isInitialized(address account) external view returns (bool);
}

/// @title IPostExecutionHook
/// @notice Interface for post-execution hooks in Kernel8141.
/// @dev Post-hooks are called after successful execution in _executeWithConfig().
///      They can be used for logging, state updates, or notifications.
interface IPostExecutionHook {
    /// @notice Called after successful execute()
    /// @param target The target address that was called
    /// @param value The ETH value that was sent
    /// @param result The return data from the execution
    function postExecute(
        address target,
        uint256 value,
        bytes calldata result
    ) external;

    /// @notice Called when the hook is installed
    /// @param data Initialization data (hook-specific)
    function onInstall(bytes calldata data) external;

    /// @notice Called when the hook is uninstalled
    function onUninstall() external;

    /// @notice Check if the hook is initialized for an account
    /// @param account The account address
    /// @return True if initialized
    function isInitialized(address account) external view returns (bool);
}
