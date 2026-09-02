import assert from 'node:assert/strict';
import test from 'node:test';
import { curaleafPlacementUnlocked, snapshotQuoteFromCatalogue } from '../src/utils/curaleafPlacement.ts';

test('placement stays locked in training and local preview', () => {
  assert.equal(curaleafPlacementUnlocked({
    workspaceMode: 'training',
    localPreview: false,
    catalogueSource: 'curaleaf',
    catalogueEnvironment: 'production',
  }), false);
  assert.equal(curaleafPlacementUnlocked({
    workspaceMode: 'live',
    localPreview: true,
    catalogueSource: 'curaleaf',
    catalogueEnvironment: 'production',
  }), false);
  assert.equal(curaleafPlacementUnlocked({
    workspaceMode: 'live',
    localPreview: false,
    catalogueSource: 'unavailable',
    catalogueEnvironment: 'production',
  }), false);
});

test('placement unlocks on Live production Curaleaf, or on Primary and Alternate sandbox keys', () => {
  assert.equal(curaleafPlacementUnlocked({
    workspaceMode: 'test',
    localPreview: false,
    catalogueSource: 'curaleaf',
    catalogueEnvironment: 'test',
  }), false);
  assert.equal(curaleafPlacementUnlocked({
    workspaceMode: 'test',
    localPreview: false,
    catalogueSource: 'curaleaf',
    catalogueEnvironment: 'test',
    organisationId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
  }), false);
  assert.equal(curaleafPlacementUnlocked({
    workspaceMode: 'test',
    localPreview: false,
    catalogueSource: 'curaleaf',
    catalogueEnvironment: 'test',
    organisationId: '70913a30-71c3-4a41-952e-d532927af58c',
  }), true);
  assert.equal(curaleafPlacementUnlocked({
    workspaceMode: 'test',
    localPreview: false,
    catalogueSource: 'curaleaf',
    catalogueEnvironment: 'test',
    organisationId: 'f486a221-2236-44a5-b072-f06de399ab0e',
  }), true);
  assert.equal(curaleafPlacementUnlocked({
    workspaceMode: 'live',
    localPreview: false,
    catalogueSource: 'curaleaf',
    catalogueEnvironment: 'production',
  }), true);
});

test('snapshot quote uses the catalogue table and does not invent missing packs', () => {
  const { quote, missingPackIds } = snapshotQuoteFromCatalogue(
    [{ packId: 'pack-1', quantity: 2 }, { packId: 'missing', quantity: 1 }],
    [{
      id: 'pack-1',
      cost: 42,
      retail: 85,
      availability: 'in',
      supplierState: 'ACTIVE',
    }],
  );
  assert.deepEqual(missingPackIds, ['missing']);
  assert.equal(quote.items.length, 1);
  assert.equal(quote.items[0]?.packId, 'pack-1');
  assert.equal(quote.items[0]?.quantity, 2);
  assert.equal(quote.items[0]?.patientPackPrice, '85.00');
  assert.equal(quote.items[0]?.wholesalePackPrice, '42.00');
  assert.equal(quote.items[0]?.inStock, true);
  assert.equal(quote.shippingPrice, '0.00');
});

test('snapshot quote can price a simulated pack from the prescription when the catalogue table is empty', () => {
  const { quote, missingPackIds } = snapshotQuoteFromCatalogue(
    [{ packId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1', quantity: 1 }],
    [],
    [{ productId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1', cost: 42, retail: 85 }],
  );
  assert.deepEqual(missingPackIds, []);
  assert.equal(quote.items[0]?.patientPackPrice, '85.00');
  assert.equal(quote.items[0]?.wholesalePackPrice, '42.00');
});
