import assert from 'node:assert/strict';
import test from 'node:test';
import type { Prescription } from '../src/context/AppContext.ts';
import { incompletePrescriptionPaymentGates, rxAuthenticated, rxTabStatus } from '../src/pages/create-order/rxTabStatus.ts';

const blankRx = (overrides: Partial<Prescription> = {}): Prescription => ({
  id: 1,
  entryMode: 'clinic',
  prescriber: '',
  copyFileName: null,
  items: [],
  placed: false,
  poRef: null,
  status: 'draft',
  invoiceRef: null,
  trackingNumber: null,
  carrier: null,
  ...overrides,
});

test('blank prescription needs a copy', () => {
  assert.equal(rxTabStatus(blankRx()), 'needs copy');
});

test('uploaded clinic scan without packs needs medicines', () => {
  assert.equal(rxTabStatus(blankRx({
    copyFileName: 'rx.pdf',
    clinicScanId: 'scan-1',
    curaleafPrescriptionId: 'curaleaf-1',
    prescriber: 'Dr Smith',
    prescriberId: 'p1',
    issueDate: '2026-08-01',
    expiryDate: '2026-08-29',
  })), 'needs medicines');
});

test('complete clinic prescription is ready', () => {
  const rx = blankRx({
    copyFileName: 'rx.pdf',
    clinicScanId: 'scan-1',
    curaleafPrescriptionId: 'curaleaf-1',
    prescriber: 'Dr Smith',
    prescriberId: 'p1',
    issueDate: '2026-08-01',
    expiryDate: '2026-08-29',
    items: [{ productId: 'p1', formulaId: 'f1', name: 'Oil', qty: 1, unitsNeededCount: 1, cost: 40, retail: 85 }],
  });
  assert.equal(rxTabStatus(rx), 'ready');
  assert.equal(rxAuthenticated(rx), true);
});

test('manual prescription without serial is not authenticated', () => {
  const rx = blankRx({
    entryMode: 'manual',
    copyFileName: 'rx.pdf',
    prescriber: 'Dr Smith',
    prescriberPin: '1234',
    issueDate: '2026-08-01',
    expiryDate: '2026-08-29',
  });
  assert.equal(rxAuthenticated(rx), false);
  assert.equal(rxTabStatus(rx), 'needs details');
});

const pricedItem = { productId: 'p1', formulaId: 'f1', name: 'Oil', qty: 1, unitsNeededCount: 1, cost: 40, retail: 85 };

test('mixed clinic and manual prescriptions can each be ready independently', () => {
  const clinic = blankRx({
    id: 1,
    copyFileName: 'clinic.pdf',
    clinicScanId: 'scan-1',
    curaleafPrescriptionId: 'curaleaf-1',
    prescriber: 'Dr Smith',
    prescriberId: 'p1',
    issueDate: '2026-08-01',
    expiryDate: '2026-08-29',
    items: [pricedItem],
  });
  const manual = blankRx({
    id: 2,
    entryMode: 'manual',
    copyFileName: 'manual.pdf',
    serialNumber: 'SN-2',
    prescriber: 'Dr Jones',
    prescriberPin: '4321',
    issueDate: '2026-08-01',
    expiryDate: '2026-08-29',
    items: [{ ...pricedItem, productId: 'p2', formulaId: 'f2', name: 'Flower' }],
  });
  assert.equal(rxTabStatus(clinic), 'ready');
  assert.equal(rxTabStatus(manual), 'ready');
  assert.equal(rxAuthenticated(clinic), true);
  assert.equal(rxAuthenticated(manual), true);
});

test('payment gates name the incomplete tab without serials or names', () => {
  const ready = blankRx({
    id: 1,
    copyFileName: 'clinic.pdf',
    clinicScanId: 'scan-1',
    curaleafPrescriptionId: 'curaleaf-1',
    prescriber: 'Dr Smith',
    prescriberId: 'p1',
    issueDate: '2026-08-01',
    expiryDate: '2026-08-29',
    items: [pricedItem],
  });
  const missingCopy = blankRx({ id: 2, entryMode: 'manual' });
  const gates = incompletePrescriptionPaymentGates([ready, missingCopy]);
  assert.deepEqual(gates, [{ label: 'Prescription 2 needs a copy', complete: false }]);
  assert.equal(incompletePrescriptionPaymentGates([ready]).length, 0);
});
