// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Test} from "forge-std/Test.sol";

abstract contract TestBase is Test {
    function makeAddr(string memory name) internal returns (address addr) {
        (addr,) = makeAddrAndKey(name);
    }

    function makeAddrAndKey(string memory name) internal returns (address addr, uint256 privateKey) {
        privateKey = uint256(keccak256(bytes(name)));
        addr = vm.addr(privateKey);
        vm.label(addr, name);
    }
}
