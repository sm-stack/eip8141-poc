// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {IModule8141} from "./IModule8141.sol";

/// @title IHook8141
/// @notice Unified hook interface for Kernel8141 (replaces split IPreExecutionHook + IPostExecutionHook).
/// @dev Hooks wrap execution with preCheck/postCheck. Context bytes flow from pre to post.
///      In EIP-8141, hooks can use FrameTxLib.frameDataLoad() to read cross-frame data,
///      and transient storage to pass state from VERIFY to SENDER frames.
interface IHook8141 is IModule8141 {
    /// @notice Pre-execution check. Returns context bytes for postCheck.
    /// @param msgSender The caller address
    /// @param msgValue The ETH value being sent
    /// @param msgData The calldata
    /// @return hookData Context bytes to pass to postCheck
    function preCheck(address msgSender, uint256 msgValue, bytes calldata msgData)
        external
        payable
        returns (bytes memory hookData);

    /// @notice Post-execution check. Receives context from preCheck.
    /// @param hookData The context bytes returned from preCheck
    function postCheck(bytes calldata hookData) external payable;
}
