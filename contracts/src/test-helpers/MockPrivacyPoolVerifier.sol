// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {IPrivacyPoolVerifier} from "../interfaces/IPrivacyPoolVerifier.sol";

contract MockPrivacyPoolVerifier is IPrivacyPoolVerifier {
    bool public result = true;

    function setResult(bool value) external {
        result = value;
    }

    function verifyProof(bytes calldata, bytes32, bytes32, bytes32) external view returns (bool) {
        return result;
    }
}
