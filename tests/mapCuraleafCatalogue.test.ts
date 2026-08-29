import assert from 'node:assert/strict';
import test from 'node:test';
import { mapCuraleafCatalogue } from '../src/utils/mapCuraleafCatalogue.ts';
import type { CuraleafCatalogue } from '../src/shared/contracts.ts';

function catalogue(overrides: Partial<CuraleafCatalogue> = {}): CuraleafCatalogue {
  return {
    environment: 'production',
    fetchedAt: '2026-08-29T00:00:00Z',
    formulas: [{
      formulaForm: 'FLOS',
      id: 'f1',
      printedName: 'Cannabis flos 10g',
      state: 'ACTIVE',
      unit: 'g',
    }],
    products: [{
      customerId: 'c1',
      formulaId: 'f1',
      formulaName: 'Cannabis flos 10g',
      formulaUnit: 'g',
      id: 'p1',
      patientPackPrice: '92.00',
      quantity: 10,
      state: 'ACTIVE',
    }],
    formulaTotal: 1,
    productTotal: 1,
    ...overrides,
  };
}

test('a normal flos pack maps through with quote-bank stock', () => {
  const items = mapCuraleafCatalogue(catalogue({
    products: [{
      customerId: 'c1',
      formulaId: 'f1',
      formulaName: 'Cannabis flos 10g',
      formulaUnit: 'g',
      id: 'p1',
      patientPackPrice: '92.00',
      quantity: 10,
      state: 'ACTIVE',
      quoteBankInStock: true,
      quoteBankStockStatus: 'in_stock',
    }],
  }));
  assert.equal(items.length, 1);
  assert.equal(items[0]?.name, 'Cannabis flos 10g');
  assert.equal(items[0]?.availability, 'in');
  assert.equal(items[0]?.supplierState, 'ACTIVE');
});

test('BPTEST and XSS names are dropped even when the other name field is clean', () => {
  const items = mapCuraleafCatalogue(catalogue({
    formulas: [
      { formulaForm: 'FLOS', id: 'f-safe', printedName: 'Cannabis flos 10g', state: 'ACTIVE', unit: 'g' },
      { formulaForm: 'OIL', id: 'f-xss', printedName: '<img src=x onerror=alert(1)>', state: 'ACTIVE', unit: 'ml' },
    ],
    products: [
      {
        customerId: 'c1',
        formulaId: 'f-safe',
        formulaName: 'BPTEST oil',
        formulaUnit: 'ml',
        id: 'p-junk',
        patientPackPrice: '10.00',
        quantity: 10,
        state: 'ACTIVE',
      },
      {
        customerId: 'c1',
        formulaId: 'f-xss',
        formulaName: 'Clean formula name',
        formulaUnit: 'ml',
        id: 'p-xss',
        patientPackPrice: '10.00',
        quantity: 10,
        state: 'ACTIVE',
      },
      {
        customerId: 'c1',
        formulaId: 'f-safe',
        formulaName: 'Cannabis flos 10g',
        formulaUnit: 'g',
        id: 'p-ok',
        patientPackPrice: '92.00',
        quantity: 10,
        state: 'ACTIVE',
      },
    ],
  }));
  assert.deepEqual(items.map(item => item.id), ['p-ok']);
});
