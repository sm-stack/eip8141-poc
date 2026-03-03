// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {IPolicy8141} from "../interfaces/IPolicy8141.sol";
import {MODULE_TYPE_POLICY} from "../types/Constants8141.sol";
import {ValidAfter, ValidUntil, packValidationData} from "../types/Types8141.sol";

/// @title TimestampPolicy8141
/// @notice Permission policy that enforces time-bounded validity windows.
/// @dev Returns packValidationData(validAfter, validUntil) from checkFrameTxPolicy(),
///      which flows through _intersectValidationData() to compose with other policies.
///      Ported from Kernel v3's TimestampPolicy.
contract TimestampPolicy8141 is IPolicy8141 {
    struct TimestampConfig {
        ValidAfter validAfter;
        ValidUntil validUntil;
    }

    mapping(address => mapping(bytes32 => TimestampConfig)) public configs;

    error InvalidTimeWindow();

    event TimeWindowSet(address indexed account, bytes32 indexed id, uint48 validAfter, uint48 validUntil);

    // ── IPolicy8141: VERIFY phase ─────────────────────────────────────

    /// @inheritdoc IPolicy8141
    /// @dev Returns packed ValidationData with time bounds.
    ///      _intersectValidationData takes MAX(validAfter) and MIN(validUntil)
    ///      across all policies, enforcing the most restrictive window.
    function checkFrameTxPolicy(bytes32 id, address, bytes32, uint256)
        external
        view
        override
        returns (uint256)
    {
        TimestampConfig memory config = configs[msg.sender][id];
        return packValidationData(config.validAfter, config.validUntil);
    }

    // ── IPolicy8141: SENDER phase ─────────────────────────────────────

    /// @inheritdoc IPolicy8141
    /// @dev No-op: TimestampPolicy is read-only, no state to consume.
    function consumeFrameTxPolicy(bytes32, address) external override {}

    /// @inheritdoc IPolicy8141
    function checkSignaturePolicy(bytes32 id, address, bytes32, bytes calldata)
        external
        view
        override
        returns (uint256)
    {
        TimestampConfig memory config = configs[msg.sender][id];
        return packValidationData(config.validAfter, config.validUntil);
    }

    // ── IModule8141 ───────────────────────────────────────────────────

    /// @dev initData format: abi.encodePacked(bytes32 permissionId, uint48 validAfter, uint48 validUntil)
    function onInstall(bytes calldata data) external payable override {
        bytes32 id = bytes32(data[0:32]);
        uint48 validAfter = uint48(bytes6(data[32:38]));
        uint48 validUntil = uint48(bytes6(data[38:44]));
        if (validUntil != 0 && validUntil <= validAfter) revert InvalidTimeWindow();

        configs[msg.sender][id] = TimestampConfig(ValidAfter.wrap(validAfter), ValidUntil.wrap(validUntil));
        emit TimeWindowSet(msg.sender, id, validAfter, validUntil);
    }

    function onUninstall(bytes calldata data) external payable override {
        bytes32 id = bytes32(data[0:32]);
        delete configs[msg.sender][id];
    }

    function isModuleType(uint256 typeID) external pure override returns (bool) {
        return typeID == MODULE_TYPE_POLICY;
    }

    function isInitialized(address) external pure override returns (bool) {
        return true;
    }
}
