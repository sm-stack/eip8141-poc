// Generate LOCAL DEVELOPMENT keys, never release ceremony artifacts.
import { spawnSync } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { poseidonContract } from 'circomlibjs';
import * as snarkjs from 'snarkjs';
import { internalizeVerifier } from './internal-verifier.mjs';

const contracts = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const out = resolve(contracts, 'privacy-pool/build');
const sha = (path) => createHash('sha256').update(readFileSync(path)).digest('hex');
const circuit = resolve(contracts, 'privacy-pool/circuits/withdraw.circom');
const sourceHash = sha(circuit);
const lockHash = sha(resolve(contracts, 'package-lock.json'));
const scriptHash = sha(fileURLToPath(import.meta.url));
const solc = resolve(contracts, '../build/bin/solc');
const solcHash = sha(solc);
const contractHashes = Object.fromEntries([
    'src/example/PrivacyPool8141.sol', 'src/privacy/Groth16PrivacyPoolVerifier.sol',
    'src/test-helpers/PrivacyPoolDeliveryHarness.sol', 'src/interfaces/IPrivacyPoolVerifier.sol',
    'src/FrameTxLib.sol', 'privacy-pool/scripts/internal-verifier.mjs',
].map(p => [p, sha(resolve(contracts, p))]));
if (!process.argv.includes('--development-only')) {
    throw new Error('This setup is single-party and NOT safe for real deposits. Pass --development-only for local testing.');
}
mkdirSync(out, { recursive: true });
const manifestPath = resolve(out, 'manifest.json');
if (existsSync(manifestPath)) {
    const m = JSON.parse(readFileSync(manifestPath));
    if (m.sourceHash === sourceHash && m.lockHash === lockHash && m.scriptHash === scriptHash && m.solcHash === solcHash && JSON.stringify(m.contractHashes) === JSON.stringify(contractHashes) &&
        Object.entries(m.files).every(([p, h]) => existsSync(resolve(out, p)) && sha(resolve(out, p)) === h)) {
        console.log('Development circuit artifacts verified; reusing local setup.');
        process.exit(0);
    }
}
function run(bin, args, label) {
    console.log(label);
    const r = spawnSync(resolve(contracts, 'node_modules/.bin', bin), args, {
        cwd: contracts, encoding: 'utf8', maxBuffer: 32 * 1024 * 1024,
    });
    if (r.status !== 0) throw new Error(`${label}\n${r.stdout}\n${r.stderr}`);
    return r.stdout;
}
const metrics = {};
for (const optimization of ['O1', 'O2']) {
    const dir = resolve(out, optimization);
    mkdirSync(dir, { recursive: true });
    const start = performance.now();
    const log = run('circom2', [circuit, '--r1cs', '--wasm', '--sym', `--${optimization}`, '-l', 'node_modules', '-o', dir], `Compile ${optimization}`);
    writeFileSync(resolve(dir, 'compile.log'), log);
    const info = await snarkjs.r1cs.info(resolve(dir, 'withdraw.r1cs'));
    metrics[optimization] = { constraints: info.nConstraints, wires: info.nVars, publicInputs: info.nPubInputs, outputs: info.nOutputs, compileMs: Math.round(performance.now() - start) };
}
const power = Math.ceil(Math.log2(metrics.O2.constraints + 5));
if (power > 16) throw new Error('Unexpected circuit size; inspect constraints before increasing the setup.');
const p0 = resolve(out, 'phase1-initial.ptau');
const p1 = resolve(out, 'phase1-contributed.ptau');
const ptau = resolve(out, 'development.ptau');
run('snarkjs', ['powersoftau', 'new', 'bn128', String(power), p0], 'Create local phase 1');
run('snarkjs', ['powersoftau', 'contribute', p0, p1, '--name=local-development', `-e=${randomBytes(64).toString('hex')}`], 'Contribute local entropy (not a ceremony)');
run('snarkjs', ['powersoftau', 'prepare', 'phase2', p1, ptau], 'Prepare phase 2');
const z0 = resolve(out, 'initial.zkey');
const zkey = resolve(out, 'withdraw.zkey');
run('snarkjs', ['groth16', 'setup', resolve(out, 'O2/withdraw.r1cs'), ptau, z0], 'Create circuit key');
run('snarkjs', ['zkey', 'contribute', z0, zkey, '--name=local-development', `-e=${randomBytes(64).toString('hex')}`], 'Contribute local phase 2 entropy');
run('snarkjs', ['zkey', 'verify', resolve(out, 'O2/withdraw.r1cs'), ptau, zkey], 'Verify circuit key');
run('snarkjs', ['zkey', 'export', 'verificationkey', zkey, resolve(out, 'verification_key.json')], 'Export verification key');
run('snarkjs', ['zkey', 'export', 'solidityverifier', zkey, resolve(out, 'DevelopmentGroth16Verifier.sol')], 'Export development verifier');
// snarkjs reserves 2000 gas via SUB after GAS. The frame validation tracer
// permits GAS only immediately before CALL*. Forward gas directly; EIP-150
// still retains 1/64 in the caller. No curve arithmetic or inputs are changed.
const exported = resolve(out, 'DevelopmentGroth16Verifier.sol');
const upstream = readFileSync(exported, 'utf8');
writeFileSync(resolve(out, 'UpstreamGroth16Verifier.sol'), upstream);
const gasPattern = /sub\(gas\(\), 2000\)/g;
if ([...upstream.matchAll(gasPattern)].length !== 3) throw new Error('Unexpected snarkjs verifier template: review gas forwarding');
writeFileSync(exported, upstream.replace(gasPattern, 'gas()'));
const compiled = spawnSync(solc, ['--optimize', '--combined-json', 'abi,bin', resolve(out, 'DevelopmentGroth16Verifier.sol')], { encoding: 'utf8' });
if (compiled.status !== 0) throw new Error(compiled.stderr);
const verifier = Object.values(JSON.parse(compiled.stdout).contracts)[0];
writeFileSync(resolve(out, 'verifier.json'), JSON.stringify({ abi: verifier.abi, bytecode: `0x${verifier.bin}` }, null, 2));
writeFileSync(resolve(out, 'InternalGroth16Verifier.sol'), internalizeVerifier(readFileSync(exported, 'utf8')));
// No external/self call: only native precompiles precede root/spent reads.
const embeddedSource = `// SPDX-License-Identifier: GPL-3.0
pragma solidity ^0.8.28;
import "./InternalGroth16Verifier.sol";
import {PrivacyPool8141, IPoseidon2} from "../../src/example/PrivacyPool8141.sol";
import {PrivacyPoolDeliveryHarness} from "../../src/test-helpers/PrivacyPoolDeliveryHarness.sol";
${[['Groth16PrivacyPool8141', 'PrivacyPool8141'], ['DevelopmentPrivacyPoolDeliveryHarness', 'PrivacyPoolDeliveryHarness']].map(([name, base]) => `
contract ${name} is ${base}, InternalGroth16Verifier {
    constructor(IPoseidon2 hasher, uint256 denomination) PrivacyPool8141(hasher, denomination) {}
    function _verifyWithdrawalProof(bytes calldata proof, bytes32 root, bytes32 nf, bytes32 context)
        internal view override returns (bool)
    {
        if (proof.length != 256) return false;
        uint256[2] calldata a;
        uint256[2][2] calldata b;
        uint256[2] calldata c;
        assembly {
            a := proof.offset
            b := add(proof.offset, 64)
            c := add(proof.offset, 192)
        }
        uint256[3] memory inputs = [uint256(root), uint256(nf), uint256(context) % FIELD];
        return _verifyGroth16(a, b, c, inputs);
    }
}`).join('\n')}
// Exposes the internal path only for differential and continuation tests.
contract DevelopmentInternalVerifierHarness is InternalGroth16Verifier {
    function verifyProof(uint256[2] calldata a, uint256[2][2] calldata b, uint256[2] calldata c, uint256[3] calldata inputs)
        external view returns (bool)
    { return _verifyGroth16(a, b, c, inputs); }
    function verifyAndContinue(uint256[2] calldata a, uint256[2][2] calldata b, uint256[2] calldata c, uint256[3] calldata inputs)
        external view returns (bool valid, bytes32 beforeHash, bytes32 afterHash)
    {
        bytes memory sentinel = abi.encode(a, b, c, inputs);
        beforeHash = keccak256(sentinel);
        valid = _verifyGroth16(a, b, c, inputs);
        bytes memory afterCall = abi.encode(a, b, c, inputs);
        require(keccak256(afterCall) == beforeHash, "post-verification allocation changed");
        afterHash = keccak256(sentinel);
    }
}
`;
writeFileSync(resolve(out, 'Groth16PrivacyPool8141.sol'), embeddedSource);
// This pool executes far more often than it deploys. Favor runtime gas while
// keeping both generated runtimes under the EIP-170 size limit.
const poolOptimizerRuns = 10_000;
// Match foundry.toml's pinned workaround for this development compiler:
// omit UnusedStoreEliminator (S), which triggers its Yul assertion bug.
const poolYulSteps = 'dhfoDgvulfnTUtnIfxa[r]EscLMVcul[j]Trpeulxa[r]cLgvifMCTUca[r]LsTFOtfDnca[r]IulcscCTUtgvifMx[scCTUt]TOntnfDIulgvifMjmul[jul]VcTOculjmul:fDnTOcmuO';
const poolCompilation = spawnSync(solc, ['--via-ir', '--optimize', '--optimize-runs', String(poolOptimizerRuns), '--yul-optimizations', poolYulSteps, '--combined-json', 'abi,bin,bin-runtime', resolve(out, 'Groth16PrivacyPool8141.sol')], { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 });
if (poolCompilation.status !== 0) throw new Error(poolCompilation.stderr);
const poolContracts = JSON.parse(poolCompilation.stdout).contracts;
for (const [name, file] of [['Groth16PrivacyPool8141', 'pool'], ['DevelopmentPrivacyPoolDeliveryHarness', 'pool-harness'], ['DevelopmentInternalVerifierHarness', 'internal-verifier']]) {
    const contract = Object.entries(poolContracts).find(([key]) => key.endsWith(`:${name}`))[1];
    const runtimeBytes = contract['bin-runtime'].length / 2;
    if (runtimeBytes > 24_576) throw new Error(`${name} exceeds EIP-170 runtime size`);
    writeFileSync(resolve(out, `${file}.json`), JSON.stringify({ abi: contract.abi, bytecode: `0x${contract.bin}`, runtimeBytes, optimizerRuns: poolOptimizerRuns, viaIR: true, yulOptimizerSteps: poolYulSteps }, null, 2));
}
writeFileSync(resolve(out, 'poseidon.json'), JSON.stringify({ abi: poseidonContract.generateABI(2), bytecode: poseidonContract.createCode(2) }, null, 2));
const files = {};
for (const p of ['O2/withdraw.r1cs', 'O2/withdraw_js/withdraw.wasm', 'withdraw.zkey', 'verification_key.json', 'verifier.json', 'poseidon.json', 'DevelopmentGroth16Verifier.sol', 'UpstreamGroth16Verifier.sol', 'Groth16PrivacyPool8141.sol', 'pool.json', 'pool-harness.json', 'InternalGroth16Verifier.sol', 'internal-verifier.json']) files[p] = sha(resolve(out, p));
writeFileSync(manifestPath, JSON.stringify({ developmentOnly: true, contractHashes, sourceHash, lockHash, scriptHash, solcHash, power, metrics, files }, null, 2));
console.log(JSON.stringify(metrics, null, 2));
console.log('Development setup complete. Independent ceremony and review required before real deposits.');
process.exit(0);
