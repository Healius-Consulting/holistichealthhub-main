import assert from 'node:assert/strict';
import test from 'node:test';
import type { PatientOrder, Prescription } from '../src/context/AppContext.tsx';
import { buildOrderStageRail, buildOrderTimelineEvents, buildPrescriptionStageRail, buildPrescriptionTimelineEvents, placementRoute } from '../src/utils/orderTimeline.ts';

const tenPackPrescription: Prescription = {
  id: 101,
  entryMode: 'manual',
  prescriber: 'Dr Prescriber',
  copyFileName: null,
  items: [{ productId: '9f2d6958-2d76-4338-9e5f-6fd383dfff36', name: 'Medication', qty: 10, cost: 68, retail: 120 }],
  placed: true,
  placedAt: '2026-08-13T09:23:29.241487Z',
  purchaseOrderId: 'HHH-a55ee7d4-6466-4e95-bf7f-88a95241e60f-383b50e0f9',
  status: 'partially-received',
  invoiceRef: null,
  trackingNumber: null,
  carrier: 'POLAR_SPEED',
  shipmentId: '796adea9-f2d9-43b2-ad5c-ccfc4184ee62',
  shipmentIds: ['796adea9-f2d9-43b2-ad5c-ccfc4184ee62'],
  shipmentStates: {
    '796adea9-f2d9-43b2-ad5c-ccfc4184ee62': 'collected',
  },
  fulfilmentLines: [{
    productId: '9f2d6958-2d76-4338-9e5f-6fd383dfff36',
    ordered: 10,
    requested: 10,
    sent: 10,
    supplierReportedOrdered: 10,
    allocated: 1,
    shipped: 1,
    remaining: 9,
    received: 1,
    collected: 1,
    returned: 0,
    backordered: true,
    quantityMismatch: false,
  }],
  shipments: [{
    id: '796adea9-f2d9-43b2-ad5c-ccfc4184ee62',
    createdAt: '2026-08-17T08:50:45.621344Z',
    items: [{ productId: '9f2d6958-2d76-4338-9e5f-6fd383dfff36', packCount: 1 }],
  }],
  latestShipmentAt: '2026-08-17T08:50:45.621344Z',
  goodsInAt: '2026-08-17T08:50:45.621344Z',
  readyAt: '2026-08-17T10:00:00.000Z',
};

const partialOrder: PatientOrder & { handoutAt?: string } = {
  id: 12,
  organisationId: '70913a3071c34a41952ed532927af58c',
  patientId: 'patient-1',
  date: new Date('2026-08-13T09:00:00.000Z'),
  dispensingFee: 0,
  payment: {
    status: 'paid',
    route: 'pharmacy',
    amount: 1200,
    ref: 'HHH-a55ee7d4-6466-4e95-bf7f-88a95241e60f-383b50e0f9',
    sentAt: new Date('2026-08-13T09:00:00.000Z'),
    paidAt: new Date('2026-08-13T09:05:00.000Z'),
    manualTender: 'epos-card',
    manualReference: 'EPOS-1',
    manualNotes: null,
    manualRecordedBy: null,
  },
  prescriptions: [tenPackPrescription],
  curaleafApprovedAt: '2026-08-13T09:23:29.241487Z',
  handoutAt: '2026-08-17T11:00:00.000Z',
};

test('partial check-in uses pack counts instead of full delivery wording', () => {
  const events = buildPrescriptionTimelineEvents(tenPackPrescription, 0);
  const checkIn = events.find(event => event.label.includes('checked in'));
  assert.ok(checkIn);
  assert.match(checkIn!.label, /partially checked in/i);
  assert.match(checkIn!.detail, /1 pack checked in; 9 remain with Curaleaf/);
  assert.notEqual(new Date(checkIn!.date as string).toISOString(), partialOrder.payment.paidAt!.toISOString());
});

test('ready to collect names the consignment shipment id', () => {
  const events = buildPrescriptionTimelineEvents(tenPackPrescription, 0);
  const ready = events.find(event => event.label.includes('ready to collect'));
  assert.ok(ready);
  assert.match(ready!.detail, /Consignment 796adea9/);
  assert.match(ready!.detail, /1 pack/);
});

test('partial handover records collected pack counts', () => {
  const events = buildPrescriptionTimelineEvents(tenPackPrescription, 0, partialOrder.handoutAt);
  const handout = events.find(event => event.label.includes('handed to patient'));
  assert.ok(handout);
  assert.match(handout!.label, /partially handed to patient/i);
  assert.match(handout!.detail, /1 of 10 packs collected; 9 remain on order/);
});

test('order timeline keeps payment and goods-in events on distinct timestamps', () => {
  const events = buildOrderTimelineEvents(partialOrder);
  const payment = events.find(event => event.label === 'Payment recorded');
  const checkIn = events.find(event => event.label.includes('partially checked in'));
  assert.ok(payment);
  assert.ok(checkIn);
  assert.notEqual(
    new Date(payment!.date as Date).getTime(),
    new Date(checkIn!.date as string).getTime(),
  );
});

test('order timeline translates the latest successful payment-gate check for pharmacy staff', () => {
  const events = buildOrderTimelineEvents({
    ...partialOrder,
    quoteChecks: [
      { id: 'matched-old', phase: 'PRE_PAYMENT', status: 'MATCHED', checkedAt: '2026-08-13T08:00:00.000Z', basketFingerprint: 'a', patientTotalPence: 10_000, wholesaleTotalPence: 5_000, shippingPence: 0, stockAvailable: true },
      { id: 'changed', phase: 'PRE_PLACEMENT', status: 'CHANGED', checkedAt: '2026-08-13T09:10:00.000Z', basketFingerprint: 'b', patientTotalPence: 11_000, wholesaleTotalPence: 5_500, shippingPence: 0, stockAvailable: true },
      { id: 'matched-new', phase: 'PRE_PLACEMENT', status: 'MATCHED', checkedAt: '2026-08-13T09:20:00.000Z', basketFingerprint: 'c', patientTotalPence: 11_000, wholesaleTotalPence: 5_500, shippingPence: 0, stockAvailable: true },
    ],
  });
  const matches = events.filter(event => event.label === 'Price and stock rechecked');
  assert.equal(matches.length, 1);
  assert.equal(matches[0]?.date, '2026-08-13T09:20:00.000Z');
  assert.match(matches[0]?.detail ?? '', /£110\.00 confirmed before Curaleaf submission/);
  assert.equal(matches[0]?.source, 'HHH automation');
});

/* ---- Placement rail ---- */

const unplacedPrescription: Prescription = {
  ...tenPackPrescription,
  id: 201,
  placed: false,
  placedAt: null,
  purchaseOrderId: null,
  status: 'draft',
  fulfilmentLines: [],
  shipments: [],
  shipmentIds: [],
  shipmentStates: {},
  latestShipmentAt: null,
  goodsInAt: null,
  readyAt: null,
};

function orderWith(overrides: Partial<PatientOrder>): PatientOrder {
  return {
    ...partialOrder,
    prescriptions: [unplacedPrescription],
    curaleafPlacement: undefined,
    ...overrides,
  } as PatientOrder;
}

test('the pharmacy placement rail leads with payment', () => {
  const rail = buildOrderStageRail(orderWith({}));
  assert.deepEqual(
    rail.pharmacyPlacement.map(entry => entry.key),
    ['payment', 'prescriber', 'prescription', 'purchase-order'],
  );
});

test('the two lanes are named for whoever is holding the order', () => {
  const rail = buildOrderStageRail(partialOrder);
  assert.ok(rail.pharmacyPlacement.length);
  assert.ok(rail.curaleafPlacement, 'a placed order has a Curaleaf lane');
});

test('a recorded clinic barcode is a QR placement', () => {
  const order = orderWith({ curaleafPlacement: { route: 'CLINIC_BARCODE' } as never });
  assert.equal(placementRoute(order), 'clinic_barcode');
});

test('a recorded manual placement stays manual even with clinic-entered prescriptions', () => {
  const order = orderWith({
    curaleafPlacement: { route: 'MANUAL_PRESCRIPTION' } as never,
    prescriptions: [{ ...unplacedPrescription, entryMode: 'clinic' }],
  });
  assert.equal(placementRoute(order), 'manual');
});

test('an order with no prescriptions is not treated as a clinic scan', () => {
  // The old rule used prescriptions.every(...), which is true for an empty list,
  // and so reported an empty order as having a Curaleaf-verified prescriber.
  const order = orderWith({ prescriptions: [] });
  assert.equal(placementRoute(order), 'manual');
  const rail = buildOrderStageRail(order);
  const prescriber = rail.pharmacyPlacement.find(entry => entry.key === 'prescriber');
  assert.notEqual(prescriber?.state, 'complete');
});

test('one manually typed prescription makes the whole placement manual', () => {
  const order = orderWith({
    prescriptions: [
      { ...unplacedPrescription, entryMode: 'clinic' },
      { ...unplacedPrescription, id: 202, entryMode: 'manual' },
    ],
  });
  assert.equal(placementRoute(order), 'manual');
});

test('a QR order does not ask the pharmacy to re-verify what the clinic already did', () => {
  const order = orderWith({ curaleafPlacement: { route: 'CLINIC_BARCODE' } as never });
  const rail = buildOrderStageRail(order);
  const prescriber = rail.pharmacyPlacement.find(entry => entry.key === 'prescriber');
  const prescription = rail.pharmacyPlacement.find(entry => entry.key === 'prescription');
  assert.equal(prescriber?.state, 'complete');
  assert.equal(prescription?.state, 'complete');
  assert.match(prescriber!.detail, /clinic scan/i);
});

test('a manual order shows the prescriber check as real outstanding work', () => {
  const order = orderWith({ curaleafPlacement: { route: 'MANUAL_PRESCRIPTION' } as never });
  const rail = buildOrderStageRail(order);
  const prescriber = rail.pharmacyPlacement.find(entry => entry.key === 'prescriber');
  assert.notEqual(prescriber?.state, 'complete');
});

test('a split order keeps pack counts off the rail except Collected', () => {
  // One pack collected; nine remain with Curaleaf. Progress lives on consignments.
  const rail = buildOrderStageRail(partialOrder);
  const dispensed = rail.curaleafPlacement!.find(entry => entry.key === 'dispensed');
  const ready = rail.curaleafPlacement!.find(entry => entry.key === 'ready');
  const collected = rail.curaleafPlacement!.find(entry => entry.key === 'collected');
  assert.ok(dispensed);
  assert.ok(ready);
  assert.ok(collected);
  assert.equal(dispensed!.state, 'partial');
  assert.equal(dispensed!.detail, 'Awaiting clinic allocation');
  assert.notEqual(ready!.state, 'complete');
  assert.doesNotMatch(ready!.detail, /\d+[/ ]\d+/);
  assert.doesNotMatch(ready!.detail, /^Patient notified$/);
  assert.equal(collected!.detail, '1/10 collected');
  for (const entry of rail.curaleafPlacement!) {
    if (entry.key === 'collected') continue;
    assert.doesNotMatch(entry.detail, /\d+\/\d+|\d+ of \d+/);
  }
});

test('when nothing is collected yet, Ready stays status-only', () => {
  const shipmentId = '796adea9-f2d9-43b2-ad5c-ccfc4184ee62';
  const partiallyReadyUpstreamComplete: PatientOrder = {
    ...partialOrder,
    prescriptions: [{
      ...tenPackPrescription,
      status: 'ready',
      shipmentStates: { [shipmentId]: 'ready_for_collection' },
      shipments: [{
        id: shipmentId,
        createdAt: '2026-08-17T08:50:45.621344Z',
        items: [{ productId: '9f2d6958-2d76-4338-9e5f-6fd383dfff36', packCount: 1 }],
      }],
      fulfilmentLines: [{
        ...tenPackPrescription.fulfilmentLines![0]!,
        allocated: 10,
        shipped: 10,
        received: 10,
        collected: 0,
        remaining: 0,
        backordered: false,
      }],
    }],
  };
  const rail = buildOrderStageRail(partiallyReadyUpstreamComplete).curaleafPlacement!;
  const ready = rail.find(entry => entry.key === 'ready');
  const collected = rail.find(entry => entry.key === 'collected');
  assert.equal(ready!.state, 'partial');
  assert.equal(ready!.detail, 'Awaiting goods-in');
  assert.equal(collected!.detail, 'Awaiting collection');
  for (const entry of rail) {
    assert.doesNotMatch(entry.detail, /\d+\/\d+|\d+ of \d+/);
  }
});

test('a fully ready order still reads as fully ready', () => {
  const shipmentId = '796adea9-f2d9-43b2-ad5c-ccfc4184ee62';
  const fullyReady: PatientOrder = {
    ...partialOrder,
    prescriptions: [{
      ...tenPackPrescription,
      status: 'ready',
      shipmentStates: { [shipmentId]: 'ready_for_collection' },
      shipments: [{
        id: shipmentId,
        createdAt: '2026-08-17T08:50:45.621344Z',
        items: [{ productId: '9f2d6958-2d76-4338-9e5f-6fd383dfff36', packCount: 10 }],
      }],
      fulfilmentLines: [{
        ...tenPackPrescription.fulfilmentLines![0]!,
        allocated: 10,
        shipped: 10,
        received: 10,
        collected: 0,
        remaining: 0,
        backordered: false,
      }],
    }],
  };
  const ready = buildOrderStageRail(fullyReady).curaleafPlacement!.find(entry => entry.key === 'ready');
  assert.equal(ready!.state, 'complete');
  assert.equal(ready!.detail, 'Patient notified');
});

test('an unplaced prescription card shows placement and no dispensing steps', () => {
  const clinic = { ...unplacedPrescription, entryMode: 'clinic' as const, clinicScanId: 'scan-1', status: 'awaiting-approval' as const };
  const order = orderWith({
    payment: { ...partialOrder.payment, status: 'paid' },
    prescriptions: [clinic],
  });
  const rail = buildPrescriptionStageRail(order, clinic);
  assert.deepEqual(rail.placement?.map(entry => entry.key), ['prescriber', 'prescription', 'purchase-order']);
  assert.equal(rail.dispensing, null);
  assert.equal(rail.route, 'clinic_barcode');
  assert.equal(rail.placement?.find(step => step.key === 'purchase-order')?.detail, 'Waiting for Curaleaf');
  assert.doesNotMatch(rail.placement?.map(step => step.detail).join(' ') ?? '', /All prescriptions|remaining prescriptions/i);
});

test('a placed prescription hides Pharmacy placement and shows fulfilment', () => {
  const rail = buildPrescriptionStageRail(partialOrder, tenPackPrescription);
  assert.equal(rail.placement, null);
  assert.ok(rail.dispensing);
});

test('HHH repair audit events appear in the order activity log', () => {
  const events = buildOrderTimelineEvents(orderWith({
    auditEvents: [{
      type: 'multi_rx_identity_repair',
      label: 'Record link repaired',
      detail: 'Prescription 1 restored; existing Curaleaf order unchanged; no duplicate order sent.',
      occurredAt: '2026-08-29T06:00:00.000Z',
      reference: '1DZ-816507F909-P1',
    }],
  }));
  const repaired = events.find(event => event.label === 'Record link repaired');
  assert.match(repaired?.detail ?? '', /Prescription 1 restored/);
  assert.match(repaired?.detail ?? '', /1DZ-816507F909-P1/);
});

test('a placed sibling shows dispensing while an unplaced sibling keeps its own placement rail', () => {
  const clinic = { ...unplacedPrescription, id: 201, entryMode: 'clinic' as const, clinicScanId: 'scan-1', status: 'awaiting-approval' as const };
  const manualPlaced = { ...tenPackPrescription, id: 202, entryMode: 'manual' as const };
  const order = orderWith({
    payment: { ...partialOrder.payment, status: 'paid' },
    prescriptions: [clinic, manualPlaced],
  });
  const pending = buildPrescriptionStageRail(order, clinic);
  const placed = buildPrescriptionStageRail(order, manualPlaced);
  assert.equal(pending.dispensing, null);
  assert.ok(pending.placement);
  assert.equal(pending.route, 'clinic_barcode');
  assert.notEqual(pending.placement?.find(step => step.key === 'purchase-order')?.state, 'complete', 'one placed sibling must not complete the unplaced prescription PO step');
  assert.equal(placed.placement, null, 'a placed prescription hides Pharmacy placement');
  assert.deepEqual(placed.dispensing?.map(entry => entry.key), ['ordered', 'dispensed', 'in-transit', 'checked-in', 'ready', 'collected']);
  assert.equal(placed.route, 'manual');
  const chrome = `${pending.placement?.map(step => `${step.label} ${step.detail}`).join(' ')} ${placed.dispensing?.map(step => `${step.label} ${step.detail}`).join(' ')}`;
  assert.doesNotMatch(chrome, /All prescriptions|remaining prescriptions|RX-|serial|file-2|S2|dispensar/i);
  assert.equal(placed.dispensing?.find(step => step.key === 'dispensed')?.label, 'Dispensed by Clinic');
  assert.equal(placed.dispensing?.find(step => step.key === 'checked-in')?.label, 'Arrived at Pharmacy');
});

test('zero allocation uses the agreed supplier wording', () => {
  const zeroAllocation = {
    ...tenPackPrescription,
    fulfilmentLines: tenPackPrescription.fulfilmentLines?.map(line => ({ ...line, allocated: 0, shipped: 0, received: 0, collected: 0 })),
  };
  const rail = buildPrescriptionStageRail(partialOrder, zeroAllocation);
  assert.equal(rail.dispensing?.find(step => step.key === 'dispensed')?.detail, 'Awaiting clinic allocation');
});
