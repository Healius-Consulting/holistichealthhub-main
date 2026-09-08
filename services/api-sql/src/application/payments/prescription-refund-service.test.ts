import assert from 'node:assert/strict';
import test from 'node:test';
import { HttpError } from '../../domain/common/errors.js';
import type { PaymentAllocationRecord, PaymentRepositoryPort, RefundRecord, ReservePrescriptionRefundInput } from '../../repositories/ports/payment.port.js';
import { refundedAllocationState } from './payment-allocation.js';
import {
  loadPrescriptionRefundContext, previewPrescriptionRefund, submitPrescriptionRefund, confirmPrescriptionRefund,
  type PrescriptionRefundDeps, type PrescriptionRefundScope,
} from './prescription-refund-service.js';
import { refundFixture } from './prescription-refund.fixture.js';

const SCOPE: PrescriptionRefundScope = { organisationId: 'org', uid: 'staff-1' };

/**
 * An in-memory ledger holding the same invariants the SQL mutations enforce: one
 * unresolved refund per payment, guarded by the payment version, and an allocation
 * that is consumed exactly once per refund.
 */
function ledger(overrides: { route?: 'MANUAL' | 'WORLDPAY' } = {}) {
  const fixture = refundFixture();
  const order = { ...fixture.order, organisationId: 'org' };
  const payment = { ...fixture.payment, route: overrides.route ?? 'MANUAL', transactionReference: 'txn-1' };
  const allocations: PaymentAllocationRecord[] = [{ ...fixture.allocations[0], organisationId: 'org', paymentId: 'payment' }];
  const refunds: RefundRecord[] = [];
  const calls = { reserve: 0, complete: 0, submit: 0, verification: [] as string[] };

  const paymentRepo = {
    listPaymentsByOrderId: async (orderId: string, organisationId: string) =>
      orderId === order.id && organisationId === SCOPE.organisationId ? [payment] : [],
    listRefundsByOrderId: async (orderId: string, organisationId: string) =>
      orderId === order.id && organisationId === SCOPE.organisationId ? refunds.map(row => ({ ...row })) : [],
    listPaymentAllocations: async () => allocations.map(row => ({ ...row })),
    findRefundByIdempotencyKey: async (key: string, organisationId: string) => {
      const found = refunds.find(row => row.idempotencyKey === key && row.organisationId === organisationId);
      return found ? { ...found } : null;
    },
    reservePrescriptionRefund: async (data: ReservePrescriptionRefundInput) => {
      calls.reserve += 1;
      if (payment.pendingRefundId || payment.version !== data.paymentVersion || order.version !== data.orderVersion) {
        throw new HttpError(409, 'The payment or prescription changed. Refresh the refund breakdown.', 'REFUND_PREVIEW_STALE');
      }
      payment.pendingRefundId = data.id;
      payment.version += 1;
      order.version += 1;
      const refund: RefundRecord = {
        id: data.id, organisationId: data.organisationId, orderId: data.orderId, paymentId: data.paymentId,
        prescriptionId: data.prescriptionId, breakdown: data.breakdown, amountPence: data.amountPence,
        currency: data.currency, cause: 'prescription_cancelled', route: data.route, status: 'PENDING_CONFIRMATION',
        idempotencyKey: data.idempotencyKey, confirmedByUid: data.confirmedByUid, createdAt: new Date().toISOString(),
      } as RefundRecord;
      refunds.push(refund);
      return { ...refund };
    },
    markRefundVerification: async (data: { id: string; status: string; externalReference?: string | null; verificationStatus: string; verificationPayload?: unknown }) => {
      const refund = refunds.find(row => row.id === data.id)!;
      calls.verification.push(data.verificationStatus);
      Object.assign(refund, { status: data.status, externalReference: data.externalReference, verificationStatus: data.verificationStatus, verificationPayload: data.verificationPayload });
    },
    completeRefundAndConsumeAllocation: async (data: { refundId: string; amountPence: number; externalReference: string; verificationStatus: string }) => {
      const refund = refunds.find(row => row.id === data.refundId)!;
      const active = allocations.find(row => row.status === 'ACTIVE');
      if (refund.status === 'COMPLETED') {
        if (refund.externalReference !== data.externalReference) throw new Error('Refund reference conflict.');
        return { ...(active ?? allocations[0]!) };
      }
      if (!active || payment.pendingRefundId !== refund.id) throw new Error('Refund reservation missing.');
      calls.complete += 1;
      const next = refundedAllocationState(Number(active.amountPence), data.amountPence);
      Object.assign(active, { amountPence: next.amountPence, status: next.status, version: Number(active.version) + 1 });
      Object.assign(refund, { status: 'COMPLETED', externalReference: data.externalReference, verificationStatus: data.verificationStatus });
      const completed = refunds.filter(row => row.status === 'COMPLETED').reduce((sum, row) => sum + Number(row.amountPence), 0);
      payment.pendingRefundId = null;
      payment.version += 1;
      payment.status = completed === Number(payment.amountPence) ? 'REFUNDED' : 'PAID';
      return { ...active };
    },
  } as unknown as PaymentRepositoryPort;

  const deps: PrescriptionRefundDeps = {
    orderRepo: { findOrderById: async (id: string, organisationId: string) => (id === order.id && organisationId === SCOPE.organisationId ? order : null) } as PrescriptionRefundDeps['orderRepo'],
    lineRepo: { listByOrderId: async () => fixture.lines } as PrescriptionRefundDeps['lineRepo'],
    paymentRepo,
    integrationRepo: { findConnection: async () => null } as unknown as PrescriptionRefundDeps['integrationRepo'],
    submitRefund: async () => { calls.submit += 1; return { reference: 'refund-ref', commandId: 'cmd-1' } as never; },
  };
  return { deps, order, payment, allocations, refunds, calls, fixture };
}

const requestBody = (previewVersion: string, patch: Record<string, unknown> = {}) => ({
  requestId: '11111111-1111-4111-8111-111111111111', previewVersion,
  medicines: [{ orderLineId: 'line1', quantity: 1 }], dispensingPercent: 0, deliveryPercent: 0, ...patch,
});

test('another tenant cannot read or refund the order', async () => {
  const { deps } = ledger();
  await assert.rejects(() => previewPrescriptionRefund(deps, { organisationId: 'other-org', uid: 'staff-2' }, 'order', 'rx1'), /Order not found/);
  await assert.rejects(() => loadPrescriptionRefundContext(deps, SCOPE, 'order', 'rx-unknown'), /Prescription not found/);
});

test('refunding £85 of a £150 payment leaves £65, and a later £5 dispensing share leaves £60', async () => {
  const { deps, payment, allocations, refunds } = ledger();
  const first = await previewPrescriptionRefund(deps, SCOPE, 'order', 'rx1');
  const { refund } = await submitPrescriptionRefund(deps, SCOPE, 'order', 'rx1', requestBody(first.previewVersion));
  assert.equal(Number(refund.amountPence), 8500);
  await confirmPrescriptionRefund(deps, SCOPE, 'order', 'rx1', refund.id, 'EPOS-1');
  assert.equal(Number(allocations[0]!.amountPence), 6500);
  assert.equal(payment.status, 'PAID', 'the sibling prescription keeps a live payment');
  assert.equal(payment.pendingRefundId, null);

  // Rx2 is cancelled next; its own refund draws on the remaining balance and shared fee.
  const order = (await deps.orderRepo.findOrderById('order', 'org'))!;
  (order.quoteSnapshot as any).curaleafSubOrders.rx2.purchaseOrderState = 'CANCELLED';
  const second = await previewPrescriptionRefund(deps, SCOPE, 'order', 'rx2');
  assert.equal(second.availablePence, 6500);
  assert.equal(second.completedPence, 8500);
  assert.equal(second.dispensing.remainingPence, 1000);
  const dispensingOnly = await submitPrescriptionRefund(deps, SCOPE, 'order', 'rx2', requestBody(second.previewVersion, {
    requestId: '22222222-2222-4222-8222-222222222222', medicines: [], dispensingPercent: 50,
  }));
  assert.equal(Number(dispensingOnly.refund.amountPence), 500);
  await confirmPrescriptionRefund(deps, SCOPE, 'order', 'rx2', dispensingOnly.refund.id, 'EPOS-2');
  assert.equal(Number(allocations[0]!.amountPence), 6000);
  assert.equal(refunds.length, 2, 'each prescription keeps its own refund record');
});

test('a repeated request id reuses the reserved refund instead of taking money twice', async () => {
  const { deps, calls } = ledger();
  const preview = await previewPrescriptionRefund(deps, SCOPE, 'order', 'rx1');
  const body = requestBody(preview.previewVersion);
  const first = await submitPrescriptionRefund(deps, SCOPE, 'order', 'rx1', body);
  const retry = await submitPrescriptionRefund(deps, SCOPE, 'order', 'rx1', body);
  assert.equal(retry.reused, true);
  assert.equal(retry.refund.id, first.refund.id);
  assert.equal(calls.reserve, 1);
  await assert.rejects(
    () => submitPrescriptionRefund(deps, SCOPE, 'order', 'rx1', { ...body, dispensingPercent: 25 }),
    (error: HttpError) => error.code === 'REFUND_REQUEST_CONFLICT',
  );
});

test('a second refund cannot open while one is unresolved', async () => {
  const { deps } = ledger();
  const preview = await previewPrescriptionRefund(deps, SCOPE, 'order', 'rx1');
  await submitPrescriptionRefund(deps, SCOPE, 'order', 'rx1', requestBody(preview.previewVersion));
  const refreshed = await previewPrescriptionRefund(deps, SCOPE, 'order', 'rx1');
  assert.ok(refreshed.pendingRefundId, 'the reservation is visible on the refreshed preview');
  assert.equal(refreshed.reservedPence, 8500);
  await assert.rejects(
    () => submitPrescriptionRefund(deps, SCOPE, 'order', 'rx1', requestBody(refreshed.previewVersion, { requestId: '33333333-3333-4333-8333-333333333333' })),
    (error: HttpError) => error.code === 'REFUND_ALREADY_OPEN',
  );
});

test('an uncertain Worldpay submission stays reserved and is never resubmitted as a new refund', async () => {
  const { deps, calls, payment } = ledger({ route: 'WORLDPAY' });
  deps.submitRefund = async () => { calls.submit += 1; throw new HttpError(503, 'Worldpay is unavailable.', 'WORLDPAY_TIMEOUT'); };
  const preview = await previewPrescriptionRefund(deps, SCOPE, 'order', 'rx1');
  const body = requestBody(preview.previewVersion);
  const { refund } = await submitPrescriptionRefund(deps, SCOPE, 'order', 'rx1', body);
  assert.equal(refund.status, 'VERIFICATION_PENDING');
  assert.equal(payment.pendingRefundId, refund.id);
  assert.deepEqual(calls.verification, ['worldpay_submission_outcome_unknown', 'worldpay_submission_outcome_unknown']);
  const retry = await submitPrescriptionRefund(deps, SCOPE, 'order', 'rx1', body);
  assert.equal(retry.refund.id, refund.id);
  assert.equal(calls.submit, 1, 'a retry does not send a second refund to the provider');
});

test('confirming twice reports the completed refund without consuming the allocation again', async () => {
  const { deps, calls, allocations } = ledger();
  const preview = await previewPrescriptionRefund(deps, SCOPE, 'order', 'rx1');
  const { refund } = await submitPrescriptionRefund(deps, SCOPE, 'order', 'rx1', requestBody(preview.previewVersion));
  await confirmPrescriptionRefund(deps, SCOPE, 'order', 'rx1', refund.id, 'EPOS-1');
  const again = await confirmPrescriptionRefund(deps, SCOPE, 'order', 'rx1', refund.id, 'EPOS-1');
  assert.equal(again.status, 'COMPLETED');
  assert.equal(calls.complete, 1);
  assert.equal(Number(allocations[0]!.amountPence), 6500);
  await assert.rejects(
    () => confirmPrescriptionRefund(deps, SCOPE, 'order', 'rx1', refund.id, 'EPOS-DIFFERENT'),
    (error: HttpError) => error.code === 'REFUND_REFERENCE_CONFLICT',
  );
  await assert.rejects(() => confirmPrescriptionRefund(deps, SCOPE, 'order', 'rx2', refund.id, 'EPOS-1'), /Refund not found/);
});

test('the active sibling keeps its medicines and payment throughout the refund', async () => {
  const { deps, fixture } = ledger();
  const preview = await previewPrescriptionRefund(deps, SCOPE, 'order', 'rx1');
  await submitPrescriptionRefund(deps, SCOPE, 'order', 'rx1', requestBody(preview.previewVersion));
  const context = await loadPrescriptionRefundContext(deps, SCOPE, 'order', 'rx2');
  assert.deepEqual(context.lines.map(line => line.id), fixture.lines.map((line: { id: string }) => line.id));
  assert.equal(context.payment.status, 'PAID');
  assert.equal(context.allocations.filter(row => row.status === 'ACTIVE').length, 1);
});
