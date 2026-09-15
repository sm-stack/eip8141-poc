// A checked control-flow adaptation of the pinned snarkjs template. Keep the
// upstream file for review; do not silently accept a new template shape.
export function internalizeVerifier(source) {
    const once = (from, to) => {
        if (source.split(from).length !== 2) throw new Error(`Unexpected verifier template: ${from.slice(0, 80)}`);
        source = source.replace(from, to);
    };
    // The scratch reservation below relies on this exact pinned memory layout.
    for (const declaration of ['uint16 constant pVk = 0;', 'uint16 constant pPairing = 128;', 'uint16 constant pLastMem = 896;']) {
        once(declaration, declaration);
    }
    once('contract Groth16Verifier {', 'abstract contract InternalGroth16Verifier {');
    once('function verifyProof(uint[2] calldata _pA, uint[2][2] calldata _pB, uint[2] calldata _pC, uint[3] calldata _pubSignals) public view returns (bool)',
        'function _verifyGroth16(uint[2] calldata _pA, uint[2][2] calldata _pB, uint[2] calldata _pC, uint[3] memory _pubSignals) internal view returns (bool valid)');
    once(`            function checkField(v) {
                if iszero(lt(v, r)) {
                    mstore(0, 0)
                    return(0, 0x20)
                }
            }`, '            // Field checks below return a Solidity bool instead of terminating the frame.');
    once('function g1_mulAccC(pR, x, y, s) {\n                let success',
        'function g1_mulAccC(pR, x, y, s) -> success {');
    const failure = '                    mstore(0, 0)\n                    return(0, 0x20)';
    if (source.split(failure).length !== 3) throw new Error('Expected two EC failure exits');
    source = source.replaceAll(failure, '                    leave');
    for (const [i, offset] of [[1, 0], [2, 32], [3, 64]]) {
        once(`g1_mulAccC(_pVk, IC${i}x, IC${i}y, calldataload(add(pubSignals, ${offset})))`,
            `if iszero(g1_mulAccC(_pVk, IC${i}x, IC${i}y, mload(add(pubSignals, ${offset})))) { leave }`);
    }
    const tail = /            \/\/ Validate that all evaluations ∈ F[\s\S]*?return\(0, 0x20\)/g;
    if ([...source.matchAll(tail)].length !== 1) throw new Error('Expected one final verification block');
    source = source.replace(tail, `            // _pubSignals is a memory array; A/B/C still point into calldata.
            if and(and(lt(mload(_pubSignals), r), lt(mload(add(_pubSignals, 32)), r)), lt(mload(add(_pubSignals, 64)), r)) {
                valid := checkPairing(_pA, _pB, _pC, _pubSignals, pMem)
            }
            // g1_mulAccC uses 128 scratch bytes beyond pLastMem. The external
            // template terminates immediately, but our caller continues and
            // must not reuse that scratch area as live allocated memory.
            mstore(0x40, add(pMem, 1024))`);
    if (/\b(?:return|revert|stop|selfdestruct)\s*\(/.test(source)) throw new Error('Unexpected frame-terminating opcode in internal verifier');
    return source;
}
