// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {FrameTxLib} from "../FrameTxLib.sol";
import {StrictWebAuthn} from "./StrictWebAuthn.sol";

/// @notice Self-paying WebAuthn account with one rotatable owner and optional
/// immutable delayed recovery authority. Deploy directly; not proxy compatible.
contract PasskeyAccount8141 {
    bytes32 public constant OWNER_DOMAIN = keccak256("8141.passkey.owner.v2");
    bytes32 public constant CHALLENGE_DOMAIN = keccak256("8141.passkey.transaction.v1");
    bytes32 public immutable rpIdHash;
    bytes32 public immutable suffixHash;
    bytes32 public immutable legacySuffixHash;
    address public immutable guardian;
    uint256 public immutable recoveryDelay;
    bytes32 public ownerCommitment;
    uint64 public ownerEpoch;
    bytes32 public pendingRecovery;
    uint256 public recoveryReadyAt;

    struct Call {
        address target;
        uint256 value;
        bytes data;
    }
    error Unauthorized();
    error InvalidPolicy();
    error InvalidKey();
    error InvalidEnvelope();
    error InvalidAssertion();
    error RecoveryUnavailable();
    error RecoveryNotReady();
    error InvalidBatch();
    event OwnerChanged(uint64 indexed epoch, bytes32 indexed commitment);
    event RecoveryScheduled(bytes32 indexed commitment, uint256 readyAt);
    event RecoveryCancelled();

    constructor(uint256 x, uint256 y, bytes32 rpHash, string memory origin, address recoveryGuardian, uint256 delay) {
        bytes memory o = bytes(origin);
        if (rpHash == 0 || o.length < 9 || o.length > 200 || keccak256(_firstEight(o)) != keccak256("https://")) {
            revert InvalidPolicy();
        }
        // Safe unescaped JSON origin. Browser-enforced RP/domain relationship
        // must also be checked by deployment tooling.
        for (uint256 i; i < o.length; ++i) {
            if (uint8(o[i]) < 0x21 || uint8(o[i]) > 0x7e || o[i] == '"' || o[i] == "\\") revert InvalidPolicy();
        }
        if (
            recoveryGuardian == address(this)
                || (recoveryGuardian == address(0) ? delay != 0 : delay < 2 days || delay > 30 days)
        ) revert InvalidPolicy();
        if (!StrictWebAuthn.validPublicKey(x, y)) revert InvalidKey();
        rpIdHash = rpHash;
        suffixHash = keccak256(abi.encodePacked('","origin":"', origin, '","crossOrigin":false}'));
        legacySuffixHash = keccak256(abi.encodePacked('","origin":"', origin, '"}'));
        guardian = recoveryGuardian;
        recoveryDelay = delay;
        ownerCommitment = keyCommitment(x, y, 0);
        emit OwnerChanged(0, ownerCommitment);
    }

    function _firstEight(bytes memory o) private pure returns (bytes memory result) {
        result = new bytes(8);
        for (uint256 i; i < 8; ++i) {
            result[i] = o[i];
        }
    }

    receive() external payable {}

    /// @notice Address EIP-8141 assigns to a P-256 key: `keccak256(qx || qy)[12:]`.
    function signerAddress(uint256 x, uint256 y) public pure returns (address) {
        return address(uint160(uint256(keccak256(abi.encodePacked(x, y)))));
    }

    function keyCommitment(uint256 x, uint256 y, uint64 epoch) public pure returns (bytes32) {
        return _signerCommitment(signerAddress(x, y), epoch);
    }

    function _signerCommitment(address signer, uint64 epoch) private pure returns (bytes32) {
        return keccak256(abi.encode(OWNER_DOMAIN, signer, epoch));
    }

    function challenge(bytes32 envelopeHash, uint64 epoch, uint256 maxGasCharge) public view returns (bytes32) {
        return keccak256(abi.encode(CHALLENGE_DOMAIN, block.chainid, address(this), envelopeHash, epoch, maxGasCharge));
    }

    /// @dev The P-256 signature is the transaction's single protocol-validated
    ///      `P256` signature entry. The protocol verified it, before any frame
    ///      ran, over the entry's explicit `msg`; this frame checks that `msg`
    ///      is the WebAuthn digest of a ceremony whose challenge commits to this
    ///      transaction, and that the entry's signer is the current owner.
    function validate(
        uint64 epoch,
        uint256 maxGasCharge,
        bytes calldata authenticatorData,
        bytes calldata clientDataJSON
    ) external view {
        if (msg.sender != address(0xAA)) revert Unauthorized();
        // One VERIFY authorizes one self-targeted SENDER call. WebAuthn signs
        // sha256(authenticatorData || sha256(clientDataJSON)), never the
        // transaction hash itself, so the entry carries an explicit `msg`. An
        // explicit-message entry keeps its bytes inside the canonical signature
        // hash; the challenge therefore commits to an envelope hash over every
        // fee- and execution-relevant field instead.
        if (
            FrameTxLib.txSender() != address(this) || FrameTxLib.frameCount() != 2
                || FrameTxLib.currentFrameIndex() != 0 || FrameTxLib.frameMode(0) != 1
                || FrameTxLib.frameTarget(0) != address(this) || FrameTxLib.frameFlags(0) != 3
                || FrameTxLib.frameValue(0) != 0 || FrameTxLib.frameMode(1) != 2
                || FrameTxLib.frameTarget(1) != address(this) || FrameTxLib.frameFlags(1) != 0
                || FrameTxLib.frameValue(1) != 0 || FrameTxLib.signatureCount() != 1
                || FrameTxLib.signatureScheme(0) != FrameTxLib.SIGNATURE_SCHEME_P256
                || FrameTxLib.recentRootReferenceCount() != 0 || FrameTxLib.nonceKeyCount() != 1
                || uint256(FrameTxLib.txParam(FrameTxLib.TX_PARAM_BLOB_HASH_COUNT)) != 0
                || uint256(FrameTxLib.txParam(FrameTxLib.TX_PARAM_BLOB_FEE_CAP)) != 0
        ) revert InvalidEnvelope();
        if (
            maxGasCharge == 0 || FrameTxLib.maxCost() > maxGasCharge || FrameTxLib.frameDataSize(1) > 16_384
                || msg.data.length > 1024
        ) revert InvalidEnvelope();
        if (
            keccak256(msg.data)
                != keccak256(abi.encodeCall(this.validate, (epoch, maxGasCharge, authenticatorData, clientDataJSON)))
        ) revert InvalidEnvelope();
        bytes32 hash = keccak256(
            abi.encode(
                FrameTxLib.nonceKeysHash(),
                FrameTxLib.nonceSeq(),
                FrameTxLib.txParam(FrameTxLib.TX_PARAM_GAS_TIP_CAP),
                FrameTxLib.txParam(FrameTxLib.TX_PARAM_GAS_FEE_CAP),
                FrameTxLib.frameGasLimit(0),
                FrameTxLib.frameStateGasLimit(0),
                FrameTxLib.frameGasLimit(1),
                FrameTxLib.frameStateGasLimit(1),
                keccak256(FrameTxLib.frameData(1))
            )
        );
        (bool ok, bytes32 digest) = StrictWebAuthn.assertionDigest(
            challenge(hash, epoch, maxGasCharge), rpIdHash, suffixHash, legacySuffixHash, authenticatorData, clientDataJSON
        );
        // A canonical-hash entry reports a zero message and never matches.
        if (!ok || digest == 0 || FrameTxLib.signatureMessage(0) != digest) revert InvalidAssertion();
        // Only mutable read. No cryptography runs inside this frame.
        if (_signerCommitment(FrameTxLib.signatureSigner(0), epoch) != ownerCommitment) revert InvalidKey();
        FrameTxLib.approveEmpty(FrameTxLib.SCOPE_EXECUTION_AND_PAYMENT);
    }

    modifier onlySelf() {
        if (msg.sender != address(this)) revert Unauthorized();
        _;
    }

    function execute(address target, uint256 value, bytes calldata data) external onlySelf returns (bytes memory) {
        return _call(target, value, data);
    }

    function executeBatch(Call[] calldata calls) external onlySelf {
        if (calls.length == 0 || calls.length > 16) revert InvalidBatch();
        for (uint256 i; i < calls.length; ++i) {
            _call(calls[i].target, calls[i].value, calls[i].data);
        }
    }

    function _call(address target, uint256 value, bytes calldata data) private returns (bytes memory result) {
        bool ok;
        (ok, result) = target.call{value: value}(data);
        if (!ok) assembly ("memory-safe") { revert(add(result, 32), mload(result)) }
    }

    function rotateOwner(uint256 x, uint256 y) external onlySelf {
        _changeOwner(x, y);
    }

    function _changeOwner(uint256 x, uint256 y) private {
        if (!StrictWebAuthn.validPublicKey(x, y)) revert InvalidKey();
        ownerEpoch += 1;
        ownerCommitment = keyCommitment(x, y, ownerEpoch);
        _cancelRecovery();
        emit OwnerChanged(ownerEpoch, ownerCommitment);
    }

    function scheduleRecovery(uint256 x, uint256 y) external {
        if (guardian == address(0) || msg.sender != guardian) revert Unauthorized();
        if (!StrictWebAuthn.validPublicKey(x, y)) revert InvalidKey();
        if (pendingRecovery != 0) revert RecoveryUnavailable();
        pendingRecovery = keyCommitment(x, y, ownerEpoch + 1);
        recoveryReadyAt = block.timestamp + recoveryDelay;
        emit RecoveryScheduled(pendingRecovery, recoveryReadyAt);
    }

    function cancelRecovery() external {
        if (msg.sender != address(this) && (guardian == address(0) || msg.sender != guardian)) revert Unauthorized();
        _cancelRecovery();
    }

    function _cancelRecovery() private {
        if (pendingRecovery != 0) {
            delete pendingRecovery;
            delete recoveryReadyAt;
            emit RecoveryCancelled();
        }
    }

    function finalizeRecovery(uint256 x, uint256 y) external {
        if (pendingRecovery == 0) revert RecoveryUnavailable();
        if (block.timestamp < recoveryReadyAt) revert RecoveryNotReady();
        if (pendingRecovery != keyCommitment(x, y, ownerEpoch + 1)) revert InvalidKey();
        _changeOwner(x, y);
    }
}
