import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { HttpError } from '../../domain/common/errors.js';
import {
  applyPharmacyHandout,
  normalisedFulfilmentLines,
} from '../../application/orders/curaleaf-fulfilment.js';
import {
  assertPatientEligibleForOrder,
  recordCollectedDispense,
  type PatientFinanceDeps,
} from '../../application/patient-finance/patient-finance.js';
import type { PatientFinanceRepositoryPort } from '../../repositories/ports/patient-finance.port.js';
import type { PatientRecord, PatientRepositoryPort } from '../../repositories/ports/patient.port.js';

const productId = '9f2d6958-2d76-4338-9e5f-6fd383dfff36';

const fullyReceivedPo = {
  id: '6e5e3d6e-5b14-4b8a-bb0e-d6d60ed6f69f',
  state: 'FULLY_ALLOCATED',
  customerReference: 'HHH-93eea688-3a39-4b1d-b998-e43cc16acf4b-c10dbf6885',
  items: [{
    productId,
    packsOrderedCount: 2,
    packsAllocatedCount: 2,
    packsReturnedCount: 0,
  }],
};

const fullyReceivedShipment = {
  id: 'f46d4159-f0dc-49fe-9189-4f0a59ea18e2',
  purchaseOrderId: fullyReceivedPo.id,
  items: [{ productId, packCount: 2, packsReturnedCount: 0 }],
};

function patient(overrides: Partial<PatientRecord> = {}): PatientRecord {
  return {
    id: 'patient-1',
    organisationId: 'org-1',
    sourceSubmissionId: null,
    firstName: 'Avery',
    surname: 'Testpatient',
    dob: '1988-04-12',
    email: 'avery@example.com',
    mobile: '07000000000',
    address: null,
    postcode: 'SW1A 1AA',
    status: 'ACTIVE',
    activatedAt: '2026-01-01T00:00:00.000Z',
    statusChangedAt: null,
    version: 1,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    conditions: [],
    sourceSubmission: null,
    ...overrides,
  };
}

type HandoutOrderRepo = {
  updateQuoteSnapshot: (input: Record<string, unknown>) => Promise<void>;
  updateOrderStatus: (input: Record<string, unknown>) => Promise<void>;
};

async function runPortalHandout(input: {
  orderId: string;
  organisationId: string;
  patientId: string;
  actorUid: string;
  quoteSnapshot: Record<string, unknown>;
  partial?: boolean;
  shipmentId?: string;
  patientFinanceDeps: PatientFinanceDeps;
  orderRepo: HandoutOrderRepo;
}) {
  const snapshot = input.quoteSnapshot;
  const curaleaf = snapshot.curaleaf && typeof snapshot.curaleaf === 'object'
    ? snapshot.curaleaf as Record<string, unknown>
    : {};
  const requestedItems = (snapshot.lineItems || snapshot.items || []) as Array<{ packId?: string; quantity?: number }>;
  const lines = normalisedFulfilmentLines({
    purchaseOrder: curaleaf as { items?: Array<{ productId: string; packsOrderedCount?: number }> },
    shipments: (curaleaf.shipments || []) as Array<{ id: string; items: Array<{ productId: string; packCount: number }> }>,
    requestedItems,
    priorLines: curaleaf.lines,
  });
  const result = applyPharmacyHandout({
    lines,
    shipmentStates: (curaleaf.shipmentStates || {}) as Record<string, string>,
    shipmentId: input.shipmentId,
    partial: input.partial === true,
  });
  if (!result.allowed) {
    throw new HttpError(409, 'Remaining packs are still open with Curaleaf. Use partial handover for arrived packs only.', 'REMAINDER_OPEN');
  }

  const collectedAt = '2026-08-18T12:00:00.000Z';
  const dispenseKey = input.shipmentId || (input.partial ? `partial-${collectedAt.slice(0, 10)}` : 'full');
  await recordCollectedDispense(input.patientFinanceDeps, {
    organisationId: input.organisationId,
    patientId: input.patientId,
    orderId: input.orderId,
    actorUid: input.actorUid,
    dispenseKey,
    collectedAt,
  });

  const nextStatus = result.remainingOpen ? 'PARTIALLY_RECEIVED' : 'COLLECTED';
  await input.orderRepo.updateQuoteSnapshot({
    id: input.orderId,
    organisationId: input.organisationId,
    quoteSnapshot: {
      ...snapshot,
      curaleaf: {
        ...curaleaf,
        lines: result.lines,
        shipmentStates: result.shipmentStates,
      },
    },
    fulfilmentStatus: nextStatus,
  });

  if (!result.remainingOpen) {
    await input.orderRepo.updateOrderStatus({
      id: input.orderId,
      organisationId: input.organisationId,
      status: 'COMPLETED',
      fulfilmentStatus: 'COLLECTED',
    });
  }

  return {
    status: result.remainingOpen ? 'partially_collected' : 'collected',
    collectedAt,
    dispenseKey,
  };
}

describe('portal order handout', () => {
  it('rejects inactive patients before order create', () => {
    assert.throws(
      () => assertPatientEligibleForOrder(patient({ status: 'INACTIVE' })),
      (error: unknown) => error instanceof HttpError && error.code === 'PATIENT_NOT_ELIGIBLE',
    );
  });

  it('records dispense and completes the order when all packs are collected', async () => {
    const dispenseCalls: Array<{ orderId: string; dispenseKey: string }> = [];
    const quoteUpdates: Array<{ fulfilmentStatus: string }> = [];
    const statusUpdates: Array<{ status: string; fulfilmentStatus: string }> = [];

    const patientRepo: PatientRepositoryPort = {
      listTenantPatients: async () => [],
      listPlatformPatients: async () => [],
      listActivePatients: async () => [],
      findPatientById: async () => patient(),
      updatePatientStatus: async () => undefined,
    };
    const patientFinanceRepo: PatientFinanceRepositoryPort = {
      findDispenseEvent: async () => null,
      listRecentDispenseEvents: async () => [],
      insertDispenseEvent: async data => { dispenseCalls.push({ orderId: data.orderId, dispenseKey: data.dispenseKey }); },
      hasNewReferralFee: async () => true,
      latestPaidAt: async () => null,
      insertReferralFeeEvent: async () => true,
    };
    const orderRepo: HandoutOrderRepo = {
      updateQuoteSnapshot: async data => { quoteUpdates.push({ fulfilmentStatus: String(data.fulfilmentStatus) }); },
      updateOrderStatus: async data => {
        statusUpdates.push({
          status: String(data.status),
          fulfilmentStatus: String(data.fulfilmentStatus),
        });
      },
    };

    const quoteSnapshot = {
      lineItems: [{ packId: productId, quantity: 2 }],
      curaleaf: {
        purchaseOrderId: fullyReceivedPo.id,
        shipments: [fullyReceivedShipment],
        lines: [{ productId, ordered: 2, received: 2, collected: 0, remaining: 0 }],
        shipmentStates: { [fullyReceivedShipment.id]: 'ready_for_collection' },
      },
    };

    const outcome = await runPortalHandout({
      orderId: 'order-1',
      organisationId: 'org-1',
      patientId: 'patient-1',
      actorUid: 'staff-1',
      quoteSnapshot,
      patientFinanceDeps: { patientRepo, patientFinanceRepo },
      orderRepo,
    });

    assert.equal(outcome.status, 'collected');
    assert.equal(outcome.dispenseKey, 'full');
    assert.deepEqual(dispenseCalls, [{ orderId: 'order-1', dispenseKey: 'full' }]);
    assert.deepEqual(quoteUpdates, [{ fulfilmentStatus: 'COLLECTED' }]);
    assert.deepEqual(statusUpdates, [{ status: 'COMPLETED', fulfilmentStatus: 'COLLECTED' }]);
  });

  it('records dispense but keeps the order open on partial handout', async () => {
    const statusUpdates: string[] = [];
    const patientRepo: PatientRepositoryPort = {
      listTenantPatients: async () => [],
      listPlatformPatients: async () => [],
      listActivePatients: async () => [],
      findPatientById: async () => patient(),
      updatePatientStatus: async () => undefined,
    };
    const patientFinanceRepo: PatientFinanceRepositoryPort = {
      findDispenseEvent: async () => null,
      listRecentDispenseEvents: async () => [],
      insertDispenseEvent: async () => undefined,
      hasNewReferralFee: async () => true,
      latestPaidAt: async () => null,
      insertReferralFeeEvent: async () => true,
    };
    const orderRepo: HandoutOrderRepo = {
      updateQuoteSnapshot: async () => undefined,
      updateOrderStatus: async () => { statusUpdates.push('completed'); },
    };

    const quoteSnapshot = {
      lineItems: [{ packId: productId, quantity: 4 }],
      curaleaf: {
        purchaseOrderId: '99f4bc42-4312-45c5-b659-21583b5eb364',
        shipments: [{
          id: 'b13179c4-9515-4181-abd8-d1b87b50faa4',
          purchaseOrderId: '99f4bc42-4312-45c5-b659-21583b5eb364',
          items: [{ productId, packCount: 2, packsReturnedCount: 0 }],
        }],
        lines: [{ productId, ordered: 4, received: 2, collected: 0, remaining: 2 }],
        shipmentStates: { 'b13179c4-9515-4181-abd8-d1b87b50faa4': 'ready_for_collection' },
      },
    };

    const outcome = await runPortalHandout({
      orderId: 'order-2',
      organisationId: 'org-1',
      patientId: 'patient-1',
      actorUid: 'staff-1',
      quoteSnapshot,
      shipmentId: 'b13179c4-9515-4181-abd8-d1b87b50faa4',
      partial: true,
      patientFinanceDeps: { patientRepo, patientFinanceRepo },
      orderRepo,
    });

    assert.equal(outcome.status, 'partially_collected');
    assert.equal(outcome.dispenseKey, 'b13179c4-9515-4181-abd8-d1b87b50faa4');
    assert.deepEqual(statusUpdates, []);
  });
});
