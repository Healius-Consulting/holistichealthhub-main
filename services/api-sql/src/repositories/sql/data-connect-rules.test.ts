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
 * 3. "key id is required in upsert but is not set in data". An `_upsert` matches on
 *    the table's key, so its data must name every key field. This broke ticking the
 *    go-live checklist, whose table is keyed on a generated `id`.
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

/** Each table's key fields: `id` unless `@table(key: ...)` names others. */
export function tableKeys(schema: string): Map<string, string[]> {
  const keys = new Map<string, string[]>();
  for (const match of schema.matchAll(/^type\s+(\w+)\s+@table(\([^)]*\))?/gm)) {
    const args = match[2] ?? '';
    const named = /key:\s*(\[[^\]]*\]|"[^"]*")/.exec(args)?.[1];
    keys.set(match[1]!, named ? [...named.matchAll(/"(\w+)"/g)].map(found => found[1]!) : ['id']);
  }
  return keys;
}

/** Upserts whose data leaves out part of the table key. A reference key is given by its target's key, as `organisationId` or `conditionCode`. */
export function upsertsMissingKey(source: string, keys: Map<string, string[]>): string[] {
  const offenders: string[] = [];
  for (const match of source.matchAll(/\b(\w+)_upsert\s*\(\s*data:\s*\{/g)) {
    const table = match[1]!.charAt(0).toUpperCase() + match[1]!.slice(1);
    const key = keys.get(table);
    if (!key) continue;
    const given = new Set(topLevelKeys(source, match.index! + match[0].length - 1));
    const missing = key.filter(field => !given.has(field) && ![...given].some(name => name.startsWith(field) && /^[A-Z]/.test(name.slice(field.length))));
    if (missing.length) offenders.push(`${match[1]}_upsert (missing ${missing.join(', ')})`);
  }
  return offenders;
}

const schemaKeys = tableKeys(readFileSync(join(repoRoot, 'dataconnect/schema/schema.gql'), 'utf8'));

test('every upsert names its table key', () => {
  assert.ok(schemaKeys.get('OrganisationChecklistItem')?.includes('id'));
  const offenders = files.flatMap(file => upsertsMissingKey(readFileSync(file, 'utf8'), schemaKeys)
    .map(name => `${relative(repoRoot, file)}: ${name}`));
  assert.deepEqual(offenders, []);
});

test('the upsert check spots a missing key', () => {
  const keys = tableKeys('type Thing @table {\n  id: UUID!\n}\ntype Pair @table(key: ["order", "prescription"]) {\n  order: Order!\n}');
  assert.deepEqual(keys.get('Pair'), ['order', 'prescription']);
  assert.deepEqual(upsertsMissingKey('thing_upsert(data: {\n  name: $name\n})', keys), ['thing_upsert (missing id)']);
  assert.deepEqual(upsertsMissingKey('thing_upsert(data: {\n  id: $id\n  name: $name\n})', keys), []);
  assert.deepEqual(upsertsMissingKey('pair_upsert(data: {\n  orderId: $o\n  prescription: { id: $p }\n})', keys), []);
  assert.deepEqual(upsertsMissingKey('pair_upsert(data: {\n  orderId: $o\n  prescriptionCode: $p\n})', keys), []);
  assert.deepEqual(upsertsMissingKey('pair_upsert(data: {\n  orderId: $o\n  prescriptions: $p\n})', keys), ['pair_upsert (missing prescription)']);
});
