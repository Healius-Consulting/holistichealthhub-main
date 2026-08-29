import assert from 'node:assert/strict';
import test from 'node:test';
import {
  catalogueStockLabel,
  catalogueStockStatus,
  catalogueStockToneClass,
} from '../src/utils/catalogueStock.ts';

test('discontinued lifecycle wins over quote-bank in-stock', () => {
  assert.equal(catalogueStockStatus({ supplierState: 'DISCONTINUED', availability: 'in' }), 'discontinued');
  assert.equal(catalogueStockLabel('discontinued'), 'Discontinued');
  assert.equal(catalogueStockToneClass('discontinued'), 'stock-out');
});

test('ACTIVE packs follow quote-bank availability', () => {
  assert.equal(catalogueStockStatus({ supplierState: 'ACTIVE', availability: 'in' }), 'in');
  assert.equal(catalogueStockStatus({ supplierState: 'ACTIVE', availability: 'low' }), 'low');
  assert.equal(catalogueStockStatus({ supplierState: 'ACTIVE', availability: 'out' }), 'out');
  assert.equal(catalogueStockStatus({ supplierState: 'ACTIVE', availability: 'unknown' }), 'unknown');
  assert.equal(catalogueStockLabel('in'), 'In stock');
  assert.equal(catalogueStockLabel('low'), 'Low stock');
  assert.equal(catalogueStockLabel('out'), 'Out of stock');
  assert.equal(catalogueStockLabel('unknown'), 'Not yet quoted');
});

test('missing supplier state maps availability only', () => {
  assert.equal(catalogueStockStatus({ availability: 'in' }), 'in');
});
