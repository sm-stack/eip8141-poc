// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {FrameTxLib} from "../FrameTxLib.sol";
import {IPrivacyPoolVerifier} from "../interfaces/IPrivacyPoolVerifier.sol";

/// @title PrivacyPool8141
/// @notice Fixed-denomination privacy pool demonstrating relayerless EIP-8141 withdrawals.
/// @dev The Merkle hash is keccak256 for contract-flow testing. A production circuit and
///      deployment must replace it with the circuit's audited hash and verifier.
contract PrivacyPool8141 {
    uint8 internal constant FRAME_MODE_VERIFY = 1;
    uint8 internal constant FRAME_MODE_SENDER = 2;
    uint8 internal constant MAX_TREE_LEVELS = 32;

    address internal constant ENTRY_POINT = 0x00000000000000000000000000000000000000AA;
    bytes32 public constant ROOT_SALT = keccak256("privacy-pool-8141.root.v1");
    bytes32 public constant NULLIFIER_DOMAIN = keccak256("privacy-pool-8141.nullifier.v1");
    uint256 public constant EXECUTE_GAS_LIMIT = 200_000;
    bytes32 public constant WITHDRAW_STATEMENT_TYPEHASH = keccak256(
        "WithdrawalStatement(uint256 chainId,address pool,bytes32 root,uint64 rootSlot,bytes32 nullifierHash,address recipient,uint64 nonceSeq,uint256 maxGasCharge)"
    );

    struct WithdrawalIntent {
        bytes32 root;
        uint64 rootSlot;
        bytes32 nullifierHash;
        address recipient;
        uint64 nonceSeq;
        uint256 maxGasCharge;
        uint256 gasCharge;
        uint256 verifyGasLimit;
        uint256 maxPriorityFeePerGas;
        uint256 maxFeePerGas;
    }

    IPrivacyPoolVerifier public immutable verifier;
    uint256 public immutable denomination;
    uint8 public immutable levels;
    bytes32 public immutable rootSourceId;

    uint64 public nextLeafIndex;
    bytes32 public currentRoot;
    bytes32[MAX_TREE_LEVELS] public zeros;
    bytes32[MAX_TREE_LEVELS] public filledSubtrees;
    mapping(bytes32 commitment => bool) public commitments;
    mapping(bytes32 nullifierHash => bool) public nullifierSpent;

    error InvalidVerifier();
    error InvalidDenomination();
    error InvalidTreeLevels();
    error InvalidDepositValue();
    error InvalidCommitment();
    error DuplicateCommitment();
    error TreeFull();
    error RootPublicationFailed();
    error InvalidCaller();
    error InvalidFrameTransaction();
    error InvalidRootReference();
    error InvalidNonceKey();
    error InvalidGasTerms();
    error InvalidProof();
    error InvalidRecipient();
    error NullifierAlreadySpent();
    error GasChargeTooHigh();

    event Deposit(bytes32 indexed commitment, uint64 indexed leafIndex, bytes32 root);
    event RootPublished(bytes32 indexed sourceId, uint64 indexed slot, bytes32 root);
    event Withdrawal(bytes32 indexed nullifierHash, address indexed recipient, uint256 amount, uint256 gasCharge);

    constructor(IPrivacyPoolVerifier _verifier, uint256 _denomination, uint8 _levels) {
        if (address(_verifier).code.length == 0) revert InvalidVerifier();
        if (_denomination == 0) revert InvalidDenomination();
        if (_levels == 0 || _levels > MAX_TREE_LEVELS) revert InvalidTreeLevels();

        verifier = _verifier;
        denomination = _denomination;
        levels = _levels;
        rootSourceId = keccak256(abi.encodePacked(address(this), ROOT_SALT));

        bytes32 zero;
        for (uint256 i; i < _levels; ++i) {
            zeros[i] = zero;
            filledSubtrees[i] = zero;
            zero = _hashPair(zero, zero);
        }
        currentRoot = zero;
    }

    /// @notice Insert one fixed-denomination commitment and publish its new root.
    function deposit(bytes32 commitment) external payable returns (uint64 leafIndex, bytes32 root) {
        if (msg.value != denomination) revert InvalidDepositValue();
        if (commitment == bytes32(0)) revert InvalidCommitment();
        if (commitments[commitment]) revert DuplicateCommitment();

        leafIndex = nextLeafIndex;
        if (uint256(leafIndex) >= (uint256(1) << levels)) revert TreeFull();

        commitments[commitment] = true;
        nextLeafIndex = leafIndex + 1;

        bytes32 node = commitment;
        uint256 index = leafIndex;
        for (uint256 level; level < levels; ++level) {
            if (index & 1 == 0) {
                filledSubtrees[level] = node;
                node = _hashPair(node, zeros[level]);
            } else {
                node = _hashPair(filledSubtrees[level], node);
            }
            index >>= 1;
        }

        currentRoot = node;
        root = node;
        emit Deposit(commitment, leafIndex, root);
        _publishRoot(root);
    }

    /// @notice Validate a proof-backed withdrawal and approve this pool for execution and payment.
    /// @dev Must be frame zero of an exact two-frame self-relayed transaction. The proof binds a
    ///      custom intent hash because including the proof-bearing frame in its own hash is circular.
    function validateWithdrawal(bytes calldata proof, WithdrawalIntent calldata intent) external view {
        if (msg.sender != ENTRY_POINT) revert InvalidCaller();
        if (intent.recipient == address(0)) revert InvalidRecipient();
        if (
            intent.maxGasCharge == 0 || intent.maxGasCharge >= denomination || intent.gasCharge == 0
                || intent.gasCharge > intent.maxGasCharge
        ) revert GasChargeTooHigh();
        if (nullifierSpent[intent.nullifierHash]) revert NullifierAlreadySpent();
        _validateFrameEnvelope(intent);
        _validateRecentRoot(intent);
        _validateNonce(intent);

        bytes32 statementHash = withdrawStatementHash(intent);
        if (!verifier.verifyProof(proof, intent.root, intent.nullifierHash, statementHash)) {
            revert InvalidProof();
        }

        FrameTxLib.approveEmpty(FrameTxLib.SCOPE_EXECUTION_AND_PAYMENT);
    }

    /// @notice Complete a validated withdrawal from a SENDER frame.
    /// @dev EIP-8141 calls a SENDER target with msg.sender equal to tx.sender, so a pool that is
    ///      both sender and target sees itself as caller. ForcedEther avoids invoking recipient code.
    function executeWithdrawal(bytes32 nullifierHash, address recipient, uint256 amount) external {
        if (msg.sender != address(this)) revert InvalidCaller();
        if (recipient == address(0)) revert InvalidRecipient();
        if (nullifierSpent[nullifierHash]) revert NullifierAlreadySpent();
        if (amount == 0 || amount >= denomination) revert GasChargeTooHigh();

        nullifierSpent[nullifierHash] = true;
        new ForcedEther{value: amount}(payable(recipient));
        emit Withdrawal(nullifierHash, recipient, amount, denomination - amount);
    }

    function withdrawStatementHash(WithdrawalIntent calldata intent) public view returns (bytes32) {
        return keccak256(
            abi.encode(
                WITHDRAW_STATEMENT_TYPEHASH,
                block.chainid,
                address(this),
                intent.root,
                intent.rootSlot,
                intent.nullifierHash,
                intent.recipient,
                intent.nonceSeq,
                intent.maxGasCharge
            )
        );
    }

    function nullifierNonceKey(bytes32 nullifierHash) public pure returns (uint256) {
        uint256 key = uint256(keccak256(abi.encode(NULLIFIER_DOMAIN, nullifierHash)));
        return key == 0 ? 1 : key;
    }

    function nullifierNonceKeysHash(bytes32 nullifierHash) public pure returns (bytes32) {
        return keccak256(abi.encode(uint256(1), nullifierNonceKey(nullifierHash)));
    }

    function _validateFrameEnvelope(WithdrawalIntent calldata intent) private view {
        if (
            FrameTxLib.txSender() != address(this) || FrameTxLib.frameCount() != 2
                || FrameTxLib.currentFrameIndex() != 0 || FrameTxLib.currentFrameMode() != FRAME_MODE_VERIFY
                || FrameTxLib.currentFrameAllowedScope() != FrameTxLib.SCOPE_EXECUTION_AND_PAYMENT
                || FrameTxLib.frameFlags(0) != FrameTxLib.SCOPE_EXECUTION_AND_PAYMENT
                || FrameTxLib.frameTarget(0) != address(this) || FrameTxLib.frameValue(0) != 0
                || FrameTxLib.frameGasLimit(0) != intent.verifyGasLimit || FrameTxLib.frameMode(1) != FRAME_MODE_SENDER
                || FrameTxLib.frameTarget(1) != address(this) || FrameTxLib.frameFlags(1) != 0
                || FrameTxLib.frameValue(1) != 0 || FrameTxLib.frameGasLimit(1) != EXECUTE_GAS_LIMIT
                || FrameTxLib.signatureCount() != 0
                || uint256(FrameTxLib.txParam(FrameTxLib.TX_PARAM_BLOB_HASH_COUNT)) != 0
                || uint256(FrameTxLib.txParam(FrameTxLib.TX_PARAM_BLOB_FEE_CAP)) != 0
        ) revert InvalidFrameTransaction();

        bytes memory expectedExecutionData = abi.encodeCall(
            this.executeWithdrawal, (intent.nullifierHash, intent.recipient, denomination - intent.gasCharge)
        );
        if (
            FrameTxLib.frameDataSize(1) != expectedExecutionData.length
                || keccak256(FrameTxLib.frameData(1)) != keccak256(expectedExecutionData)
        ) revert InvalidFrameTransaction();

        if (
            FrameTxLib.maxCost() != intent.gasCharge
                || uint256(FrameTxLib.txParam(FrameTxLib.TX_PARAM_GAS_TIP_CAP)) != intent.maxPriorityFeePerGas
                || uint256(FrameTxLib.txParam(FrameTxLib.TX_PARAM_GAS_FEE_CAP)) != intent.maxFeePerGas
        ) revert InvalidGasTerms();
    }

    function _validateRecentRoot(WithdrawalIntent calldata intent) private view {
        if (
            FrameTxLib.recentRootReferenceCount() != 1
                || FrameTxLib.recentRootRefLoad(FrameTxLib.RECENT_ROOT_FIELD_SOURCE_ID, 0) != rootSourceId
                || uint256(FrameTxLib.recentRootRefLoad(FrameTxLib.RECENT_ROOT_FIELD_SLOT, 0)) != intent.rootSlot
                || FrameTxLib.recentRootRefLoad(FrameTxLib.RECENT_ROOT_FIELD_ROOT, 0) != intent.root
        ) revert InvalidRootReference();
    }

    function _validateNonce(WithdrawalIntent calldata intent) private pure {
        uint256 expectedKey = nullifierNonceKey(intent.nullifierHash);
        if (
            intent.nonceSeq != 0 || FrameTxLib.nonceKeyCount() != 1 || FrameTxLib.nonceKey0() != expectedKey
                || FrameTxLib.nonceKeysHash() != nullifierNonceKeysHash(intent.nullifierHash)
                || FrameTxLib.nonceSeq() != intent.nonceSeq
        ) revert InvalidNonceKey();
    }

    function _publishRoot(bytes32 root) private {
        (bool success,) = FrameTxLib.RECENT_ROOT.call(abi.encodePacked(ROOT_SALT, root));
        if (!success) revert RootPublicationFailed();
        emit RootPublished(rootSourceId, uint64(block.timestamp / 12), root);
    }

    function _hashPair(bytes32 left, bytes32 right) private pure returns (bytes32) {
        return keccak256(abi.encodePacked(left, right));
    }
}

/// @dev Created and destroyed in one transaction, preserving forced-value transfer under EIP-6780.
contract ForcedEther {
    constructor(address payable recipient) payable {
        selfdestruct(recipient);
    }
}
