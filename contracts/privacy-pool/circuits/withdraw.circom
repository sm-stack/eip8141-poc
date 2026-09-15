pragma circom 2.2.3;

include "circomlib/circuits/poseidon.circom";
include "circomlib/circuits/bitify.circom";

// Public signals: [root, nullifierHash, context].
// context = uint256(keccak256(withdrawal statement)) % BN254 scalar field.
// Like Tornado's binding-only inputs, context participates in a nonlinear
// square constraint that survives O2; it must not be an unused public input.
template Withdrawal(depth) {
    signal input root;
    signal input nullifierHash;
    signal input context;
    signal input secret;
    signal input nullifierSecret;
    signal input leafIndex;
    signal input siblings[depth];
    signal contextSquare;
    contextSquare <== context * context;

    component indexBits = Num2Bits(depth);
    indexBits.in <== leafIndex;

    component commitment = Poseidon(3);
    commitment.inputs[0] <== 1;
    commitment.inputs[1] <== nullifierSecret;
    commitment.inputs[2] <== secret;

    component nullifier = Poseidon(2);
    nullifier.inputs[0] <== 2;
    nullifier.inputs[1] <== nullifierSecret;
    nullifier.out === nullifierHash;

    signal nodes[depth + 1];
    signal swap[depth];
    component hashes[depth];
    nodes[0] <== commitment.out;
    for (var i = 0; i < depth; i++) {
        // One multiplication per conditional swap; the bit constraint is
        // provided once by indexBits. Avoid two independent multiplexers.
        swap[i] <== indexBits.out[i] * (siblings[i] - nodes[i]);
        hashes[i] = Poseidon(2);
        hashes[i].inputs[0] <== nodes[i] + swap[i];
        hashes[i].inputs[1] <== siblings[i] - swap[i];
        nodes[i + 1] <== hashes[i].out;
    }
    nodes[depth] === root;
}

component main {public [root, nullifierHash, context]} = Withdrawal(20);
