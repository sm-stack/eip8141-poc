// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;
import {PrivacyPool8141, IPoseidon2} from "../example/PrivacyPool8141.sol";

/// @dev Local integration fixture ONLY. Never deploy this as a user pool.
abstract contract PrivacyPoolDeliveryHarness is PrivacyPool8141 {
    address private immutable testOwner = msg.sender;
    bool private deliveryFails = true;

    function enableDelivery() external {
        require(msg.sender == testOwner, "test owner only");
        deliveryFails = false;
    }

    function _deliver(address payable recipient, uint256 amount) internal override {
        require(!deliveryFails, "intentional integration-test delivery failure");
        super._deliver(recipient, amount);
    }
}
