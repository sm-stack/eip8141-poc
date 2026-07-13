// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

contract RecentRootWriter {
    address internal constant RECENT_ROOT = 0x0000000000000000000000000000000000008272;

    error WriteFailed();

    function writeTwice(bytes32 salt, bytes32 firstRoot, bytes32 secondRoot) external {
        (bool firstSuccess,) = RECENT_ROOT.call(abi.encodePacked(salt, firstRoot));
        if (!firstSuccess) revert WriteFailed();
        (bool secondSuccess,) = RECENT_ROOT.call(abi.encodePacked(salt, secondRoot));
        if (!secondSuccess) revert WriteFailed();
    }
}
