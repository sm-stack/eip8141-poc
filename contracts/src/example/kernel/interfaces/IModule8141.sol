// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

/// @title IModule8141
/// @notice Base interface for all Kernel8141 modules (ERC-7579 aligned).
interface IModule8141 {
    error AlreadyInitialized(address smartAccount);
    error NotInitialized(address smartAccount);

    /// @notice Called by the smart account during module installation.
    /// @param data Arbitrary initialization data (module-specific).
    function onInstall(bytes calldata data) external payable;

    /// @notice Called by the smart account during module uninstallation.
    /// @param data Arbitrary de-initialization data (module-specific).
    function onUninstall(bytes calldata data) external payable;

    /// @notice Returns true if the module is of the given type.
    /// @param moduleTypeId The module type ID (1=validator, 2=executor, 3=fallback, 4=hook, 5=policy, 6=signer)
    function isModuleType(uint256 moduleTypeId) external view returns (bool);

    /// @notice Returns true if this module was already initialized for the given account.
    /// @param smartAccount The smart account address.
    function isInitialized(address smartAccount) external view returns (bool);
}
