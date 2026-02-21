// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {IModule8141} from "./IModule8141.sol";

/// @title IExecutor8141
/// @notice Executor module interface for Kernel8141 (ERC-7579 aligned).
/// @dev Executors are external contracts that can call executeFromExecutor() on the Kernel.
///      The executor itself is a marker module — execution logic lives in the executor contract.
///      Kernel v3 pattern: IExecutor is just IModule (no extra functions).
interface IExecutor8141 is IModule8141 {}
