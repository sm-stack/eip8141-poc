// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {IFallbackHandler} from "../../interfaces/IFallbackHandler.sol";
import {IValidator8141} from "../../interfaces/IValidator8141.sol";

/// @title ERC1271Handler
/// @notice Fallback handler for ERC-1271 signature validation.
/// @dev Delegates signature validation to the account's root validator.
contract ERC1271Handler is IFallbackHandler {
    // ERC-1271 magic value
    bytes4 internal constant MAGICVALUE = 0x1626ba7e;

    // isValidSignature(bytes32,bytes) selector
    bytes4 internal constant ERC1271_SELECTOR = 0x1626ba7e;

    mapping(address => IValidator8141) public accountValidators;

    error InvalidSelector(bytes4 selector);
    error NotInitialized(address account);

    event ValidatorSet(address indexed account, address indexed validator);

    /// @inheritdoc IFallbackHandler
    function handleFallback(bytes4 selector, bytes calldata data)
        external
        returns (bytes memory)
    {
        if (selector != ERC1271_SELECTOR) {
            revert InvalidSelector(selector);
        }

        IValidator8141 validator = accountValidators[msg.sender];
        if (address(validator) == address(0)) {
            revert NotInitialized(msg.sender);
        }

        // Decode isValidSignature(bytes32 hash, bytes signature)
        (bytes32 hash, bytes memory signature) = abi.decode(data[4:], (bytes32, bytes));

        // Validate signature using the validator
        bool valid = validator.validateSignature(msg.sender, hash, signature);

        bytes4 result = valid ? MAGICVALUE : bytes4(0);
        return abi.encode(result);
    }

    /// @inheritdoc IFallbackHandler
    /// @dev data = abi.encode(IValidator8141 validator)
    function onInstall(bytes calldata data) external {
        IValidator8141 validator = abi.decode(data, (IValidator8141));
        accountValidators[msg.sender] = validator;
        emit ValidatorSet(msg.sender, address(validator));
    }

    /// @inheritdoc IFallbackHandler
    function onUninstall() external {
        delete accountValidators[msg.sender];
    }

    /// @inheritdoc IFallbackHandler
    function isInitialized(address account) external view returns (bool) {
        return address(accountValidators[account]) != address(0);
    }
}
