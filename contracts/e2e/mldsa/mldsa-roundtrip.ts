/**
 * ML-DSA-ETH round-trip test: keygen → sign → verify.
 * Run: cd contracts && npx tsx e2e/mldsa/mldsa-roundtrip.ts
 */

import { keygen, sign, verify, toHex, MLDSA_PK_SIZE, MLDSA_SIG_SIZE } from "../helpers/mldsa-eth.js";
import { c } from "../helpers/log.js";
import { randomBytes } from "crypto";

const line = "─".repeat(50);

console.log(`\n${c.cyan}${c.bold}${line}${c.reset}`);
console.log(`${c.cyan}${c.bold}  ML-DSA-ETH Round-Trip Test${c.reset}`);
console.log(`${c.cyan}${c.bold}${line}${c.reset}\n`);

// 1. KeyGen
console.log(`${c.cyan}▶${c.reset} Generating ML-DSA-ETH key pair...`);
const t0 = Date.now();
const { expandedPK, secretKey } = keygen();
const keygenMs = Date.now() - t0;
console.log(`  ${c.green}✓${c.reset} KeyGen complete (${keygenMs}ms)`);
console.log(`  PK size:  ${expandedPK.length} bytes (expected ${MLDSA_PK_SIZE})`);
console.log(`  SK size:  ${secretKey.length} bytes`);
console.log(`  PK hash:  ${toHex(expandedPK).slice(0, 18)}...`);

if (expandedPK.length !== MLDSA_PK_SIZE) {
  throw new Error(`PK size mismatch: ${expandedPK.length} != ${MLDSA_PK_SIZE}`);
}

// 2. Sign
const msg = randomBytes(32);
console.log(`\n${c.cyan}▶${c.reset} Signing message ${toHex(msg).slice(0, 18)}...`);
const t1 = Date.now();
const signature = sign(secretKey, msg);
const signMs = Date.now() - t1;
console.log(`  ${c.green}✓${c.reset} Sign complete (${signMs}ms)`);
console.log(`  Sig size: ${signature.length} bytes (expected ${MLDSA_SIG_SIZE})`);

if (signature.length !== MLDSA_SIG_SIZE) {
  throw new Error(`Sig size mismatch: ${signature.length} != ${MLDSA_SIG_SIZE}`);
}

// 3. Verify (valid)
console.log(`\n${c.cyan}▶${c.reset} Verifying signature (should be VALID)...`);
const t2 = Date.now();
const valid = verify(msg, signature, expandedPK);
const verifyMs = Date.now() - t2;
console.log(`  ${valid ? c.green + "✓ VALID" : c.red + "✗ INVALID"}${c.reset} (${verifyMs}ms)`);

if (!valid) {
  throw new Error("Signature verification FAILED — round-trip broken!");
}

// 4. Verify with wrong message (should be invalid)
console.log(`\n${c.cyan}▶${c.reset} Verifying with wrong message (should be INVALID)...`);
const wrongMsg = randomBytes(32);
const invalid = verify(wrongMsg, signature, expandedPK);
console.log(`  ${!invalid ? c.green + "✓ Correctly rejected" : c.red + "✗ Should have been rejected"}${c.reset}`);

if (invalid) {
  throw new Error("Wrong-message signature was accepted — verification is broken!");
}

// 5. Multiple sign/verify rounds
console.log(`\n${c.cyan}▶${c.reset} Running 3 additional sign/verify rounds...`);
for (let i = 0; i < 3; i++) {
  const m = randomBytes(32);
  const s = sign(secretKey, m);
  const ok = verify(m, s, expandedPK);
  if (!ok) throw new Error(`Round ${i + 1} verification failed`);
  console.log(`  ${c.green}✓${c.reset} Round ${i + 1} passed`);
}

console.log(`\n${c.cyan}${c.bold}${line}${c.reset}`);
console.log(`${c.bgGreen}${c.bold} ML-DSA-ETH Round-Trip: ALL PASSED ${c.reset}`);
console.log(`${c.cyan}${c.bold}${line}${c.reset}\n`);
