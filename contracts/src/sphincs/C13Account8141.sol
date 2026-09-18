// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;
import {FrameTxLib} from "../FrameTxLib.sol";
import {C13Verifier} from "./C13Verifier.sol";

/// @notice Research C13 self-paying account. Direct deployment, PQ-authorized rotation only.
/// @dev Nonstandard, unaudited cryptography. No claim of production or FIPS approval.
contract C13Account8141 {
    bytes32 public constant OWNER_DOMAIN = keccak256("8141.c13.owner.v1");
    bytes32 public constant CHALLENGE_DOMAIN = keccak256("8141.c13.transaction.v2");
    uint256 internal constant SIGNATURE_LENGTH = 3688;
    uint256 internal constant SIGNATURE_PADDED_LENGTH = 3712;
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

    /// @notice Message signed by the C13 key for a transaction signature hash.
    /// @dev The canonical signature hash already commits to the chain, this
    ///      account, the nonce, fees, every frame (including the key and epoch
    ///      in VERIFY calldata) and every signature entry except its own bytes.
    function challenge(bytes32 sigHash) public pure returns (bytes32) {
        return keccak256(abi.encode(CHALLENGE_DOMAIN, sigHash));
    }

    function validate(bytes32 seed, bytes32 root, uint64 epoch) external view {
        if (msg.sender != address(0xAA)) revert Unauthorized();
        // One VERIFY authorizes one self-targeted SENDER call. The C13 witness
        // is the single ARBITRARY signature entry: its bytes are elided from the
        // canonical signature hash, so it signs that hash without circularity.
        if (
            FrameTxLib.txSender() != address(this) || FrameTxLib.frameCount() != 2
                || FrameTxLib.currentFrameIndex() != 0 || FrameTxLib.frameMode(0) != 1
                || FrameTxLib.frameTarget(0) != address(this) || FrameTxLib.frameFlags(0) != 3
                || FrameTxLib.frameValue(0) != 0 || FrameTxLib.frameMode(1) != 2
                || FrameTxLib.frameTarget(1) != address(this) || FrameTxLib.frameFlags(1) != 0
                || FrameTxLib.frameValue(1) != 0 || FrameTxLib.signatureCount() != 1
                || FrameTxLib.recentRootReferenceCount() != 0 || FrameTxLib.nonceKeyCount() != 1
                || uint256(FrameTxLib.txParam(FrameTxLib.TX_PARAM_BLOB_HASH_COUNT)) != 0
                || uint256(FrameTxLib.txParam(FrameTxLib.TX_PARAM_BLOB_FEE_CAP)) != 0
        ) revert InvalidEnvelope();
        // Solidity rejects a non-canonical uint64; the exact length rejects
        // trailing calldata. An explicit-message entry would not sign this tx.
        if (
            FrameTxLib.signatureScheme(0) != FrameTxLib.SIGNATURE_SCHEME_ARBITRARY
                || FrameTxLib.signatureMessage(0) != bytes32(0) || FrameTxLib.signatureLength(0) != SIGNATURE_LENGTH
                || FrameTxLib.frameDataSize(1) > 16_384 || msg.data.length != 100
        ) revert InvalidEnvelope();
        if (!_verify(seed, root, challenge(FrameTxLib.sigHash()))) revert InvalidSignature();
        if (keyCommitment(seed, root, epoch) != ownerCommitment) revert InvalidKey();
        FrameTxLib.approveEmpty(FrameTxLib.SCOPE_EXECUTION_AND_PAYMENT);
    }

    function _verify(bytes32 seed, bytes32 root, bytes32 message) private view returns (bool valid) {
        address target = address(verifier);
        bytes4 selector = C13Verifier.verify.selector;
        // Copy the witness straight into the verifier's ABI buffer. Bytes past
        // the end of the signature copy as zero, which is the ABI padding.
        // Temporary memory only; GAS immediately precedes STATICCALL.
        assembly ("memory-safe") {
            let p := mload(0x40)
            mstore(p, selector)
            mstore(add(p, 4), seed)
            mstore(add(p, 36), root)
            mstore(add(p, 68), message)
            mstore(add(p, 100), 128)
            mstore(add(p, 132), SIGNATURE_LENGTH)
            sigdatacopy(add(p, 164), 0, SIGNATURE_PADDED_LENGTH, 0)
            let ok := staticcall(gas(), target, p, add(164, SIGNATURE_PADDED_LENGTH), 0, 32)
            valid := and(and(ok, eq(returndatasize(), 32)), eq(mload(0), 1))
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
