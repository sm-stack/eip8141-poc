// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Test} from "forge-std/Test.sol";
import {Sponsor, IERC20} from "../src/Sponsor.sol";

contract MockERC20 {
    mapping(address => uint256) public balanceOf;

    function setBalance(address account, uint256 amount) external {
        balanceOf[account] = amount;
    }
}

contract SponsorTest is Test {
    Sponsor sponsor;
    MockERC20 token;
    uint256 constant MIN_BALANCE = 100e18;

    function setUp() public {
        token = new MockERC20();
        sponsor = new Sponsor(IERC20(address(token)), MIN_BALANCE);
    }

    // ── Constructor ──────────────────────────────────────────────────

    function test_token() public view {
        assertEq(address(sponsor.token()), address(token));
    }

    function test_minBalance() public view {
        assertEq(sponsor.minBalance(), MIN_BALANCE);
    }

    // ── Approved senders ─────────────────────────────────────────────

    function test_addApprovedSender() public {
        address sender = address(0x1234);
        assertFalse(sponsor.approvedSenders(sender));

        sponsor.addApprovedSender(sender);
        assertTrue(sponsor.approvedSenders(sender));
    }

    function test_removeApprovedSender() public {
        address sender = address(0x1234);
        sponsor.addApprovedSender(sender);
        assertTrue(sponsor.approvedSenders(sender));

        sponsor.removeApprovedSender(sender);
        assertFalse(sponsor.approvedSenders(sender));
    }

    // ── validate ─────────────────────────────────────────────────────
    // Note: validate() relies on EIP-8141 opcodes (TXPARAMLOAD, APPROVE)
    // which are not available in standard forge test EVM. Full validation
    // testing requires the custom geth devnet.

    function test_validate_revertsIfNotEntryPoint() public {
        vm.expectRevert(Sponsor.InvalidCaller.selector);
        sponsor.validate();
    }

    // ── receive ──────────────────────────────────────────────────────

    function test_receive_ether() public {
        vm.deal(address(this), 1 ether);
        (bool ok,) = address(sponsor).call{value: 1 ether}("");
        assertTrue(ok);
        assertEq(address(sponsor).balance, 1 ether);
    }
}
