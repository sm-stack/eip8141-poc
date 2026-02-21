// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {LibClone} from "solady/utils/LibClone.sol";

/// @title Kernel8141Factory
/// @notice Deterministic ERC-1967 proxy factory for Kernel8141.
/// @dev Ported from Kernel v3 KernelFactory. Uses solady LibClone for minimal proxy deployment.
contract Kernel8141Factory {
    error InitializeError();
    error ImplementationNotDeployed();

    address public immutable implementation;

    constructor(address _impl) {
        implementation = _impl;
        require(_impl.code.length > 0, ImplementationNotDeployed());
    }

    /// @notice Deploy a new Kernel8141 proxy and initialize it.
    /// @param data The initialization calldata (e.g., abi.encodeCall(Kernel8141.initialize, ...))
    /// @param salt User-provided salt for deterministic address
    /// @return account The deployed account address
    function createAccount(bytes calldata data, bytes32 salt) public payable returns (address) {
        bytes32 actualSalt = keccak256(abi.encodePacked(data, salt));
        (bool alreadyDeployed, address account) =
            LibClone.createDeterministicERC1967(msg.value, implementation, actualSalt);
        if (!alreadyDeployed) {
            (bool success,) = account.call(data);
            if (!success) {
                revert InitializeError();
            }
        }
        return account;
    }

    /// @notice Predict the deterministic address for a given data + salt.
    function getAddress(bytes calldata data, bytes32 salt) public view returns (address) {
        bytes32 actualSalt = keccak256(abi.encodePacked(data, salt));
        return LibClone.predictDeterministicAddressERC1967(implementation, actualSalt, address(this));
    }
}
