// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;
import {FrameTxLib} from "../FrameTxLib.sol";
import {C13Verifier} from "./C13Verifier.sol";

/// @notice Research C13 self-paying account. Direct deployment, PQ-authorized rotation only.
/// @dev Nonstandard, unaudited cryptography. No claim of production or FIPS approval.
contract C13Account8141 {
    bytes32 public constant OWNER_DOMAIN = keccak256("8141.c13.owner.v1");
    bytes32 public constant CHALLENGE_DOMAIN = keccak256("8141.c13.transaction.v1");
    C13Verifier public immutable verifier;
    bytes32 public ownerCommitment;
    uint64 public ownerEpoch;

    struct Call {
        address target;
        uint256 value;
        bytes data;
    }
    error Unauthorized();
    error InvalidEnvelope();
    error InvalidSignature();
    error InvalidKey();
    error InvalidBatch();
    event OwnerChanged(uint64 indexed epoch, bytes32 indexed commitment);

    constructor(bytes32 seed, bytes32 root) {
        _checkKey(seed, root);
        verifier = new C13Verifier();
        ownerCommitment = keyCommitment(seed, root, 0);
        emit OwnerChanged(0, ownerCommitment);
    }
    receive() external payable {}

    function _checkKey(bytes32 seed, bytes32 root) private pure {
        if (uint128(uint256(seed)) != 0 || uint128(uint256(root)) != 0 || root == 0) revert InvalidKey();
    }

    function keyCommitment(bytes32 seed, bytes32 root, uint64 epoch) public pure returns (bytes32) {
        return keccak256(abi.encode(OWNER_DOMAIN, seed, root, epoch));
    }

    function challenge(bytes32 envelopeHash, uint64 epoch, uint256 maxGasCharge) public view returns (bytes32) {
        return keccak256(abi.encode(CHALLENGE_DOMAIN, block.chainid, address(this), envelopeHash, epoch, maxGasCharge));
    }

    function validate(bytes32 seed, bytes32 root, uint64 epoch, uint256 maxGasCharge, bytes calldata signature)
        external
        view
    {
        if (msg.sender != address(0xAA)) revert Unauthorized();
        // One VERIFY authorizes one self-targeted SENDER call. This fork's
        // sigHash includes VERIFY calldata, so use an explicit envelope hash
        // to avoid signing a message containing its own C13 signature.
        if (
            FrameTxLib.txSender() != address(this) || FrameTxLib.frameCount() != 2
                || FrameTxLib.currentFrameIndex() != 0 || FrameTxLib.frameMode(0) != 1
                || FrameTxLib.frameTarget(0) != address(this) || FrameTxLib.frameFlags(0) != 3
                || FrameTxLib.frameValue(0) != 0 || FrameTxLib.frameMode(1) != 2
                || FrameTxLib.frameTarget(1) != address(this) || FrameTxLib.frameFlags(1) != 0
                || FrameTxLib.frameValue(1) != 0 || FrameTxLib.signatureCount() != 0
                || FrameTxLib.recentRootReferenceCount() != 0 || FrameTxLib.nonceKeyCount() != 1
                || uint256(FrameTxLib.txParam(FrameTxLib.TX_PARAM_BLOB_HASH_COUNT)) != 0
                || uint256(FrameTxLib.txParam(FrameTxLib.TX_PARAM_BLOB_FEE_CAP)) != 0
        ) revert InvalidEnvelope();
        if (
            maxGasCharge == 0 || FrameTxLib.maxCost() > maxGasCharge || FrameTxLib.frameDataSize(1) > 16_384
                || msg.data.length != 3908 || signature.length != 3688
        ) revert InvalidEnvelope();
        // Solidity checks uint64 encoding and bytes bounds; fix the dynamic
        // offset and require the final 24 ABI padding bytes to be zero.
        bool canonical;
        assembly ("memory-safe") {
            canonical := and(eq(signature.offset, 196), iszero(calldataload(3884)))
        }
        if (!canonical) revert InvalidEnvelope();
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
                _executionHash()
            )
        );
        if (!verifier.verify(seed, root, challenge(hash, epoch, maxGasCharge), signature)) revert InvalidSignature();
        if (keyCommitment(seed, root, epoch) != ownerCommitment) revert InvalidKey();
        FrameTxLib.approveEmpty(FrameTxLib.SCOPE_EXECUTION_AND_PAYMENT);
    }

    function _executionHash() private pure returns (bytes32 hash) {
        // Temporary memory only: do not retain a 16 KiB allocation while ABI
        // encoding the subsequent verifier call. The size was bounded above.
        assembly ("memory-safe") {
            let p := mload(0x40)
            let size := frameparam(4, 1)
            framedatacopy(p, 0, size, 1)
            hash := keccak256(p, size)
        }
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

    function rotateOwner(bytes32 seed, bytes32 root) external onlySelf {
        _checkKey(seed, root);
        ownerEpoch += 1;
        ownerCommitment = keyCommitment(seed, root, ownerEpoch);
        emit OwnerChanged(ownerEpoch, ownerCommitment);
    }
}
