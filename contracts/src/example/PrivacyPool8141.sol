// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {FrameTxLib} from "../FrameTxLib.sol";

interface IPoseidon2 {
    function poseidon(uint256[2] calldata inputs) external pure returns (uint256);
}

/// @notice Fixed-denomination ETH pool with proof-authorized self payment.
/// @dev Circuit/key/hasher must match the depth-20 release artifacts. Local
/// development setup keys are not suitable for real deposits. Gas refunds remain
/// in the pool; each previously included failed attempt forfeits its full cap.
abstract contract PrivacyPool8141 {
    uint8 public constant levels = 20;
    uint256 public constant FIELD = 21888242871839275222246405745257275088548364400416034343698204186575808495617;
    uint256 public constant MAX_GAS_CHARGE = 0.001 ether;
    uint256 public constant EXECUTE_GAS_LIMIT = 200_000;
    uint256 public constant EXECUTE_STATE_GAS_LIMIT = 800_000;
    uint256 public constant VERIFY_STATE_GAS_LIMIT = 100_000;
    address internal constant ENTRY_POINT = address(0xAA);
    bytes32 public constant NULLIFIER_DOMAIN = keccak256("privacy-pool-8141.nullifier.v2");
    bytes32 public constant WITHDRAW_STATEMENT_TYPEHASH = keccak256(
        "WithdrawalStatementV2(uint256 chainId,address pool,uint256 denomination,bytes32 root,bytes32 nullifierHash,address recipient,uint64 nonceSeq,uint256 maxGasCharge)"
    );

    struct WithdrawalIntent {
        bytes32 root;
        bytes32 nullifierHash;
        address recipient;
        uint64 nonceSeq;
        uint256 maxGasCharge;
        uint256 gasCharge;
        uint256 verifyGasLimit;
        uint256 maxPriorityFeePerGas;
        uint256 maxFeePerGas;
    }

    IPoseidon2 public immutable hasher;
    uint256 public immutable denomination;
    uint64 public nextLeafIndex;
    bytes32 public currentRoot;
    bytes32[20] public zeros;
    bytes32[20] public filledSubtrees;
    mapping(bytes32 => bool) public commitments;
    mapping(bytes32 => bool) public acceptedRoots;
    mapping(bytes32 => bool) public nullifierSpent;

    error InvalidHasher();
    error InvalidDenomination();
    error InvalidDepositValue();
    error InvalidCommitment();
    error DuplicateCommitment();
    error TreeFull();
    error InvalidCaller();
    error InvalidFrameTransaction();
    error InvalidRoot();
    error InvalidNonceKey();
    error InvalidGasTerms();
    error InvalidProof();
    error InvalidRecipient();
    error NullifierAlreadySpent();
    error GasChargeTooHigh();
    error RetryBudgetExhausted();

    event Deposit(bytes32 indexed commitment, uint64 indexed leafIndex, bytes32 root);
    event Withdrawal(
        bytes32 indexed nullifierHash,
        address indexed recipient,
        uint256 amount,
        uint256 gasCharge,
        uint256 failedAttemptCharge
    );

    constructor(IPoseidon2 _hasher, uint256 _denomination) {
        if (address(_hasher).code.length == 0) revert InvalidHasher();
        if (_denomination <= MAX_GAS_CHARGE) revert InvalidDenomination();
        hasher = _hasher;
        denomination = _denomination;
        bytes32 zero;
        for (uint256 i; i < levels; ++i) {
            zeros[i] = zero;
            filledSubtrees[i] = zero;
            zero = _hashPair(zero, zero);
        }
        currentRoot = zero;
        // The empty tree is intentionally not an accepted deposit root.
    }

    function deposit(bytes32 commitment) external payable returns (uint64 leafIndex, bytes32 root) {
        if (msg.value != denomination) revert InvalidDepositValue();
        if (commitment == 0 || uint256(commitment) >= FIELD) revert InvalidCommitment();
        if (commitments[commitment]) revert DuplicateCommitment();
        leafIndex = nextLeafIndex;
        if (leafIndex >= uint256(1) << levels) revert TreeFull();
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
        acceptedRoots[root] = true;
        emit Deposit(commitment, leafIndex, root);
    }

    function validateWithdrawal(bytes calldata proof, WithdrawalIntent calldata intent) external view {
        if (msg.sender != ENTRY_POINT) revert InvalidCaller();
        if (intent.recipient == address(0) || intent.recipient == address(this)) revert InvalidRecipient();
        if (intent.maxGasCharge == 0 || intent.maxGasCharge > MAX_GAS_CHARGE || intent.gasCharge > intent.maxGasCharge)
        {
            revert GasChargeTooHigh();
        }
        withdrawalAmount(intent.nonceSeq, intent.gasCharge);
        _validateFrameEnvelope(intent);
        _validateNonce(intent);
        if (!_verifyWithdrawalProof(proof, intent.root, intent.nullifierHash, withdrawStatementHash(intent))) {
            revert InvalidProof();
        }
        // Keep proof precompiles before the first mutable storage read.
        if (!acceptedRoots[intent.root]) revert InvalidRoot();
        if (nullifierSpent[intent.nullifierHash]) revert NullifierAlreadySpent();
        FrameTxLib.approveEmpty(FrameTxLib.SCOPE_EXECUTION_AND_PAYMENT);
    }

    function executeWithdrawal(bytes32 nullifierHash, address recipient, uint64 nonceSeq, uint256 gasCharge) external {
        if (msg.sender != address(this)) revert InvalidCaller();
        if (recipient == address(0) || recipient == address(this)) revert InvalidRecipient();
        if (nullifierSpent[nullifierHash]) revert NullifierAlreadySpent();
        uint256 amount = withdrawalAmount(nonceSeq, gasCharge);
        nullifierSpent[nullifierHash] = true;
        _deliver(payable(recipient), amount);
        emit Withdrawal(nullifierHash, recipient, amount, gasCharge, uint256(nonceSeq) * MAX_GAS_CHARGE);
    }

    /// @notice Conservative charge for prior included failures, plus this tx's
    /// maximum reservation. A failure cannot spend another note's budget.
    function withdrawalAmount(uint64 nonceSeq, uint256 gasCharge) public view returns (uint256) {
        if (gasCharge == 0 || gasCharge > MAX_GAS_CHARGE) revert GasChargeTooHigh();
        uint256 totalCharge = uint256(nonceSeq) * MAX_GAS_CHARGE + gasCharge;
        if (totalCharge >= denomination) revert RetryBudgetExhausted();
        return denomination - totalCharge;
    }

    function withdrawStatementHash(WithdrawalIntent calldata intent) public view returns (bytes32 result) {
        bytes32 typeHash = WITHDRAW_STATEMENT_TYPEHASH;
        uint256 amount = denomination;
        address recipient = intent.recipient;
        uint64 nonceSeq = intent.nonceSeq;
        // Fixed ABI preimage, used only until this hash completes. Keep typed
        // accesses and explicit padding cleanup for the two narrow fields.
        assembly ("memory-safe") {
            let p := mload(0x40)
            mstore(p, typeHash)
            mstore(add(p, 32), chainid())
            mstore(add(p, 64), address())
            mstore(add(p, 96), amount)
            calldatacopy(add(p, 128), intent, 64)
            mstore(add(p, 192), and(recipient, 0xffffffffffffffffffffffffffffffffffffffff))
            mstore(add(p, 224), and(nonceSeq, 0xffffffffffffffff))
            mstore(add(p, 256), calldataload(add(intent, 128)))
            result := keccak256(p, 288)
        }
    }

    function nullifierNonceKey(bytes32 nullifierHash) public pure returns (uint256 key) {
        bytes32 domain = NULLIFIER_DOMAIN;
        assembly ("memory-safe") {
            mstore(0, domain)
            mstore(32, nullifierHash)
            key := keccak256(0, 64)
            if iszero(key) { key := 1 }
        }
    }

    function nullifierNonceKeysHash(bytes32 nullifierHash) public pure returns (bytes32) {
        return _nonceKeysHash(nullifierNonceKey(nullifierHash));
    }

    function _nonceKeysHash(uint256 key) private pure returns (bytes32 result) {
        assembly ("memory-safe") {
            mstore(0, 1)
            mstore(32, key)
            result := keccak256(0, 64)
        }
    }

    function _validateFrameEnvelope(WithdrawalIntent calldata intent) private view {
        // Guard frame indexes before evaluating all fixed-envelope fields.
        if (
            FrameTxLib.txSender() != address(this) || FrameTxLib.frameCount() != 2
                || FrameTxLib.currentFrameIndex() != 0
        ) revert InvalidFrameTransaction();
        // OR of XOR differences is zero iff every field matches. These reads
        // have no side effects; one final branch replaces per-field branches.
        uint256 mismatch = uint256(FrameTxLib.frameMode(0)) ^ 1;
        mismatch |= uint256(FrameTxLib.frameFlags(0)) ^ 3;
        mismatch |= uint256(uint160(FrameTxLib.frameTarget(0))) ^ uint256(uint160(address(this)));
        mismatch |= FrameTxLib.frameValue(0);
        mismatch |= FrameTxLib.frameGasLimit(0) ^ intent.verifyGasLimit;
        mismatch |= FrameTxLib.frameStateGasLimit(0) ^ VERIFY_STATE_GAS_LIMIT;
        mismatch |= uint256(FrameTxLib.frameMode(1)) ^ 2;
        mismatch |= uint256(uint160(FrameTxLib.frameTarget(1))) ^ uint256(uint160(address(this)));
        mismatch |= uint256(FrameTxLib.frameFlags(1));
        mismatch |= FrameTxLib.frameValue(1);
        mismatch |= FrameTxLib.frameGasLimit(1) ^ EXECUTE_GAS_LIMIT;
        mismatch |= FrameTxLib.frameStateGasLimit(1) ^ EXECUTE_STATE_GAS_LIMIT;
        mismatch |= FrameTxLib.signatureCount();
        mismatch |= FrameTxLib.recentRootReferenceCount();
        mismatch |= uint256(FrameTxLib.txParam(FrameTxLib.TX_PARAM_BLOB_HASH_COUNT));
        mismatch |= uint256(FrameTxLib.txParam(FrameTxLib.TX_PARAM_BLOB_FEE_CAP));
        if (mismatch != 0) revert InvalidFrameTransaction();

        // Exact length plus full-word comparisons preserve canonical padding.
        if (FrameTxLib.frameDataSize(1) != 132) revert InvalidFrameTransaction();
        mismatch = (uint256(FrameTxLib.frameDataLoad(0, 1)) >> 224) ^ uint32(this.executeWithdrawal.selector);
        mismatch |= uint256(FrameTxLib.frameDataLoad(4, 1) ^ intent.nullifierHash);
        mismatch |= uint256(FrameTxLib.frameDataLoad(36, 1)) ^ uint256(uint160(intent.recipient));
        mismatch |= uint256(FrameTxLib.frameDataLoad(68, 1)) ^ uint256(intent.nonceSeq);
        mismatch |= uint256(FrameTxLib.frameDataLoad(100, 1)) ^ intent.gasCharge;
        if (mismatch != 0) revert InvalidFrameTransaction();

        mismatch = FrameTxLib.maxCost() ^ intent.gasCharge;
        mismatch |= uint256(FrameTxLib.txParam(FrameTxLib.TX_PARAM_GAS_TIP_CAP)) ^ intent.maxPriorityFeePerGas;
        mismatch |= uint256(FrameTxLib.txParam(FrameTxLib.TX_PARAM_GAS_FEE_CAP)) ^ intent.maxFeePerGas;
        if (mismatch != 0) revert InvalidGasTerms();
    }

    function _validateNonce(WithdrawalIntent calldata intent) private pure {
        if (FrameTxLib.nonceKeyCount() != 1) revert InvalidNonceKey();
        uint256 key = nullifierNonceKey(intent.nullifierHash);
        uint256 mismatch = FrameTxLib.nonceKey0() ^ key;
        mismatch |= uint256(FrameTxLib.nonceKeysHash() ^ _nonceKeysHash(key));
        mismatch |= FrameTxLib.nonceSeq() ^ uint256(intent.nonceSeq);
        if (mismatch != 0) revert InvalidNonceKey();
    }

    // The release contract embeds its generated verification key and code.
    function _verifyWithdrawalProof(bytes calldata proof, bytes32 root, bytes32 nullifierHash, bytes32 context)
        internal
        view
        virtual
        returns (bool);

    function _hashPair(bytes32 left, bytes32 right) private view returns (bytes32) {
        return bytes32(hasher.poseidon([uint256(left), uint256(right)]));
    }

    function _deliver(address payable recipient, uint256 amount) internal virtual {
        // Creation and destruction in the same transaction avoids recipient
        // callbacks. Both execution and state gas are pinned in validation.
        new ForcedEther{value: amount}(recipient);
    }
}

contract ForcedEther {
    constructor(address payable recipient) payable {
        selfdestruct(recipient);
    }
}
