// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Test} from "forge-std/Test.sol";
import {NullifierValidator} from "../src/example/NullifierValidator.sol";

contract NullifierValidatorTest is Test {
    function test_constructorStoresNonceDomain() public {
        bytes32 keysHash = keccak256(abi.encodePacked(uint256(2), uint256(7), uint256(11)));
        NullifierValidator validator = new NullifierValidator(2, keysHash);
        assertEq(validator.expectedKeyCount(), 2);
        assertEq(validator.expectedKeysHash(), keysHash);
    }

    function test_constructorRejectsInvalidKeyCount() public {
        vm.expectRevert(NullifierValidator.InvalidKeyCount.selector);
        new NullifierValidator(0, bytes32(0));
        vm.expectRevert(NullifierValidator.InvalidKeyCount.selector);
        new NullifierValidator(17, bytes32(0));
    }

    function test_validateRejectsNonEntryPoint() public {
        NullifierValidator validator = new NullifierValidator(1, bytes32(uint256(1)));
        vm.expectRevert(NullifierValidator.InvalidCaller.selector);
        validator.validate();
    }
}
