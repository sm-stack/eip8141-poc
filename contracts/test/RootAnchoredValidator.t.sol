// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Test} from "forge-std/Test.sol";
import {RootAnchoredValidator} from "../src/example/RootAnchoredValidator.sol";

contract RootAnchoredValidatorTest is Test {
    function test_constructorBindsExpectedReference() public {
        bytes32 sourceId = keccak256("source");
        bytes32 root = keccak256("root");
        RootAnchoredValidator validator = new RootAnchoredValidator(sourceId, 42, root);
        assertEq(validator.expectedSourceId(), sourceId);
        assertEq(validator.expectedSlot(), 42);
        assertEq(validator.expectedRoot(), root);
    }

    function test_validateRejectsNonEntryPointCaller() public {
        RootAnchoredValidator validator = new RootAnchoredValidator(bytes32(0), 0, bytes32(0));
        vm.expectRevert(RootAnchoredValidator.InvalidCaller.selector);
        validator.validate();
    }
}
