// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

/// @title Create2Deployer
/// @notice Generic CREATE2 deployer for EIP-8141 frame transaction deploy flows.
/// @dev Used as the target of a DEFAULT frame (Frame 0) to deploy an account
///      in the same transaction that verifies and executes.
///
///   Example 1b — Deploy + Execute in one frame tx:
///     Frame 0: DEFAULT(deployer)  → deploy(salt, initCode)
///     Frame 1: VERIFY(sender)     → account.validate(...)  → APPROVE
///     Frame 2: SENDER(target)     → account.execute(...)
contract Create2Deployer {
    error DeployFailed();

    /// @notice Deploy a contract via CREATE2.
    /// @param salt   The CREATE2 salt.
    /// @param initCode The full creation bytecode (bytecode + constructor args).
    /// @return addr The deployed contract address.
    function deploy(bytes32 salt, bytes calldata initCode) external returns (address addr) {
        assembly {
            let len := initCode.length
            let ptr := mload(0x40)
            calldatacopy(ptr, initCode.offset, len)
            addr := create2(0, ptr, len, salt)
        }
        if (addr == address(0)) revert DeployFailed();
    }

    /// @notice Predict the CREATE2 address without deploying.
    /// @param salt     The CREATE2 salt.
    /// @param initCode The full creation bytecode.
    /// @return The predicted address.
    function getAddress(bytes32 salt, bytes calldata initCode) external view returns (address) {
        return address(uint160(uint256(keccak256(abi.encodePacked(
            bytes1(0xff),
            address(this),
            salt,
            keccak256(initCode)
        )))));
    }
}
