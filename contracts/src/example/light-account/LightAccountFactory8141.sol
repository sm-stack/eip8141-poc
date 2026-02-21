// SPDX-License-Identifier: GPL-3.0
pragma solidity ^0.8.28;

import {LightAccount8141} from "./LightAccount8141.sol";
import {LibClone} from "solady/utils/LibClone.sol";

/// @title LightAccountFactory8141
/// @notice Factory for deterministic ERC-1967 proxy deployment of LightAccount8141.
/// @dev Ported from Alchemy's LightAccountFactory (ERC-4337) with identical API.
contract LightAccountFactory8141 {
    /// @notice Address of the implementation used for new accounts.
    address public immutable implementation;

    event AccountCreated(address indexed account, address indexed owner, uint256 salt);

    error ImplementationUndeployed();
    error InvalidOwner(address owner);

    constructor(address implementation_) payable {
        if (implementation_.code.length == 0) revert ImplementationUndeployed();
        implementation = implementation_;
    }

    /// @notice Deploy and initialize a LightAccount8141 proxy (or return existing).
    /// @param owner The owner of the account.
    /// @param salt A salt for deterministic deployment.
    /// @return account The deployed account.
    function createAccount(address owner, uint256 salt)
        external
        payable
        returns (LightAccount8141 account)
    {
        if (owner == address(0)) revert InvalidOwner(owner);

        (bool alreadyDeployed, address addr) =
            LibClone.createDeterministicERC1967(msg.value, implementation, _getCombinedSalt(owner, salt));

        account = LightAccount8141(payable(addr));

        if (!alreadyDeployed) {
            account.initialize(owner);
            emit AccountCreated(addr, owner, salt);
        }
    }

    /// @notice Returns the deterministic address for the given owner and salt.
    function getAddress(address owner, uint256 salt) external view returns (address) {
        return LibClone.predictDeterministicAddressERC1967(
            implementation, _getCombinedSalt(owner, salt), address(this)
        );
    }

    /// @notice Returns the init code hash of the ERC-1967 proxy.
    function initCodeHash() public view returns (bytes32) {
        return LibClone.initCodeHashERC1967(implementation);
    }

    function _getCombinedSalt(address owner, uint256 salt) internal pure returns (bytes32 combinedSalt) {
        assembly ("memory-safe") {
            mstore(0x00, owner)
            mstore(0x20, salt)
            combinedSalt := keccak256(0x00, 0x40)
        }
    }
}
