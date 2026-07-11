// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {FrameTxLib} from "./FrameTxLib.sol";

/// @title CanonicalPaymaster
/// @notice Standard EIP-8141 paymaster with delayed, signer-only withdrawals.
/// @dev Storage layout is part of the client integration: signer is slot 0 and
///      the pending withdrawal amount is slot 1. Do not reorder these fields.
contract CanonicalPaymaster {
    address internal constant ENTRY_POINT = 0x00000000000000000000000000000000000000AA;
    uint64 public constant WITHDRAWAL_DELAY = 7 days;

    address public signer;
    uint256 private _pendingWithdrawalAmount;
    uint64 public pendingWithdrawalAvailableAt;

    error InvalidCaller();
    error InvalidSignature();
    error InvalidSigner();
    error InvalidWithdrawalAmount();
    error WithdrawalAlreadyPending();
    error NoPendingWithdrawal();
    error WithdrawalNotReady();
    error WithdrawalTransferFailed();

    event WithdrawalInitiated(uint256 amount, uint64 availableAt);
    event WithdrawalFinalized(uint256 amount);

    constructor(address _signer) {
        if (_signer == address(0)) revert InvalidSigner();
        signer = _signer;
    }

    /// @notice Approve a protocol-verified canonical transaction signature.
    function validate(uint256 signatureIndex) external view {
        if (msg.sender != ENTRY_POINT) revert InvalidCaller();
        if (signatureIndex >= FrameTxLib.signatureCount()) revert InvalidSignature();
        if (FrameTxLib.signatureScheme(signatureIndex) != FrameTxLib.SIGNATURE_SCHEME_SECP256K1) {
            revert InvalidSignature();
        }
        if (FrameTxLib.signatureSigner(signatureIndex) != signer) revert InvalidSignature();
        if (FrameTxLib.signatureMessage(signatureIndex) != bytes32(0)) revert InvalidSignature();
        FrameTxLib.approveEmpty(FrameTxLib.SCOPE_PAYMENT);
    }

    /// @notice Schedule an ETH withdrawal to the signer after the fixed delay.
    function initiateWithdrawal(uint256 amount) external {
        if (msg.sender != signer) revert InvalidCaller();
        if (_pendingWithdrawalAmount != 0) revert WithdrawalAlreadyPending();
        if (amount == 0 || amount > address(this).balance) revert InvalidWithdrawalAmount();

        _pendingWithdrawalAmount = amount;
        uint64 availableAt = uint64(block.timestamp) + WITHDRAWAL_DELAY;
        pendingWithdrawalAvailableAt = availableAt;
        emit WithdrawalInitiated(amount, availableAt);
    }

    /// @notice Complete the pending withdrawal. ETH always goes to the signer.
    function finalizeWithdrawal() external {
        if (msg.sender != signer) revert InvalidCaller();
        uint256 amount = _pendingWithdrawalAmount;
        if (amount == 0) revert NoPendingWithdrawal();
        if (block.timestamp < pendingWithdrawalAvailableAt) revert WithdrawalNotReady();

        _pendingWithdrawalAmount = 0;
        pendingWithdrawalAvailableAt = 0;
        (bool success,) = signer.call{value: amount}("");
        if (!success) revert WithdrawalTransferFailed();
        emit WithdrawalFinalized(amount);
    }

    /// @notice Amount excluded from framepool paymaster solvency accounting.
    function pendingWithdrawal() external view returns (uint256) {
        return _pendingWithdrawalAmount;
    }

    receive() external payable {}
}
