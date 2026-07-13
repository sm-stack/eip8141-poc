// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Test} from "forge-std/Test.sol";
import {RecentRootWriter} from "../src/test-helpers/RecentRootWriter.sol";

contract RecentRootWriterTest is Test {
    function test_writeTwicePropagatesNativeWriteFailure() public {
        RecentRootWriter writer = new RecentRootWriter();
        vm.etch(0x0000000000000000000000000000000000008272, hex"60006000fd");
        vm.expectRevert(RecentRootWriter.WriteFailed.selector);
        writer.writeTwice(bytes32(0), bytes32(uint256(1)), bytes32(uint256(2)));
    }
}
