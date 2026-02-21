// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {IModule8141} from "./IModule8141.sol";

/// @title IFallback8141
/// @notice Fallback handler module interface for Kernel8141 (ERC-7579 aligned).
/// @dev Fallback handlers are routed to via the Kernel's fallback() function based on selector.
///      Kernel v3 pattern: IFallback is just IModule (no extra functions).
interface IFallback8141 is IModule8141 {}
