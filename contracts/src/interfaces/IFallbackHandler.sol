// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

/// @title IFallbackHandler
/// @notice Interface for fallback handlers in Kernel8141.
/// @dev Fallback handlers process calls to unknown selectors (e.g., ERC-1271, token callbacks).
interface IFallbackHandler {
    /// @notice Handle a fallback call
    /// @param selector The function selector that was called
    /// @param data The complete calldata (including selector)
    /// @return result The return data to send back to the caller
    function handleFallback(bytes4 selector, bytes calldata data)
        external
        returns (bytes memory result);

    /// @notice Called when the handler is installed
    /// @param data Initialization data (handler-specific)
    function onInstall(bytes calldata data) external;

    /// @notice Called when the handler is uninstalled
    function onUninstall() external;

    /// @notice Check if the handler is initialized for an account
    /// @param account The account address
    /// @return True if initialized
    function isInitialized(address account) external view returns (bool);
}
