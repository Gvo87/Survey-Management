// Fails the build if the respondent app's initial JavaScript exceeds the performance budget
// (docs/01-architecture.md §1.8: ≤ 100 KB gzipped, so a survey loads in < 2 s on 4G).
import { readdirSync, readFileSync } from 'node:fs';
import { gzipSync } from 'node:zlib';

const BUDGET_KB = 100;
const dir = new URL('../dist/assets/', import.meta.url);
const files = readdirSync(dir).filter((f) => f.endsWith('.js'));
let total = 0;
for (const file of files) {
  const gz = gzipSync(readFileSync(new URL(file, dir))).length;
  total += gz;
  console.log(`${file.padEnd(40)} ${(gz / 1024).toFixed(1)} KB gz`);
}
console.log(`total JS: ${(total / 1024).toFixed(1)} KB gz (budget ${BUDGET_KB} KB)`);
if (total / 1024 > BUDGET_KB) {
  console.error('Respondent bundle exceeds its performance budget.');
  process.exit(1);
}
