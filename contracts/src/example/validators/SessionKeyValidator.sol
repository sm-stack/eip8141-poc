// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {IValidator8141} from "../../interfaces/IValidator8141.sol";

/// @title SessionKeyValidator
/// @notice Validator for time-bounded, permission-restricted session keys.
/// @dev Storage layout optimized for single-slot packing where possible.
contract SessionKeyValidator is IValidator8141 {
    // Packed struct (256 bits total = 1 slot)
    struct SessionKey {
        address signer;           // 160 bits - session key address
        uint48 validAfter;        // 48 bits - start timestamp
        uint48 validUntil;        // 48 bits - end timestamp
    }

    // Separate storage for dynamic arrays (cannot pack)
    struct SessionPermissions {
        uint256 spendingLimit;    // Max ETH per session (total, not daily)
        uint256 spentAmount;      // Cumulative spent
        bytes4[] allowedSelectors; // Whitelisted functions (empty = any)
        address[] allowedTargets;  // Whitelisted contracts (empty = any)
    }

    // Two-level mapping: account → sessionKeyAddress → data
    mapping(address => mapping(address => SessionKey)) public sessionKeys;
    mapping(address => mapping(address => SessionPermissions)) public sessionPermissions;

    // Active session keys per account (for enumeration)
    mapping(address => address[]) internal _activeSessions;

    error SessionNotFound();
    error SessionExpired();
    error SessionNotYetValid();
    error SpendingLimitExceeded(uint256 requested, uint256 available);
    error SelectorNotAllowed(bytes4 selector);
    error TargetNotAllowed(address target);
    error InvalidSessionKey();
    error InvalidTimeWindow();
    error SessionKeyAlreadyExists();

    event SessionKeyAdded(
        address indexed account,
        address indexed sessionKey,
        uint48 validAfter,
        uint48 validUntil,
        uint256 spendingLimit
    );
    event SessionKeyRevoked(address indexed account, address indexed sessionKey);
    event SessionSpent(address indexed account, address indexed sessionKey, uint256 amount);

    /// @inheritdoc IValidator8141
    function validateSignature(
        address account,
        bytes32 sigHash,
        bytes calldata signature
    ) external override returns (bool valid) {
        // Signature format: [sessionKeyAddress(20)][sessionSignature(65)]
        if (signature.length != 85) return false;

        address sessionKeyAddr = address(bytes20(signature[0:20]));
        bytes calldata sessionSig = signature[20:85];

        SessionKey storage session = sessionKeys[account][sessionKeyAddr];

        // 1. Check session exists
        if (session.signer == address(0)) return false;

        // 2. Check time window
        if (block.timestamp < session.validAfter) return false;
        if (block.timestamp > session.validUntil) return false;

        // 3. Verify ECDSA signature
        bytes32 r = bytes32(sessionSig[0:32]);
        bytes32 s = bytes32(sessionSig[32:64]);
        uint8 v = uint8(sessionSig[64]);
        if (v < 27) v += 27;

        address signer = ecrecover(sigHash, v, r, s);
        if (signer != session.signer) return false;

        // 4. Store session key in transient storage for hook to access
        assembly {
            tstore(account, sessionKeyAddr)
        }

        return true;
    }

    /// @notice Add a new session key for the calling account
    /// @dev Must be called from the account itself (via kernel.execute)
    function addSessionKey(
        address sessionKey,
        uint48 validAfter,
        uint48 validUntil,
        uint256 spendingLimit,
        bytes4[] calldata allowedSelectors,
        address[] calldata allowedTargets
    ) external {
        address account = msg.sender;

        if (sessionKey == address(0)) revert InvalidSessionKey();
        if (validUntil <= validAfter) revert InvalidTimeWindow();
        if (sessionKeys[account][sessionKey].signer != address(0)) {
            revert SessionKeyAlreadyExists();
        }

        sessionKeys[account][sessionKey] = SessionKey({
            signer: sessionKey,
            validAfter: validAfter,
            validUntil: validUntil
        });

        sessionPermissions[account][sessionKey] = SessionPermissions({
            spendingLimit: spendingLimit,
            spentAmount: 0,
            allowedSelectors: allowedSelectors,
            allowedTargets: allowedTargets
        });

        _activeSessions[account].push(sessionKey);

        emit SessionKeyAdded(account, sessionKey, validAfter, validUntil, spendingLimit);
    }

    /// @notice Revoke a session key
    function revokeSessionKey(address sessionKey) external {
        address account = msg.sender;

        if (sessionKeys[account][sessionKey].signer == address(0)) {
            revert SessionNotFound();
        }

        delete sessionKeys[account][sessionKey];
        delete sessionPermissions[account][sessionKey];

        // Remove from active sessions array
        address[] storage sessions = _activeSessions[account];
        for (uint i = 0; i < sessions.length; i++) {
            if (sessions[i] == sessionKey) {
                sessions[i] = sessions[sessions.length - 1];
                sessions.pop();
                break;
            }
        }

        emit SessionKeyRevoked(account, sessionKey);
    }

    /// @notice Record spending for a session key
    /// @dev Called by SessionKeyPermissionHook
    function recordSpending(address account, address sessionKey, uint256 amount) external {
        sessionPermissions[account][sessionKey].spentAmount += amount;
        emit SessionSpent(account, sessionKey, amount);
    }

    /// @notice Get all active session keys for an account
    function getActiveSessions(address account)
        external view returns (address[] memory)
    {
        return _activeSessions[account];
    }

    /// @notice Get session permissions
    function getPermissions(address account, address sessionKey)
        external view returns (SessionPermissions memory)
    {
        return sessionPermissions[account][sessionKey];
    }

    /// @inheritdoc IValidator8141
    function onInstall(bytes calldata) external pure override {
        // Stateless validator, no installation needed
    }

    /// @inheritdoc IValidator8141
    function onUninstall() external pure override {
        // Stateless validator, no uninstallation needed
    }

    /// @inheritdoc IValidator8141
    function isInitialized(address) external pure override returns (bool) {
        return true; // Stateless, always initialized
    }
}
