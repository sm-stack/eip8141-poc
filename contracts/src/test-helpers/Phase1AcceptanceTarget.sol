// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

contract Phase1AcceptanceTarget {
    uint256 public value;

    function setValue(uint256 newValue) external {
        value = newValue;
    }

    function fail() external pure {
        revert("acceptance failure");
    }
}
