import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import * as snarkjs from 'snarkjs';
import { internalizeVerifier } from '../scripts/internal-verifier.mjs';
import { getFrameTransactionGas } from 'viem/eip8141';
import { CommitmentTree, FIELD, MAX_GAS_CHARGE, VERIFY_GAS, buildDir, bytes32, createNote, noteFromSecrets,
    proveWithdrawal, statementHash, settleGasCharge, buildWithdrawalTransaction, verifyArtifacts } from '../src/index.mjs';

after(async () => { await globalThis.curve_bn128?.terminate(); });

const context = bytes32((1n << 255n) + 12345n);
const vk = JSON.parse(readFileSync(resolve(buildDir, 'verification_key.json')));
const tree = await CommitmentTree.create();
const notes = await Promise.all([noteFromSecrets(11n, 22n), noteFromSecrets(33n, 44n), noteFromSecrets(55n, 66n)]);
const roots = [];
for (const note of notes) roots.push((await tree.insert(note.commitment)).root);
const result = await proveWithdrawal(notes[1], tree.path(1), context);

const vectors = [];
for (const [i, digest] of [0n, FIELD - 1n, (1n << 256n) - 1n].entries()) {
    const ctx = bytes32(digest);
    const vector = await proveWithdrawal(notes[i], tree.path(i), ctx);
    vectors.push({ context: ctx, proof: vector.encoded, root: tree.root, nullifierHash: notes[i].nullifierHash });
}

// Public fixtures only: no production secrets, and no note secrets are exported.
writeFileSync(resolve(buildDir, 'fixture.json'), JSON.stringify({
    context, proof: result.encoded, root: tree.root, nullifierHash: notes[1].nullifierHash,
    vectors, commitments: notes.map(n => n.commitment), roots, provingMs: result.provingMs,
}, null, 2));

const verify = (signals, proof = result.proof) => snarkjs.groth16.verify(vk, signals, proof);
test('real proof verifies; all public inputs are bound', async () => {
    assert.equal(await verify(result.publicSignals), true);
    for (let i = 0; i < result.publicSignals.length; i++) {
        const signals = [...result.publicSignals];
        signals[i] = (BigInt(signals[i]) + 1n).toString();
        assert.equal(await verify(signals), false, `public input ${i}`);
    }
    assert.deepEqual(result.publicSignals.map(BigInt), [BigInt(tree.root), BigInt(notes[1].nullifierHash), BigInt(context) % FIELD]);
    assert.equal((result.encoded.length - 2) / 2, 256);
});
test('O2 retains a nonlinear constraint on the public context', async () => {
    const r1cs = await snarkjs.r1cs.exportJson(resolve(buildDir, 'O2/withdraw.r1cs'));
    assert.equal(r1cs.nOutputs, 0);
    assert.equal(r1cs.nPubInputs, 3);
    // Public inputs occupy wires 1..3; context must occur in a product, not
    // merely be declared or eliminated as a linear alias by the optimizer.
    assert.ok(r1cs.constraints.some(([a, b]) =>
        Object.hasOwn(a, '3') && Object.hasOwn(b, '3')));
    assert.equal(vk.nPublic, 3);
});
test('wrong witness does not produce a membership proof', async () => {
    const wrongPath = tree.path(1); wrongPath.siblings[0] += 1n;
    await assert.rejects(proveWithdrawal(notes[1], wrongPath, context));
});
test('note secrets use canonical field values and random notes differ', async () => {
    await assert.rejects(noteFromSecrets(FIELD, 2n), /Noncanonical/);
    await assert.rejects(noteFromSecrets(1n, 0n), /Zero/);
    const a = await createNote(), b = await createNote();
    assert.notEqual(a.commitment, b.commitment);
    assert.notEqual(a.nullifierHash, b.nullifierHash);
});
test('event replay reproduces the same tree; duplicate and unknown leaves fail', async () => {
    const replay = await CommitmentTree.create();
    for (let i = 0; i < notes.length; i++) assert.equal((await replay.insert(notes[i].commitment)).root, roots[i]);
    assert.deepEqual(replay.path(1), tree.path(1));
    await assert.rejects(replay.insert(notes[1].commitment), /duplicate/);
    assert.throws(() => replay.path(3), /Unknown/);
});
test('authorization binds deployment, chain, recipient, retry and maximum charge', () => {
    const pool = '0x0000000000000000000000000000000000001234';
    const intent = { root: tree.root, nullifierHash: notes[1].nullifierHash,
        recipient: '0x000000000000000000000000000000000000beef', nonceSeq: 0n,
        maxGasCharge: MAX_GAS_CHARGE, gasCharge: 0n, verifyGasLimit: VERIFY_GAS,
        maxFeePerGas: 10n, maxPriorityFeePerGas: 1n };
    const hash = statementHash(1337, pool, 10n ** 18n, intent);
    for (const patch of [{ nonceSeq: 1n }, { maxGasCharge: MAX_GAS_CHARGE - 1n },
        { recipient: '0x000000000000000000000000000000000000cafe' }]) {
        assert.notEqual(hash, statementHash(1337, pool, 10n ** 18n, { ...intent, ...patch }));
    }
    assert.notEqual(hash, statementHash(1, pool, 10n ** 18n, intent));
    assert.notEqual(hash, statementHash(1337, '0x0000000000000000000000000000000000001235', 10n ** 18n, intent));
    assert.equal(hash, statementHash(1337, pool, 10n ** 18n, { ...intent, gasCharge: 99n }));
    const settled = settleGasCharge(1337, pool, result.encoded, intent, 10n ** 18n);
    assert.equal(settled.gasCharge, getFrameTransactionGas(buildWithdrawalTransaction(1337, pool, result.encoded, settled)) * settled.maxFeePerGas);
    assert.throws(() => settleGasCharge(1337, pool, result.encoded, { ...intent, maxFeePerGas: 10n ** 12n }, 10n ** 18n), /exceeds/);
});
test('O2 reduces constraints without changing public signals', () => {
    const m = verifyArtifacts();
    assert.equal(m.developmentOnly, true);
    assert.equal(m.metrics.O2.publicInputs + m.metrics.O2.outputs, 3);
    assert.ok(m.metrics.O2.constraints < m.metrics.O1.constraints);
    console.log(`O1=${m.metrics.O1.constraints}, O2=${m.metrics.O2.constraints}, prove=${result.provingMs}ms`);
});

test('internal verifier transformation matches artifacts and rejects template drift', () => {
    const external = readFileSync(resolve(buildDir, 'DevelopmentGroth16Verifier.sol'), 'utf8');
    assert.equal(internalizeVerifier(external), readFileSync(resolve(buildDir, 'InternalGroth16Verifier.sol'), 'utf8'));
    assert.throws(() => internalizeVerifier(external.replace('pLastMem = 896', 'pLastMem = 1024')), /template/);
    assert.throws(() => internalizeVerifier(external.replace('function g1_mulAccC', 'function changed_mul')), /template/);
    assert.throws(() => internalizeVerifier(external.replace('let pMem :=', 'stop()\n            let pMem :=')), /terminating/);
});
