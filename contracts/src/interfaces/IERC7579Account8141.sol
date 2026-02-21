// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {ExecMode} from "../types/Types8141.sol";

/// @title IERC7579Account8141
/// @notice ERC-7579 compatible account interface for Kernel8141.
/// @dev Adapted from ERC-7579 for EIP-8141 frame transactions.
///      Key difference: no validateUserOp (replaced by VERIFY frame validation).
interface IERC7579Account8141 {
    event ModuleInstalled(uint256 moduleTypeId, address module);
    event ModuleUninstalled(uint256 moduleTypeId, address module);

    // ── Execution ─────────────────────────────────────────────────────

    /// @notice Execute a transaction on behalf of the account.
    /// @dev Called in SENDER frame. Authorization via VERIFY frame + hook wrapping.
    /// @param mode The encoded execution mode (CallType + ExecType + ModeSelector + ModePayload)
    /// @param executionCalldata The encoded execution data (format depends on CallType)
    function execute(ExecMode mode, bytes calldata executionCalldata) external payable;

    /// @notice Execute a transaction from an authorized executor module.
    /// @dev Only callable by installed executor modules.
    /// @param mode The encoded execution mode
    /// @param executionCalldata The encoded execution data
    /// @return returnData Array of return data from each execution
    function executeFromExecutor(ExecMode mode, bytes calldata executionCalldata)
        external
        payable
        returns (bytes[] memory returnData);

    // ── ERC-1271 ──────────────────────────────────────────────────────

    /// @notice ERC-1271 signature validation.
    /// @dev Routes to the appropriate validator based on the signature prefix.
    /// @param hash The hash of the data that is signed
    /// @param data The signature data (prefixed with ValidationId)
    /// @return magicValue 0x1626ba7e for valid, 0xffffffff for invalid
    function isValidSignature(bytes32 hash, bytes calldata data) external view returns (bytes4 magicValue);

    // ── Module Management ─────────────────────────────────────────────

    /// @notice Install a module on the smart account.
    /// @param moduleTypeId The module type (1=validator, 2=executor, 3=fallback, 4=hook, 5=policy, 6=signer)
    /// @param module The module address
    /// @param initData Initialization data for the module
    function installModule(uint256 moduleTypeId, address module, bytes calldata initData) external payable;

    /// @notice Uninstall a module from the smart account.
    /// @param moduleTypeId The module type
    /// @param module The module address
    /// @param deInitData De-initialization data for the module
    function uninstallModule(uint256 moduleTypeId, address module, bytes calldata deInitData) external payable;

    // ── Introspection ─────────────────────────────────────────────────

    /// @notice Check if the account supports a given execution mode.
    /// @param encodedMode The encoded execution mode to check
    function supportsExecutionMode(ExecMode encodedMode) external view returns (bool);

    /// @notice Check if the account supports a given module type.
    /// @param moduleTypeId The module type ID to check
    function supportsModule(uint256 moduleTypeId) external view returns (bool);

    /// @notice Check if a module is currently installed.
    /// @param moduleTypeId The module type
    /// @param module The module address
    /// @param additionalContext Additional context for modules stored in mappings
    function isModuleInstalled(uint256 moduleTypeId, address module, bytes calldata additionalContext)
        external
        view
        returns (bool);

    /// @notice Returns the account implementation ID.
    /// @return accountImplementationId Format: "vendorname.accountname.semver"
    function accountId() external view returns (string memory accountImplementationId);
}
