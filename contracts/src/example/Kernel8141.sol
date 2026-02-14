// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {FrameTxLib} from "../FrameTxLib.sol";
import {IValidator8141} from "../interfaces/IValidator8141.sol";

/// @title Kernel8141
/// @notice Modular EIP-8141 smart account inspired by ZeroDev Kernel v3.
///
/// @dev Frame transaction patterns:
///
///   Simple Transaction:
///     Frame 0: VERIFY(kernel)  → kernel.validate(sig, scope=2)          → APPROVE(both)
///     Frame 1: SENDER(kernel)  → kernel.execute(target, value, data)
///
///   Sponsored Transaction:
///     Frame 0: VERIFY(kernel)  → kernel.validate(sig, scope=0)          → APPROVE(exec)
///     Frame 1: VERIFY(sponsor) → sponsor.validate()                     → APPROVE(pay)
///     Frame 2: SENDER(kernel)  → kernel.execute(erc20, 0, transfer...)
///     Frame 3: SENDER(kernel)  → kernel.execute(target, value, data)
///
///   Non-Root Validator:
///     Frame 0: VERIFY(kernel)  → kernel.validateWithValidator(v, sig, scope)
///     Frame 1: SENDER(kernel)  → kernel.execute(target, value, data)
contract Kernel8141 {
    address internal constant ENTRY_POINT = 0x00000000000000000000000000000000000000AA;

    IValidator8141 public rootValidator;
    mapping(IValidator8141 => bool) public isValidatorInstalled;
    bool public initialized;

    error NotInitialized();
    error AlreadyInitialized();
    error InvalidCaller();
    error InvalidSignature();
    error ExecutionFailed();
    error ValidatorNotInstalled();
    error ValidatorAlreadyInstalled();
    error CannotRemoveRootValidator();
    error BatchLengthMismatch();

    event Initialized(IValidator8141 rootValidator);
    event ValidatorInstalled(IValidator8141 validator);
    event ValidatorUninstalled(IValidator8141 validator);
    event RootValidatorChanged(IValidator8141 oldValidator, IValidator8141 newValidator);

    // ── Initialization ────────────────────────────────────────────────

    constructor(IValidator8141 _rootValidator, bytes memory _validatorData) {
        initialized = true;
        rootValidator = _rootValidator;
        isValidatorInstalled[_rootValidator] = true;
        _rootValidator.onInstall(_validatorData);
        emit Initialized(_rootValidator);
    }

    /// @notice Initialize the account (for factory/proxy deployments).
    function initialize(IValidator8141 _rootValidator, bytes calldata _validatorData) external {
        if (initialized) revert AlreadyInitialized();
        initialized = true;
        rootValidator = _rootValidator;
        isValidatorInstalled[_rootValidator] = true;
        _rootValidator.onInstall(_validatorData);
        emit Initialized(_rootValidator);
    }

    // ── Validation (VERIFY frame) ─────────────────────────────────────

    /// @notice Validate using the root validator. Called in a VERIFY frame.
    /// @param signature Raw signature bytes (format depends on validator)
    /// @param scope Approval scope: 0=execution, 1=payment, 2=both
    function validate(bytes calldata signature, uint8 scope) external view {
        if (msg.sender != ENTRY_POINT) revert InvalidCaller();
        if (!initialized) revert NotInitialized();

        bytes32 sigHash = FrameTxLib.sigHash();
        address account = FrameTxLib.txSender();

        bool valid = rootValidator.validateSignature(account, sigHash, signature);
        if (!valid) revert InvalidSignature();

        FrameTxLib.approveEmpty(scope);
    }

    /// @notice Validate with a specific installed validator.
    /// @param validator The validator to use
    /// @param signature Raw signature bytes
    /// @param scope Approval scope
    function validateWithValidator(
        IValidator8141 validator,
        bytes calldata signature,
        uint8 scope
    ) external view {
        if (msg.sender != ENTRY_POINT) revert InvalidCaller();
        if (!initialized) revert NotInitialized();
        if (!isValidatorInstalled[validator]) revert ValidatorNotInstalled();

        bytes32 sigHash = FrameTxLib.sigHash();
        address account = FrameTxLib.txSender();

        bool valid = validator.validateSignature(account, sigHash, signature);
        if (!valid) revert InvalidSignature();

        FrameTxLib.approveEmpty(scope);
    }

    // ── Execution (SENDER frame) ──────────────────────────────────────

    /// @notice Execute a single call. Called in a SENDER frame.
    function execute(address target, uint256 value, bytes calldata data) external {
        if (msg.sender != address(this)) revert InvalidCaller();
        (bool success,) = target.call{value: value}(data);
        if (!success) revert ExecutionFailed();
    }

    /// @notice Execute a batch of calls. Called in a SENDER frame.
    function executeBatch(
        address[] calldata targets,
        uint256[] calldata values,
        bytes[] calldata datas
    ) external {
        if (msg.sender != address(this)) revert InvalidCaller();
        if (targets.length != values.length || values.length != datas.length) revert BatchLengthMismatch();
        for (uint256 i = 0; i < targets.length; i++) {
            (bool success,) = targets[i].call{value: values[i]}(datas[i]);
            if (!success) revert ExecutionFailed();
        }
    }

    // ── Module Management (SENDER frame) ──────────────────────────────

    /// @notice Install a new validator.
    function installValidator(IValidator8141 validator, bytes calldata data) external {
        if (msg.sender != address(this)) revert InvalidCaller();
        if (isValidatorInstalled[validator]) revert ValidatorAlreadyInstalled();
        isValidatorInstalled[validator] = true;
        validator.onInstall(data);
        emit ValidatorInstalled(validator);
    }

    /// @notice Uninstall a validator (cannot uninstall root).
    function uninstallValidator(IValidator8141 validator) external {
        if (msg.sender != address(this)) revert InvalidCaller();
        if (address(validator) == address(rootValidator)) revert CannotRemoveRootValidator();
        if (!isValidatorInstalled[validator]) revert ValidatorNotInstalled();
        isValidatorInstalled[validator] = false;
        validator.onUninstall();
        emit ValidatorUninstalled(validator);
    }

    /// @notice Change the root validator (atomic swap).
    function changeRootValidator(IValidator8141 newValidator, bytes calldata data) external {
        if (msg.sender != address(this)) revert InvalidCaller();
        IValidator8141 oldValidator = rootValidator;
        isValidatorInstalled[oldValidator] = false;
        oldValidator.onUninstall();
        rootValidator = newValidator;
        isValidatorInstalled[newValidator] = true;
        newValidator.onInstall(data);
        emit RootValidatorChanged(oldValidator, newValidator);
    }

    receive() external payable {}
}
