import assert from 'node:assert/strict';
import test from 'node:test';
import * as client from '../packages/domain/curaleaf-catalogue-label.js';
import * as server from '../services/api-sql/src/domain/curaleaf-catalogue-label.ts';

const SAFE = 'Cannabis flos 10g';

const DROP = [
  ['BPTEST sandbox pack', 'BPTEST flower 10g'],
  ['bptest case-insensitive', 'Curaleaf bptest oil'],
  ['script tag', '<script>alert(1)</script>'],
  ['iframe tag', '<iframe src="https://evil.example">'],
  ['img onerror', '<img src=x onerror=alert(1)>'],
  ['svg onload', '<svg onload=alert(1)>'],
  ['anchor tag', '<a href="https://evil.example">click</a>'],
  ['javascript URL', 'javascript:alert(1)'],
  ['vbscript URL', 'vbscript:msgbox(1)'],
  ['data HTML URL', 'data:text/html,<script>alert(1)</script>'],
  ['file URL', 'file:///etc/passwd'],
  ['command substitution', 'flos $(whoami)'],
  ['template substitution', 'flos ${process.env}'],
  ['backtick command', 'flos `id`'],
  ['path traversal', '../etc/passwd'],
  ['executable suffix', 'payload.exe'],
  ['html suffix', 'note.html'],
];

for (const impl of [
  { name: 'workspace helper', fn: client.curaleafCatalogueLabelIsUnsafe },
  { name: 'api-sql helper', fn: server.curaleafCatalogueLabelIsUnsafe },
]) {
  test(`${impl.name} keeps a normal Cannabis flos pack`, () => {
    assert.equal(impl.fn(SAFE), false);
  });

  for (const [label, payload] of DROP) {
    test(`${impl.name} drops ${label}`, () => {
      assert.equal(impl.fn(payload), true);
    });
  }
}

test('workspace and api-sql helpers agree on every fixture', () => {
  const fixtures = [SAFE, '', null, undefined, ...DROP.map(([, payload]) => payload)];
  for (const value of fixtures) {
    assert.equal(
      client.curaleafCatalogueLabelIsUnsafe(value),
      server.curaleafCatalogueLabelIsUnsafe(value),
      `helpers diverged on ${JSON.stringify(value)}`,
    );
  }
});

test('a dirty printedName still drops a pack whose formulaName is clean', () => {
  assert.equal(client.curaleafCataloguePackIsUnsafe(
    { formulaName: SAFE, formulaUnit: 'g' },
    { printedName: '<script>alert(1)</script>', unit: 'g' },
  ), true);
  assert.equal(server.curaleafCataloguePackIsUnsafe(
    { formulaName: SAFE, formulaUnit: 'g' },
    { printedName: '<script>alert(1)</script>', unit: 'g' },
  ), true);
});

test('a dirty formulaUnit drops the pack', () => {
  assert.equal(client.curaleafCatalogueRecordIsUnsafe({
    formulaName: SAFE,
    printedName: SAFE,
    formulaUnit: 'javascript:alert(1)',
  }), true);
});

test('stripUnsafeCuraleafCatalogue drops junk products and formula fallbacks', () => {
  const { formulas, products } = client.stripUnsafeCuraleafCatalogue(
    [
      { id: 'f-ok', printedName: SAFE, unit: 'g' },
      { id: 'f-xss', printedName: '<script>alert(1)</script>', unit: 'g' },
    ],
    [
      { id: 'p-ok', formulaId: 'f-ok', formulaName: SAFE, formulaUnit: 'g' },
      { id: 'p-junk', formulaId: 'f-ok', formulaName: 'BPTEST oil', formulaUnit: 'ml' },
    ],
  );
  assert.deepEqual(products.map(row => row.id), ['p-ok']);
  assert.deepEqual(formulas.map(row => row.id), ['f-ok']);
});
