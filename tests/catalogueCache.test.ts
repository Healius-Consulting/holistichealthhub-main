import assert from 'node:assert/strict';
import test from 'node:test';
import {
  parseCatalogueCache,
  serialiseCatalogueCache,
  shouldDiscardCatalogueCache,
} from '../src/utils/catalogueCache.ts';
import { curaleafCatalogueEstate, isCuraleafTestCatalogue } from '../src/utils/catalogueEstate.ts';

const sampleItem = {
  id: 'p1',
  name: 'Cannabis flos 10g',
  cost: null,
  retail: 92,
  availability: 'in' as const,
  type: 'flos' as const,
};

test('unknown catalogue environment is treated as test', () => {
  assert.equal(curaleafCatalogueEstate(undefined), 'test');
  assert.equal(curaleafCatalogueEstate('live'), 'test');
  assert.equal(curaleafCatalogueEstate('production'), 'production');
  assert.equal(isCuraleafTestCatalogue('curaleaf', 'production'), false);
  assert.equal(isCuraleafTestCatalogue('curaleaf', null), true);
  assert.equal(isCuraleafTestCatalogue('training', 'test'), false);
});

test('legacy cache without environment is treated as test and discarded on production fetch', () => {
  const cached = parseCatalogueCache(JSON.stringify({ items: [sampleItem], updatedAt: '2026-08-29T00:00:00Z' }));
  assert.equal(cached?.environment, 'test');
  assert.equal(shouldDiscardCatalogueCache(cached?.environment, 'production'), true);
  assert.equal(shouldDiscardCatalogueCache('production', 'production'), false);
  assert.equal(shouldDiscardCatalogueCache('test', 'test'), false);
});

test('serialised cache keeps the estate so a key rotation can be detected', () => {
  const raw = serialiseCatalogueCache([sampleItem], '2026-08-29T00:00:00Z', 'production');
  const parsed = parseCatalogueCache(raw);
  assert.equal(parsed?.environment, 'production');
  assert.equal(parsed?.items[0]?.id, 'p1');
  assert.equal(shouldDiscardCatalogueCache(parsed?.environment, 'test'), true);
});
