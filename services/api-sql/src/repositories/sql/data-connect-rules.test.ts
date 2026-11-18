import assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

/**
 * Two Data Connect rules that the type checker can't see and that only fail at
 * run time, as a 500:
 *
 * 1. "@check is disallowed on side-effect fields unless the operation has
 *    @transaction". This broke admin "Save details" on an enquiry (18 Nov 2026).
 * 2. "cannot mix _and/_or/_not with specific fields". A filter can't put _or
 *    (or _and/_not) beside plain fields at the same level; wrap them all in _and.
 *    This broke the Worldpay reconciliation job.
 *
 * Every GraphQL operation the API, the connectors and the one-off scripts send is
 * scanned for both.
 */

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, '../../../../..');
const ROOTS = ['services/api-sql/src', 'dataconnect/connectors', 'scripts'];
const SKIP_DIRS = new Set(['node_modules', 'dist', '.dataconnect']);

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap(name => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return SKIP_DIRS.has(name) ? [] : sourceFiles(path);
    if (name.includes('.test.')) return [];
    return /\.(ts|gql)$/.test(name) ? [path] : [];
  });
}

const LOGIC_KEYS = new Set(['_or', '_and', '_not']);
const OPENERS = '{[(';
const CLOSERS = '}])';

export function mutationsWithCheckButNoTransaction(source: string): string[] {
  const offenders: string[] = [];
  for (const check of source.matchAll(/@check\b/g)) {
    const at = check.index ?? 0;
    const header = source.lastIndexOf('mutation', at);
    if (header === -1 || source.lastIndexOf('query ', at) > header) continue;
    const brace = source.indexOf('{', header);
    const name = /mutation\s*(\w*)/.exec(source.slice(header))?.[1] || '(anonymous)';
    if (!source.slice(header, brace).includes('@transaction') && !offenders.includes(name)) offenders.push(name);
  }
  return offenders;
}

/** Keys written directly inside the object that opens at `open`. */
function topLevelKeys(source: string, open: number): string[] {
  const keys: string[] = [];
  let depth = 0;
  for (let i = open; i < source.length; i++) {
    const char = source[i] ?? '';
    if (OPENERS.includes(char)) depth++;
    else if (CLOSERS.includes(char)) {
      depth--;
      if (depth === 0) break;
    } else if (depth === 1 && !/[\w$]/.test(source[i - 1] ?? '')) {
      const key = /^([A-Za-z_]\w*)\s*:/.exec(source.slice(i));
      if (key?.[1]) {
        keys.push(key[1]);
        i += key[0].length - 1;
      }
    }
  }
  return keys;
}

export function filtersMixingLogicWithFields(source: string): number[] {
  const lines: number[] = [];
  const seen = new Set<number>();
  for (const logic of source.matchAll(/\b(_or|_and|_not)\s*:/g)) {
    let depth = 0;
    let open = (logic.index ?? 0) - 1;
    for (; open >= 0; open--) {
      const char = source[open] ?? '';
      if (CLOSERS.includes(char)) depth++;
      else if (OPENERS.includes(char)) {
        if (depth === 0) break;
        depth--;
      }
    }
    if (open < 0 || source[open] !== '{' || seen.has(open)) continue;
    seen.add(open);
    const keys = topLevelKeys(source, open);
    if (keys.some(key => LOGIC_KEYS.has(key)) && keys.some(key => !LOGIC_KEYS.has(key))) {
      lines.push(source.slice(0, open).split('\n').length);
    }
  }
  return lines;
}

const files = ROOTS.flatMap(root => sourceFiles(join(repoRoot, root)));

test('the scan finds the API, connector and script sources', () => {
  assert.ok(files.some(file => file.endsWith('repositories/sql/payment.sql.ts')));
  assert.ok(files.some(file => file.endsWith('connectors/server/mutations.gql')));
});

test('every mutation that uses @check is a @transaction', () => {
  const offenders = files.flatMap(file => mutationsWithCheckButNoTransaction(readFileSync(file, 'utf8'))
    .map(name => `${relative(repoRoot, file)}: ${name}`));
  assert.deepEqual(offenders, []);
});

test('no filter puts _or, _and or _not beside plain fields', () => {
  const offenders = files.flatMap(file => filtersMixingLogicWithFields(readFileSync(file, 'utf8'))
    .map(line => `${relative(repoRoot, file)}:${line}`));
  assert.deepEqual(offenders, []);
});

test('the checks spot both mistakes', () => {
  const noTransaction = 'mutation Bad($id: UUID!) {\n  thing_updateMany(where: {}) @check(expr: "this == 1")\n}';
  const withTransaction = 'mutation Good($id: UUID!) @transaction {\n  thing_updateMany(where: {}) @check(expr: "this == 1")\n}';
  assert.deepEqual(mutationsWithCheckButNoTransaction(noTransaction), ['Bad']);
  assert.deepEqual(mutationsWithCheckButNoTransaction(withTransaction), []);

  const mixed = 'payments(where: {\n  route: { eq: WORLDPAY }\n  _or: [{ status: { eq: PENDING } }]\n})';
  const wrapped = 'payments(where: {\n  _and: [{ route: { eq: WORLDPAY } }, { _or: [{ status: { eq: PENDING } }] }]\n})';
  assert.deepEqual(filtersMixingLogicWithFields(mixed), [1]);
  assert.deepEqual(filtersMixingLogicWithFields(wrapped), []);
});
