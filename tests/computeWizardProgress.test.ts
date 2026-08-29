import assert from 'node:assert/strict';
import test from 'node:test';
import {
  computeWizardProgress,
  deriveRxSubStep,
  isRouteChosen,
  prescriptionUploaded,
  wizardNextHint,
} from '../src/pages/create-order/computeWizardProgress.ts';
import type { Prescription } from '../src/context/AppContext.ts';

const blankRx = (overrides: Partial<Prescription> = {}): Prescription => ({
  id: 1,
  entryMode: 'clinic',
  prescriber: '',
  copyFileName: null,
  items: [],
  placed: false,
  purchaseOrderId: null,
  status: 'draft',
  invoiceRef: null,
  trackingNumber: null,
  carrier: null,
  ...overrides,
});

test('fresh empty draft starts at step 1', () => {
  const progress = computeWizardProgress({
    patientReady: false,
    prescriptionAuthenticated: false,
    prescriptionReady: false,
    readyForProducts: false,
    draftBasketCount: 0,
    selectedBasketCount: 0,
    readyForPayment: false,
    selectedRx: blankRx(),
    routeExplicitlyChosen: false,
    isReplacement: false,
  });
  assert.equal(progress.suggestedFocus, 1);
  assert.equal(progress.furthestUnlocked, 1);
  assert.equal(progress.basketUnlocked, false);
  assert.equal(progress.routeChosen, false);
});

test('patient prefilled from overview lands on step 2', () => {
  const progress = computeWizardProgress({
    patientReady: true,
    prescriptionAuthenticated: false,
    prescriptionReady: false,
    readyForProducts: false,
    draftBasketCount: 0,
    selectedBasketCount: 0,
    readyForPayment: false,
    selectedRx: blankRx(),
    routeExplicitlyChosen: false,
    isReplacement: false,
  });
  assert.equal(progress.suggestedFocus, 2);
  assert.equal(progress.rxSubStep, 'route');
});

test('redo with carried medicines stays on step 2 with provisional basket', () => {
  const progress = computeWizardProgress({
    patientReady: true,
    prescriptionAuthenticated: false,
    prescriptionReady: false,
    readyForProducts: false,
    draftBasketCount: 2,
    selectedBasketCount: 2,
    readyForPayment: false,
    selectedRx: blankRx({ prescriber: 'Dr Smith', items: [{ productId: 'p1', formulaId: 'f1', name: 'Oil', qty: 1, unitsNeededCount: 1, cost: null, retail: 85 }] }),
    routeExplicitlyChosen: false,
    isReplacement: true,
  });
  assert.equal(progress.suggestedFocus, 2);
  assert.equal(progress.basketIsProvisional, true);
  assert.equal(progress.basketUnlocked, false);
  assert.equal(progress.routeChosen, false);
});

test('prefilled prescriber alone does not mark route chosen', () => {
  assert.equal(isRouteChosen(blankRx({ prescriber: 'Dr Smith', entryMode: 'manual' }), false), false);
  assert.equal(isRouteChosen(blankRx({ prescriber: 'Dr Smith', entryMode: 'manual' }), true), true);
});

test('resumed draft with verified file opens on upload sub-step', () => {
  const rx = blankRx({ copyFileName: 'rx.pdf', fileId: 'file-1', entryMode: 'manual' });
  assert.equal(prescriptionUploaded(rx), true);
  assert.equal(isRouteChosen(rx, false), true);
  assert.equal(deriveRxSubStep(rx, true), 'details');
  const progress = computeWizardProgress({
    patientReady: true,
    prescriptionAuthenticated: false,
    prescriptionReady: false,
    readyForProducts: false,
    draftBasketCount: 0,
    selectedBasketCount: 0,
    readyForPayment: false,
    selectedRx: rx,
    routeExplicitlyChosen: false,
    isReplacement: false,
  });
  assert.equal(progress.suggestedFocus, 2);
  assert.equal(progress.rxSubStep, 'details');
});

test('manual auth complete unlocks step 3 before medicines are priced', () => {
  const progress = computeWizardProgress({
    patientReady: true,
    prescriptionAuthenticated: true,
    prescriptionReady: false,
    readyForProducts: true,
    draftBasketCount: 0,
    selectedBasketCount: 0,
    readyForPayment: false,
    selectedRx: blankRx({
      entryMode: 'manual',
      copyFileName: 'rx.pdf',
      fileId: 'file-1',
      serialNumber: 'RX-100',
      prescriber: 'Dr Smith',
      prescriberPin: '1234',
      issueDate: '2026-08-01',
    }),
    routeExplicitlyChosen: true,
    isReplacement: false,
  });
  assert.equal(progress.furthestUnlocked, 3);
  assert.equal(progress.suggestedFocus, 3);
  assert.equal(progress.steps[2].complete, true);
  assert.equal(progress.steps[3].complete, false);
});

test('authenticated prescription with basket unlocks step 4 focus when ready', () => {
  const progress = computeWizardProgress({
    patientReady: true,
    prescriptionAuthenticated: true,
    prescriptionReady: true,
    readyForProducts: true,
    draftBasketCount: 1,
    selectedBasketCount: 1,
    readyForPayment: true,
    selectedRx: blankRx({ clinicScanId: 'scan-1', copyFileName: 'rx.pdf' }),
    routeExplicitlyChosen: false,
    isReplacement: false,
  });
  assert.equal(progress.furthestUnlocked, 4);
  assert.equal(progress.suggestedFocus, 4);
  assert.equal(progress.basketUnlocked, true);
});

test('paid redo with price difference can focus step 4 when auth complete', () => {
  const progress = computeWizardProgress({
    patientReady: true,
    prescriptionAuthenticated: true,
    prescriptionReady: true,
    readyForProducts: true,
    draftBasketCount: 2,
    selectedBasketCount: 2,
    readyForPayment: false,
    selectedRx: blankRx({ clinicScanId: 'scan-1', serialNumber: 'SN1' }),
    routeExplicitlyChosen: false,
    isReplacement: true,
  });
  assert.equal(progress.suggestedFocus, 4);
  assert.equal(progress.basketUnlocked, true);
});

test('incomplete second prescription does not unlock payment', () => {
  const progress = computeWizardProgress({
    patientReady: true,
    prescriptionAuthenticated: true,
    prescriptionReady: false,
    readyForProducts: true,
    draftBasketCount: 2,
    selectedBasketCount: 2,
    readyForPayment: false,
    selectedRx: blankRx({ clinicScanId: 'scan-1', copyFileName: 'rx.pdf' }),
    routeExplicitlyChosen: false,
    isReplacement: false,
  });
  assert.equal(progress.furthestUnlocked, 3);
  assert.equal(progress.steps[3].complete, true);
  assert.equal(progress.steps[4].complete, false);
  assert.equal(progress.basketUnlocked, true);
});

test('selected prescription without packs does not mark medicines complete', () => {
  const progress = computeWizardProgress({
    patientReady: true,
    prescriptionAuthenticated: false,
    prescriptionReady: false,
    readyForProducts: false,
    draftBasketCount: 2,
    selectedBasketCount: 0,
    readyForPayment: false,
    selectedRx: blankRx(),
    routeExplicitlyChosen: false,
    isReplacement: false,
  });
  assert.equal(progress.furthestUnlocked, 2);
  assert.equal(progress.steps[3].complete, false);
  assert.equal(progress.basketUnlocked, true);
});

test('mixed clinic and manual: selected clinic can unlock medicines while payment stays locked', () => {
  const clinicRx = blankRx({
    id: 1,
    clinicScanId: 'scan-1',
    copyFileName: 'clinic.pdf',
    curaleafPrescriptionId: 'curaleaf-1',
    prescriber: 'Dr Smith',
    prescriberId: 'p1',
    issueDate: '2026-08-01',
    expiryDate: '2026-08-29',
    items: [{ productId: 'p1', formulaId: 'f1', name: 'Oil', qty: 1, unitsNeededCount: 1, cost: 40, retail: 85 }],
  });
  const progress = computeWizardProgress({
    patientReady: true,
    prescriptionAuthenticated: true,
    prescriptionReady: false,
    readyForProducts: true,
    draftBasketCount: 1,
    selectedBasketCount: 1,
    readyForPayment: false,
    selectedRx: clinicRx,
    routeExplicitlyChosen: false,
    isReplacement: false,
  });
  assert.equal(progress.furthestUnlocked, 3);
  assert.equal(progress.steps[3].complete, true);
  assert.equal(progress.steps[4].complete, false);
});

test('incomplete second prescription is named in the next-step hint', () => {
  const progress = computeWizardProgress({
    patientReady: true,
    prescriptionAuthenticated: true,
    prescriptionReady: false,
    readyForProducts: true,
    draftBasketCount: 2,
    selectedBasketCount: 2,
    readyForPayment: false,
    selectedRx: blankRx({ clinicScanId: 'scan-1', copyFileName: 'rx.pdf' }),
    routeExplicitlyChosen: false,
    isReplacement: false,
  });
  assert.equal(wizardNextHint({
    progress,
    patientLinked: true,
    patientEligible: true,
    entryMode: 'clinic',
    readyForProducts: true,
    draftBasketCount: 2,
    incompletePrescriptionCount: 1,
  }), 'Finish the remaining prescription before requesting payment.');
});

