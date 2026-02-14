// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {FrameTxLib} from "../FrameTxLib.sol";
import {IValidator8141} from "../interfaces/IValidator8141.sol";
import {IExecutor} from "../interfaces/IExecutor.sol";
import {IPreExecutionHook, IPostExecutionHook} from "../interfaces/IHook.sol";

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

    // Frame modes
    uint8 internal constant FRAME_MODE_DEFAULT = 0;
    uint8 internal constant FRAME_MODE_VERIFY  = 1;
    uint8 internal constant FRAME_MODE_SENDER  = 2;

    // ── Core State ────────────────────────────────────────────────────────
    IValidator8141 public rootValidator;
    mapping(IValidator8141 => bool) public isValidatorInstalled;
    bool public initialized;

    // ── Per-Selector Execution Config (Kernel v3 pattern) ────────────────
    struct ExecutionConfig {
        uint48 validAfter;
        uint48 validUntil;
        IExecutor executor;
        uint8 allowedFrameModes;  // VERIFY(1) | SENDER(2) | BOTH(3)
    }
    mapping(bytes4 => ExecutionConfig) public executionConfig;

    // ── Per-Selector Hooks ────────────────────────────────────────────────
    mapping(bytes4 => IPreExecutionHook[]) internal _preHooks;
    mapping(bytes4 => IPostExecutionHook[]) internal _postHooks;

    // ── Module Registry ───────────────────────────────────────────────────
    enum ModuleType { VALIDATOR, EXECUTOR, PRE_HOOK, POST_HOOK }
    mapping(address => ModuleType) public moduleTypes;
    mapping(address => bool) public isModuleInstalled;

    error NotInitialized();
    error AlreadyInitialized();
    error InvalidCaller();
    error InvalidSignature();
    error ExecutionFailed();
    error ValidatorNotInstalled();
    error ValidatorAlreadyInstalled();
    error CannotRemoveRootValidator();
    error BatchLengthMismatch();
    error ModuleAlreadyInstalled();
    error ModuleNotInstalled();
    error InvalidFrameMode();
    error TimeRestriction();

    event Initialized(IValidator8141 rootValidator);
    event ValidatorInstalled(IValidator8141 validator);
    event ValidatorUninstalled(IValidator8141 validator);
    event RootValidatorChanged(IValidator8141 oldValidator, IValidator8141 newValidator);
    event ModuleInstalled(ModuleType moduleType, address module);
    event ModuleUninstalled(ModuleType moduleType, address module);

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
        _executeWithConfig(msg.sig, target, value, data);
    }

    /// @notice Execute a batch of calls. Called in a SENDER frame.
    function executeBatch(
        address[] calldata targets,
        uint256[] calldata values,
        bytes[] calldata datas
    ) external {
        bytes memory encoded = abi.encode(targets, values, datas);
        _executeWithConfigMemory(msg.sig, address(0), 0, encoded);
    }

    /// @notice Internal execution with config-based hooks and validation (calldata version)
    function _executeWithConfig(
        bytes4 selector,
        address target,
        uint256 value,
        bytes calldata data
    ) internal {
        _executeWithConfigMemory(selector, target, value, data);
    }

    /// @notice Internal execution with config-based hooks and validation (memory version)
    function _executeWithConfigMemory(
        bytes4 selector,
        address target,
        uint256 value,
        bytes memory data
    ) internal {
        if (msg.sender != address(this)) revert InvalidCaller();

        ExecutionConfig storage config = executionConfig[selector];

        // 1. Frame mode enforcement (EIP-8141 unique)
        // Only enforce if config exists (allowedFrameModes != 0)
        if (config.allowedFrameModes != 0) {
            uint8 currentMode = FrameTxLib.currentFrameMode();
            if (config.allowedFrameModes & currentMode == 0) revert InvalidFrameMode();
        }

        // 2. Time-based validation (Kernel v3)
        if (config.validAfter != 0 || config.validUntil != 0) {
            if (block.timestamp < config.validAfter || block.timestamp > config.validUntil) {
                revert TimeRestriction();
            }
        }

        // 3. Pre-hooks
        IPreExecutionHook[] storage preHooks = _preHooks[selector];
        for (uint256 i = 0; i < preHooks.length; i++) {
            preHooks[i].preExecute(target, value, data);
        }

        // 4. Execute via executor or direct call
        bytes memory result;
        if (address(config.executor) != address(0)) {
            result = config.executor.executeWithData(target, value, data);
        } else {
            // Direct execution for backward compatibility
            if (selector == this.executeBatch.selector) {
                // Decode batch data
                (address[] memory targets, uint256[] memory values, bytes[] memory datas) =
                    abi.decode(data, (address[], uint256[], bytes[]));
                if (targets.length != values.length || values.length != datas.length) {
                    revert BatchLengthMismatch();
                }
                for (uint256 i = 0; i < targets.length; i++) {
                    (bool success,) = targets[i].call{value: values[i]}(datas[i]);
                    if (!success) revert ExecutionFailed();
                }
                result = "";
            } else {
                (bool success, bytes memory ret) = target.call{value: value}(data);
                if (!success) revert ExecutionFailed();
                result = ret;
            }
        }

        // 5. Post-hooks
        IPostExecutionHook[] storage postHooks = _postHooks[selector];
        for (uint256 i = 0; i < postHooks.length; i++) {
            postHooks[i].postExecute(target, value, result);
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

    // ── Unified Module System (Kernel v3 style) ──────────────────────

    /// @notice Install a module (validator, executor, or hook)
    function installModule(
        ModuleType moduleType,
        address module,
        bytes calldata config
    ) external {
        if (msg.sender != address(this)) revert InvalidCaller();
        if (isModuleInstalled[module]) revert ModuleAlreadyInstalled();

        if (moduleType == ModuleType.VALIDATOR) {
            _installValidator(IValidator8141(module), config);
        } else if (moduleType == ModuleType.EXECUTOR) {
            _installExecutor(IExecutor(module), config);
        } else if (moduleType == ModuleType.PRE_HOOK) {
            _installPreHook(IPreExecutionHook(module), config);
        } else if (moduleType == ModuleType.POST_HOOK) {
            _installPostHook(IPostExecutionHook(module), config);
        }

        moduleTypes[module] = moduleType;
        isModuleInstalled[module] = true;
        emit ModuleInstalled(moduleType, module);
    }

    /// @notice Uninstall a module
    function uninstallModule(address module) external {
        if (msg.sender != address(this)) revert InvalidCaller();
        if (!isModuleInstalled[module]) revert ModuleNotInstalled();

        ModuleType moduleType = moduleTypes[module];

        if (moduleType == ModuleType.VALIDATOR) {
            IValidator8141 validator = IValidator8141(module);
            if (address(validator) == address(rootValidator)) revert CannotRemoveRootValidator();
            if (!isValidatorInstalled[validator]) revert ValidatorNotInstalled();
            isValidatorInstalled[validator] = false;
            validator.onUninstall();
        } else if (moduleType == ModuleType.EXECUTOR) {
            IExecutor(module).onUninstall();
            // Note: executionConfig cleanup would require tracking which selectors
            // are associated with this executor. For simplicity, we don't clean up
            // executionConfig here. It can be overwritten by installing a new executor.
        } else if (moduleType == ModuleType.PRE_HOOK || moduleType == ModuleType.POST_HOOK) {
            // Hook removal requires knowing which selectors it's attached to.
            // For simplicity, we just call onUninstall. Hooks remain in arrays
            // but should handle being uninstalled gracefully.
            if (moduleType == ModuleType.PRE_HOOK) {
                IPreExecutionHook(module).onUninstall();
            } else {
                IPostExecutionHook(module).onUninstall();
            }
        }

        isModuleInstalled[module] = false;
        emit ModuleUninstalled(moduleType, module);
    }

    function _installValidator(IValidator8141 validator, bytes calldata config) internal {
        if (isValidatorInstalled[validator]) revert ValidatorAlreadyInstalled();
        isValidatorInstalled[validator] = true;
        validator.onInstall(config);
    }

    function _installExecutor(IExecutor executor, bytes calldata config) internal {
        // config = abi.encode(bytes4[] selectors, uint48 validAfter, uint48 validUntil, uint8 frameModes)
        (bytes4[] memory selectors, uint48 validAfter, uint48 validUntil, uint8 frameModes) =
            abi.decode(config, (bytes4[], uint48, uint48, uint8));

        for (uint256 i = 0; i < selectors.length; i++) {
            executionConfig[selectors[i]] = ExecutionConfig({
                validAfter: validAfter,
                validUntil: validUntil,
                executor: executor,
                allowedFrameModes: frameModes
            });
        }

        executor.onInstall(config);
    }

    function _installPreHook(IPreExecutionHook hook, bytes calldata config) internal {
        // config = abi.encode(bytes4[] selectors, bytes hookData)
        (bytes4[] memory selectors, bytes memory hookData) = abi.decode(config, (bytes4[], bytes));

        for (uint256 i = 0; i < selectors.length; i++) {
            _preHooks[selectors[i]].push(hook);
        }

        hook.onInstall(hookData);
    }

    function _installPostHook(IPostExecutionHook hook, bytes calldata config) internal {
        // config = abi.encode(bytes4[] selectors, bytes hookData)
        (bytes4[] memory selectors, bytes memory hookData) = abi.decode(config, (bytes4[], bytes));

        for (uint256 i = 0; i < selectors.length; i++) {
            _postHooks[selectors[i]].push(hook);
        }

        hook.onInstall(hookData);
    }

    receive() external payable {}
}
