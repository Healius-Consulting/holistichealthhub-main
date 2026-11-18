import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));

/**
 * Data Connect refuses a mutation that puts @check on a write unless the whole
 * operation is marked @transaction, and the refusal only shows at run time as a
 * 500 ("@check is disallowed on side-effect fields unless the operation has
 * @transaction"). That is how admin "Save details" on an enquiry broke on 18 Nov 2026.
 */
function mutationsWithCheckButNoTransaction(source: string) {
  const offenders: string[] = [];
  const pattern = /mutation\s+(\w+)\s*(\([^)]*\))?([^{]*)\{/g;
  for (const match of source.matchAll(pattern)) {
    const start = (match.index ?? 0) + match[0].length;
    const ends = ['`', '\nmutation ', '\nquery '].map(token => source.indexOf(token, start)).filter(index => index !== -1);
    const body = source.slice(start, ends.length ? Math.min(...ends) : source.length);
    if (body.includes('@check') && !(match[3] ?? '').includes('@transaction')) offenders.push(match[1] ?? '');
  }
  return offenders;
}

test('every SQL repository mutation that uses @check is a @transaction', () => {
  const offenders = readdirSync(here)
    .filter(name => name.endsWith('.ts') && !name.endsWith('.test.ts'))
    .flatMap(name => mutationsWithCheckButNoTransaction(readFileSync(join(here, name), 'utf8')).map(op => `${name}: ${op}`));
  assert.deepEqual(offenders, []);
});

test('the check spots a mutation missing @transaction', () => {
  const bad = 'const GQL = `\n  mutation Bad($id: UUID!) {\n    thing_updateMany(where: {}) @check(expr: "this == 1")\n  }\n`;';
  const good = 'const GQL = `\n  mutation Good($id: UUID!) @transaction {\n    thing_updateMany(where: {}) @check(expr: "this == 1")\n  }\n`;';
  assert.deepEqual(mutationsWithCheckButNoTransaction(bad), ['Bad']);
  assert.deepEqual(mutationsWithCheckButNoTransaction(good), []);
});
