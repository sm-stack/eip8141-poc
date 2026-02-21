/**
 * Run all E2E test suites sequentially.
 *
 * Usage: cd contracts && npx tsx e2e/run-all.ts
 */

import { execSync } from "child_process";

const suites = [
  "e2e/simple/simple-basic.ts",
  "e2e/kernel/kernel-basic.ts",
  "e2e/kernel/kernel-validator.ts",
  "e2e/kernel-hooked/spending-limit.ts",
  "e2e/coinbase/coinbase-ecdsa.ts",
  "e2e/coinbase/coinbase-webauthn.ts",
];

let passed = 0;
let failed = 0;

for (const suite of suites) {
  console.log(`\n${"#".repeat(70)}`);
  console.log(`# Running: ${suite}`);
  console.log(`${"#".repeat(70)}\n`);
  try {
    execSync(`npx tsx ${suite}`, { stdio: "inherit", cwd: process.cwd() });
    passed++;
  } catch {
    failed++;
    console.error(`\nFAILED: ${suite}\n`);
  }
}

console.log(`\n${"=".repeat(70)}`);
console.log(`E2E Results: ${passed} passed, ${failed} failed, ${suites.length} total`);
console.log(`${"=".repeat(70)}\n`);

if (failed > 0) process.exit(1);
