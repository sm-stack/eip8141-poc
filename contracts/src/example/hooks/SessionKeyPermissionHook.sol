// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {IPreExecutionHook} from "../../interfaces/IHook.sol";
import {SessionKeyValidator} from "../validators/SessionKeyValidator.sol";

/// @title SessionKeyPermissionHook
/// @notice Pre-execution hook that enforces session key permissions.
/// @dev Must be installed alongside SessionKeyValidator.
contract SessionKeyPermissionHook is IPreExecutionHook {
    SessionKeyValidator public immutable sessionKeyValidator;

    error SpendingLimitExceeded(uint256 requested, uint256 available);
    error SelectorNotAllowed(bytes4 selector);
    error TargetNotAllowed(address target);

    constructor(SessionKeyValidator _validator) {
        sessionKeyValidator = _validator;
    }

    /// @inheritdoc IPreExecutionHook
    function preExecute(
        address target,
        uint256 value,
        bytes calldata data
    ) external override {
        // msg.sender = kernel
        address account = msg.sender;

        // Retrieve session key from transient storage (set during validation)
        address sessionKeyAddr;
        assembly {
            sessionKeyAddr := tload(account)
        }

        // If no session key in transient storage, this is not a session key transaction
        if (sessionKeyAddr == address(0)) return;

        SessionKeyValidator.SessionPermissions memory perms =
            sessionKeyValidator.getPermissions(account, sessionKeyAddr);

        // 1. Check spending limit
        if (value > 0) {
            uint256 available = perms.spendingLimit - perms.spentAmount;
            if (value > available) {
                revert SpendingLimitExceeded(value, available);
            }
            // Record spending
            sessionKeyValidator.recordSpending(account, sessionKeyAddr, value);
        }

        // 2. Check selector whitelist
        if (perms.allowedSelectors.length > 0 && data.length >= 4) {
            bytes4 selector = bytes4(data[0:4]);
            bool allowed = false;
            for (uint i = 0; i < perms.allowedSelectors.length; i++) {
                if (perms.allowedSelectors[i] == selector) {
                    allowed = true;
                    break;
                }
            }
            if (!allowed) revert SelectorNotAllowed(selector);
        }

        // 3. Check target whitelist
        if (perms.allowedTargets.length > 0) {
            bool allowed = false;
            for (uint i = 0; i < perms.allowedTargets.length; i++) {
                if (perms.allowedTargets[i] == target) {
                    allowed = true;
                    break;
                }
            }
            if (!allowed) revert TargetNotAllowed(target);
        }
    }

    /// @inheritdoc IPreExecutionHook
    function onInstall(bytes calldata) external pure override {
        // Stateless hook, no installation needed
    }

    /// @inheritdoc IPreExecutionHook
    function onUninstall() external pure override {
        // Stateless hook, no uninstallation needed
    }

    /// @inheritdoc IPreExecutionHook
    function isInitialized(address) external pure override returns (bool) {
        return true; // Stateless, always initialized
    }
}
