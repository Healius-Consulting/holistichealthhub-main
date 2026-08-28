import { Router, type Request, type Response, type NextFunction } from 'express';
import { z } from 'zod';
import { HttpError } from '../../domain/common/errors.js';
import { queryWorldpayPayment } from '../../application/integrations/worldpay.service.js';
import { verifyWorldpayRefund } from '../../application/payments/worldpay-query.js';
import { assertCuraleafSerialAvailableForCreate, executeCuraleafOrderPlacement, fetchCuraleafQuote } from '../../application/integrations/curaleaf.service.js';
import { curaleafOwnsCancellation, curaleafRequiresSupplierCancel, stampCuraleafCancellationOnSnapshot, supplierCancellationAlreadyConfirmed } from '../../application/integrations/curaleaf-events.js';
import {
  curaleafCancellationBlocksPlacement,
  evaluateQuoteReview,
  readQuoteReview,
  stampQuoteReviewOnSnapshot,
  supplierOrderCancelled,
} from '../../application/orders/quote-review.js';
import {
  assertPatientEligibleForOrder,
  promotePatientAfterCuraleafPlacement,
  recordCollectedDispense,
} from '../../application/patient-finance/patient-finance.js';
import {
  applyPharmacyHandout,
  normalisedFulfilmentLines,
} from '../../application/orders/curaleaf-fulfilment.js';
import { listPharmacyRecipients, pharmacyEmailContext, queueEmailToRecipients } from '../../application/notifications/email-outbox.js';
import { queueCollectionReadyEmail } from '../../application/notifications/collection-ready-email.js';
import { SqlIdentityRepository } from '../../repositories/sql/identity.sql.js';
import { SqlIntegrationRepository } from '../../repositories/sql/integration.sql.js';
import { SqlNotificationRepository } from '../../repositories/sql/notification.sql.js';
import { SqlOrganisationRepository } from '../../repositories/sql/organisation.sql.js';
import { SqlOrderRepository } from '../../repositories/sql/order.sql.js';
import { SqlOrderLineRepository } from '../../repositories/sql/order-line.sql.js';
import { SqlPatientFinanceRepository } from '../../repositories/sql/patient-finance.sql.js';
import { SqlPatientRepository } from '../../repositories/sql/patient.sql.js';
import { SqlPaymentRepository } from '../../repositories/sql/payment.sql.js';
import { purgeOrderPrescriptionFiles } from '../../application/prescriptions/prescription-file-purge.js';
import { persistCuraleafPrescriptionIdentity } from '../../application/prescriptions/curaleaf-prescription-record.js';
import type { OrderRecord } from '../../repositories/ports/order.port.js';
import { requireCsrf } from '../../security/csrf.js';
import { assertTenantScope } from '../../security/request-context.js';
import { requireStaff } from '../../security/require-staff.js';
import { toPortalOrder, toPortalOrderDraft } from './pharmacy-contracts.js';
import { requirePharmacyOperationalWrites } from './require-operational-writes.js';
import {
  loadOrderChildren,
  loadOrganisationOrderChildren,
  mapPortalOrderFromSql,
} from './order-sql-overlay.js';
import { stampPackFieldsOnSnapshot } from '../../application/orders/prescription-units.js';
import { CURRENT_PRICING_POLICY_VERSION, authoritativeQuoteLineItems, authoritativeQuotePricing, evaluateQuoteGate, quoteCheckInput } from '../../application/orders/quote-gate.js';
import { replacementAllocationAmount, replacementPrescriptionPolicy, replacementSupplierResolution } from '../../application/orders/replacement-resolution.js';
import { generateOrderNumber, pharmacyDeliveryChargeAllowed, pharmacyDeliveryPermitted } from '../../application/orders/order-policy.js';
import {
  completedManualRefund,
  orderAllowsManualCancellation,
  orderMoneyWasTaken,
  pendingManualRefund,
  snapshotRefundCompleted,
  stampUnpaidManualCancellation,
  withPendingPaidRefund,
} from '../../application/orders/paid-refund.js';
import {
  evaluateSerialOccupancy,
  manualSerialCreatePolicy,
  normalizeSerialNumber,
  prescriptionFileIsUsable,
} from '../../application/prescriptions/serial-reuse.js';
import { SqlPrescriptionRepository } from '../../repositories/sql/prescription.sql.js';
import { SqlPrescriptionSerialRepository } from '../../repositories/sql/serial-use.sql.js';

function serialPolicyConflict(policy: {
  allowed: boolean;
  reusesSourceSerial: boolean;
  reason?: string;
  occupyingOrderId?: string;
}) {
  if (policy.allowed) return null;
  if (policy.reason === 'SERIAL_IN_USE') {
    return new HttpError(409, 'This prescription serial is already on another live order.', 'SERIAL_IN_USE', {
      occupyingOrderId: policy.occupyingOrderId,
    });
  }
  if (policy.reason === 'SERIAL_REUSE_EXPIRED') {
    return new HttpError(409, 'This prescription serial is more than 24 days from its issue date and cannot be reused.', 'SERIAL_REUSE_EXPIRED');
  }
  if (policy.reason === 'SERIAL_BASKET_MISMATCH') {
    return new HttpError(409, 'A copied serial can only be used for the same prescribed medicines.', 'SERIAL_BASKET_MISMATCH');
  }
  if (policy.reason === 'SERIAL_REQUIRED') {
    return new HttpError(409, 'Enter the prescription serial exactly as printed.', 'SERIAL_REQUIRED');
  }
  return new HttpError(409, 'This replacement requires a new valid prescription copy.', 'REPLACEMENT_PRESCRIPTION_REQUIRED', { reason: policy.reason });
}

const uuidLikeSchema = z.string().regex(/^(?:[0-9a-f]{32}|[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})$/i);

function refundRecord(snapshot: unknown): Record<string, any> {
  const root = snapshot && typeof snapshot === 'object' && !Array.isArray(snapshot) ? snapshot as Record<string, unknown> : {};
  return root.refund && typeof root.refund === 'object' && !Array.isArray(root.refund) ? root.refund as Record<string, unknown> : {};
}

async function paymentForManualRefund(
  paymentRepo: SqlPaymentRepository,
  order: OrderRecord,
) {
  const existing = await paymentRepo.findPaymentByOrderId(order.id, order.organisationId);
  if (existing && ['PAID', 'REFUND_REQUIRED', 'REFUNDED'].includes(existing.status)) return existing;
  const created = await paymentRepo.createPayment({
    organisationId: order.organisationId,
    orderId: order.id,
    patientId: order.patientId,
    status: 'PAID',
    amountPence: Math.max(0, Number(order.totalPence || 0)),
    currency: order.currency || 'GBP',
    route: String(order.paymentRoute || '').toUpperCase() === 'WORLDPAY' ? 'WORLDPAY' : 'MANUAL',
    receiptHash: `refund-${order.id}`,
  });
  if (!created.id) throw new HttpError(503, 'A payment record could not be stored for this refund.', 'PAYMENT_RECORD_MISSING');
  return {
    id: created.id,
    organisationId: order.organisationId,
    orderId: order.id,
    patientId: order.patientId,
    status: 'PAID' as const,
    amountPence: Math.max(0, Number(order.totalPence || 0)),
    currency: order.currency || 'GBP',
    route: String(order.paymentRoute || '').toUpperCase() === 'WORLDPAY' ? 'WORLDPAY' as const : 'MANUAL' as const,
    receiptHash: `refund-${order.id}`,
    version: 1,
    createdAt: new Date().toISOString(),
  };
}

const pharmacyDeliveryPenceSchema = z.number().int().min(0).max(1500);
const draftPayloadSchema = z.record(z.string(), z.unknown()).superRefine((payload, context) => {
  if (payload.pharmacyDeliveryPence === undefined) return;
  const parsed = pharmacyDeliveryPenceSchema.safeParse(payload.pharmacyDeliveryPence);
  if (!parsed.success) {
    context.addIssue({
      code: 'custom',
      path: ['pharmacyDeliveryPence'],
      message: 'Pharmacy Delivery must be integer pence from £0 to £15.',
    });
  }
});

const draftInputSchema = z.object({
  organisationId: z.string().optional(),
  patientId: z.union([uuidLikeSchema, z.literal(''), z.null()]).optional(),
  payload: draftPayloadSchema.default({}),
});

const createOrderInputSchema = z.object({
  organisationId: z.string().optional(),
  patientId: uuidLikeSchema,
  draftId: z.union([uuidLikeSchema, z.literal(''), z.null()]).optional(),
  lineItems: z.array(z.object({
    productId: z.string().optional(),
    packId: z.string(),
    formulaId: z.string().optional(),
    name: z.string().optional(),
    quantity: z.number().int().positive(),
    packSize: z.number().int().positive().optional(),
    unitsNeededCount: z.number().int().positive().optional(),
    unitPricePence: z.number().int().nonnegative().optional(),
  })).default([]),
  prescriptions: z.array(z.object({
    id: z.string().optional(),
    fileId: z.string().optional(),
    clinicScanId: z.string().optional(),
    curaleafPrescriptionId: z.string().optional(),
    serialNumber: z.string().optional(),
    issueDate: z.string().optional(),
    expiryDate: z.string().optional(),
    patient: z.object({
      name: z.string(),
      dob: z.string(),
    }).optional(),
    prescriber: z.object({
      id: z.string().optional(),
      pin: z.string().optional(),
      gmcNumber: z.number().nullable().optional(),
      gphcNumber: z.string().nullable().optional(),
      name: z.string().optional(),
      initials: z.string().optional(),
    }).optional(),
    items: z.array(z.object({
      formulaId: z.string().optional(),
      unitsNeededCount: z.number().optional(),
      packId: z.string().optional(),
      quantity: z.number().int().positive().optional(),
    })).default([]),
  })).default([]),
  dispensingFeePence: z.number().int().nonnegative().default(0),
  pharmacyDeliveryPence: pharmacyDeliveryPenceSchema.default(0),
  medicineTotalPence: z.number().int().nonnegative().optional(),
  deliveryPence: z.number().int().nonnegative().optional(),
  taxPence: z.number().int().nonnegative().optional(),
  totalPence: z.number().int().positive().optional(),
  paymentRoute: z.enum(['manual', 'worldpay', 'MANUAL', 'WORLDPAY']).default('manual'),
  currency: z.string().default('GBP'),
  pricingQuote: z.record(z.string(), z.unknown()).optional(),
  quoteSnapshot: z.record(z.string(), z.unknown()).optional(),
  redoContext: z.object({
    originalOrderId: uuidLikeSchema,
    isPaidRedo: z.boolean(),
    requireCuraleafAuth: z.literal(true),
    priceResolution: z.enum(['absorb', 'refund_and_recharge']).optional(),
  }).nullable().optional(),
});

export function createPortalOrderRouter(): Router {
  const router = Router();
  const orderRepo = new SqlOrderRepository();
  const orderLineRepo = new SqlOrderLineRepository();
  const paymentRepo = new SqlPaymentRepository();
  const integrationRepo = new SqlIntegrationRepository();
  const identityRepo = new SqlIdentityRepository();
  const notificationRepo = new SqlNotificationRepository();
  const organisationRepo = new SqlOrganisationRepository();
  const patientRepo = new SqlPatientRepository();
  const patientFinanceRepo = new SqlPatientFinanceRepository();
  const prescriptionRepo = new SqlPrescriptionRepository();
  const serialRepo = new SqlPrescriptionSerialRepository();
  const patientFinanceDeps = { patientRepo, patientFinanceRepo };

  // GET /v1/portal/order-drafts - List active tenant drafts
  router.get('/portal/order-drafts', requireStaff('pharmacy'), async (req: Request, res: Response, next: NextFunction) => {
    try {
      const scope = assertTenantScope(req.context!);
      const drafts = await orderRepo.listTenantDrafts(scope.organisationId);
      res.status(200).json(drafts.map(toPortalOrderDraft));
    } catch (error) {
      next(error);
    }
  });

  // POST /v1/portal/order-drafts - Create or save order draft
  router.post('/portal/order-drafts', requireCsrf, requireStaff('pharmacy'), requirePharmacyOperationalWrites, async (req: Request, res: Response, next: NextFunction) => {
    try {
      const scope = assertTenantScope(req.context!);
      const input = draftInputSchema.parse(req.body);
      const organisation = await organisationRepo.findOrganisationById(scope.organisationId);
      if (!organisation) throw new HttpError(404, 'Pharmacy record not found.', 'NOT_FOUND');
      const pharmacyDeliveryPence = Number(input.payload.pharmacyDeliveryPence ?? 0);
      if (!pharmacyDeliveryChargeAllowed(pharmacyDeliveryPence, organisation.pharmacyDeliveryEnabled)) {
        throw new HttpError(409, 'Pharmacy Delivery is not enabled for new drafts.', 'PHARMACY_DELIVERY_NOT_ALLOWED');
      }

      if (input.patientId) {
        const patient = await patientRepo.findPatientById(scope.organisationId, input.patientId);
        assertPatientEligibleForOrder(patient);
      }

      const result = await orderRepo.createDraft({
        organisationId: scope.organisationId,
        patientId: input.patientId || null,
        payload: input.payload,
        pharmacyDeliveryEnabledAtCreation: organisation.pharmacyDeliveryEnabled,
        createdByUid: scope.uid,
      });

      res.status(201).json({ id: result.id, status: 'draft_created' });
    } catch (error) {
      next(error);
    }
  });

  // GET /v1/portal/order-drafts/:id - Get order draft
  router.get('/portal/order-drafts/:id', requireStaff('pharmacy'), async (req: Request, res: Response, next: NextFunction) => {
    try {
      const scope = assertTenantScope(req.context!);
      const draftId = String(req.params.id || '');
      const draft = await orderRepo.findDraftById(draftId, scope.organisationId);

      if (!draft) {
        throw new HttpError(404, 'Order draft not found.', 'NOT_FOUND');
      }

      res.status(200).json(toPortalOrderDraft(draft));
    } catch (error) {
      next(error);
    }
  });

  // PATCH /v1/portal/order-drafts/:id - Update existing order draft
  router.patch('/portal/order-drafts/:id', requireCsrf, requireStaff('pharmacy'), requirePharmacyOperationalWrites, async (req: Request, res: Response, next: NextFunction) => {
    try {
      const scope = assertTenantScope(req.context!);
      const draftId = String(req.params.id || '');
      const input = draftInputSchema.parse(req.body);
      const draft = await orderRepo.findDraftById(draftId, scope.organisationId);
      if (!draft) throw new HttpError(404, 'Order draft not found.', 'NOT_FOUND');
      const pharmacyDeliveryPence = Number(input.payload.pharmacyDeliveryPence ?? 0);
      if (!pharmacyDeliveryChargeAllowed(pharmacyDeliveryPence, draft.pharmacyDeliveryEnabledAtCreation)) {
        throw new HttpError(409, 'Pharmacy Delivery was not enabled when this draft was created.', 'PHARMACY_DELIVERY_NOT_ALLOWED');
      }

      const updated = await orderRepo.updateDraft({
        id: draftId,
        organisationId: scope.organisationId,
        patientId: input.patientId || null,
        payload: input.payload,
      });

      if (!updated) {
        throw new HttpError(404, 'Order draft not found.', 'NOT_FOUND');
      }

      res.status(200).json({ id: draftId, status: 'draft_updated' });
    } catch (error) {
      next(error);
    }
  });

  // DELETE /v1/portal/order-drafts/:id - Delete order draft
  router.delete('/portal/order-drafts/:id', requireCsrf, requireStaff('pharmacy'), requirePharmacyOperationalWrites, async (req: Request, res: Response, next: NextFunction) => {
    try {
      const scope = assertTenantScope(req.context!);
      const draftId = String(req.params.id || '');
      const deleted = await orderRepo.deleteDraft(draftId, scope.organisationId);

      if (!deleted) {
        throw new HttpError(404, 'Order draft not found.', 'NOT_FOUND');
      }

      res.status(204).end();
    } catch (error) {
      next(error);
    }
  });

  // POST /v1/portal/orders - Promote draft or submit order
  router.post('/portal/orders', requireCsrf, requireStaff('pharmacy'), requirePharmacyOperationalWrites, async (req: Request, res: Response, next: NextFunction) => {
    try {
      const scope = assertTenantScope(req.context!);
      const input = createOrderInputSchema.parse(req.body);
      const organisation = await organisationRepo.findOrganisationById(scope.organisationId);
      if (!organisation) throw new HttpError(404, 'Pharmacy record not found.', 'NOT_FOUND');
      const sourceDraft = input.draftId
        ? await orderRepo.findDraftById(input.draftId, scope.organisationId)
        : null;
      if (input.draftId && !sourceDraft) throw new HttpError(404, 'Order draft not found.', 'NOT_FOUND');
      const pharmacyDeliveryAllowed = pharmacyDeliveryPermitted({
        draftEnabledAtCreation: sourceDraft?.pharmacyDeliveryEnabledAtCreation,
        organisationEnabled: organisation.pharmacyDeliveryEnabled,
      });
      const pharmacyDeliveryPence = input.pharmacyDeliveryPence ?? 0;
      if (!pharmacyDeliveryChargeAllowed(pharmacyDeliveryPence, pharmacyDeliveryAllowed)) {
        throw new HttpError(409, 'Pharmacy Delivery was not enabled when this order was started.', 'PHARMACY_DELIVERY_NOT_ALLOWED');
      }

      const patient = await patientRepo.findPatientById(scope.organisationId, input.patientId);
      assertPatientEligibleForOrder(patient);

      let medicineTotalPence = 0;
      const dispensingFeePence = input.dispensingFeePence ?? 0;
      let deliveryPence = 0;
      let taxPence = 0;
      let totalPence = 0;
      let authoritativeRawQuote: unknown = null;
      let liveQuoteEvaluation: ReturnType<typeof evaluateQuoteGate> | null = null;
      const redoContext = input.redoContext;
      if (redoContext?.priceResolution === 'refund_and_recharge') {
        throw new HttpError(409, 'Cancel the source order and use paid-order resolution instead of creating a new payment link.', 'REDO_REFUND_RECHARGE_REMOVED');
      }
      let paymentRoute = input.paymentRoute.toUpperCase() === 'WORLDPAY' ? 'WORLDPAY' as const : 'MANUAL' as const;
      let replacement: null | {
        source: OrderRecord;
        payment: Awaited<ReturnType<SqlPaymentRepository['findPaymentByOrderId']>> & {};
        activeAllocationId: string | null;
        activeAllocationPence: number;
        transferPence: number;
        rawQuote: unknown;
        pharmacyAdjustmentPence: number;
        reusesSourceSerial: boolean;
      } = null;

      if (redoContext?.isPaidRedo) {
        const source = await orderRepo.findOrderById(redoContext.originalOrderId, scope.organisationId);
        if (!source || source.patientId !== input.patientId) {
          throw new HttpError(409, 'The paid source order could not be matched to this patient and pharmacy.', 'REPLACEMENT_SOURCE_MISMATCH');
        }
        if (source.archivedAt || String(source.resolutionStatus || '').toUpperCase() === 'RESOLVED') {
          throw new HttpError(409, 'This source order has already been resolved.', 'REPLACEMENT_SOURCE_RESOLVED');
        }
        if (!orderMoneyWasTaken(source) || snapshotRefundCompleted(source.quoteSnapshot)) {
          throw new HttpError(409, 'The source order has no transferable settled payment.', 'REPLACEMENT_PAYMENT_UNAVAILABLE');
        }
        const sourceRefunds = await paymentRepo.listRefundsByOrderId(source.id, scope.organisationId);
        if (sourceRefunds.some(row => !['FAILED', 'CANCELLED'].includes(String(row.status).toUpperCase()))) {
          throw new HttpError(409, 'A refund is already open for the source payment.', 'REPLACEMENT_REFUND_CONFLICT');
        }
        const payment = await paymentRepo.findPaymentByOrderId(source.id, scope.organisationId);
        if (!payment || !['PAID', 'REFUND_REQUIRED'].includes(payment.status)) {
          throw new HttpError(409, 'The settled source payment could not be verified.', 'REPLACEMENT_PAYMENT_UNAVAILABLE');
        }

        const sourceSnapshot = source.quoteSnapshot && typeof source.quoteSnapshot === 'object'
          ? source.quoteSnapshot as Record<string, any>
          : {};
        const sourceCuraleaf = sourceSnapshot.curaleaf && typeof sourceSnapshot.curaleaf === 'object'
          ? sourceSnapshot.curaleaf as Record<string, any>
          : {};
        const sourceLines = await orderLineRepo.listByOrderId(source.id);
        const sourcePrescriptions = Array.isArray(sourceSnapshot.prescriptions) ? sourceSnapshot.prescriptions : [];
        const sourcePrescription = sourcePrescriptions[0] && typeof sourcePrescriptions[0] === 'object'
          ? sourcePrescriptions[0] as Record<string, any>
          : {};
        const sourceRxItems = Array.isArray(sourcePrescription.items) ? sourcePrescription.items as Array<Record<string, unknown>> : [];
        const replacementRx = (input.prescriptions[0] ?? {}) as {
          serialNumber?: string;
          fileId?: string;
          issueDate?: string;
          items?: Array<{ packId?: string; formulaId?: string; quantity?: number; unitsNeededCount?: number }>;
        };
        const replacementSerial = normalizeSerialNumber(replacementRx.serialNumber);
        const liveSerial = replacementSerial ? await serialRepo.findLive(scope.organisationId, replacementSerial) : null;
        const replacementFile = replacementRx.fileId
          ? await prescriptionRepo.findFileById(String(replacementRx.fileId), scope.organisationId)
          : null;
        const prescriptionPolicy = replacementPrescriptionPolicy({
          sourceSerial: String(sourcePrescription.serialNumber || ''),
          sourceIssueDate: String(sourcePrescription.issueDate || ''),
          sourceOrderId: source.id,
          sourcePatientId: source.patientId,
          liveOrderId: liveSerial?.orderId,
          livePatientId: liveSerial?.patientId,
          currentPatientId: input.patientId,
          replacementSerial,
          replacementIssueDate: replacementRx.issueDate,
          replacementHasUsableFile: prescriptionFileIsUsable(replacementFile),
          sourceLines: (sourceRxItems.length ? sourceRxItems : sourceLines).map(line => ({
            packId: String((line as { packId?: string }).packId || ''),
            formulaId: String((line as { formulaId?: string }).formulaId || ''),
            quantity: Number((line as { quantity?: number }).quantity || 0),
            unitsNeededCount: Number((line as { unitsNeededCount?: number }).unitsNeededCount || 0),
          })),
          replacementLines: (replacementRx.items?.length ? replacementRx.items : input.lineItems).map(line => ({
            packId: String((line as { packId?: string }).packId || ''),
            formulaId: String((line as { formulaId?: string }).formulaId || ''),
            quantity: Number((line as { quantity?: number }).quantity || 0),
            unitsNeededCount: Number((line as { unitsNeededCount?: number }).unitsNeededCount || 0),
          })),
        });
        if (!prescriptionPolicy.allowed) {
          throw serialPolicyConflict(prescriptionPolicy);
        }
        const hasPurchaseOrder = Boolean(sourceCuraleaf.purchaseOrderId || sourceCuraleaf.purchaseOrderState || sourceCuraleaf.shipments?.length);
        const fulfilmentLines = Array.isArray(sourceCuraleaf.lines) ? sourceCuraleaf.lines : [];
        const supplierResolution = replacementSupplierResolution({
          hasPurchaseOrder,
          cancellationConfirmed: supplierOrderCancelled(source.quoteSnapshot)
            || supplierCancellationAlreadyConfirmed(source.quoteSnapshot),
          fulfilmentLines,
        });
        if (!supplierResolution.resolved) {
          throw new HttpError(409, 'Resolve every shipped and cancelled source line with Curaleaf before committing its replacement.', 'CURALEAF_CANCEL_REQUIRED', { reason: supplierResolution.reason });
        }

        const allocations = await paymentRepo.listPaymentAllocations(payment.id, scope.organisationId);
        if (allocations.some(row => row.sourceOrderId === source.id && !['REFUNDED', 'RELEASED'].includes(row.status))) {
          throw new HttpError(409, 'A paid replacement has already been committed for this source order.', 'REPLACEMENT_ALREADY_COMMITTED');
        }
        const activeAllocation = allocations.find(row => row.orderId === source.id && row.status === 'ACTIVE') ?? null;
        const activeAllocationPence = Number(activeAllocation?.amountPence ?? payment.amountPence);
        let transferPence: number;
        try {
          transferPence = replacementAllocationAmount({
            activeAllocationPence,
            hasPurchaseOrder,
            sourceLines,
            fulfilmentLines,
          });
        } catch (error) {
          throw new HttpError(409, error instanceof Error ? error.message : 'The replacement value requires reconciliation.', 'REPLACEMENT_ALLOCATION_RECONCILIATION');
        }

        const connection = await integrationRepo.findConnection(scope.organisationId, 'CURALEAF').catch(() => null);
        if (!connection?.secretResourceName) throw new HttpError(409, 'A live Curaleaf quote is required for this replacement.', 'QUOTE_UNAVAILABLE');
        const basket = input.lineItems.map(line => ({ packId: line.packId, quantity: line.quantity }));
        const rawQuote = await fetchCuraleafQuote(connection, basket);
        const evaluated = evaluateQuoteGate({ rawQuote, basket, dispensingFeePence, pharmacyDeliveryPence });
        if (evaluated.status === 'OUT_OF_STOCK') throw new HttpError(409, 'The replacement contains an out-of-stock item. Recheck later or refund the unresolved value.', 'QUOTE_OUT_OF_STOCK');
        if (evaluated.status !== 'MATCHED') throw new HttpError(409, 'The replacement quote requires reconciliation.', 'QUOTE_RECONCILIATION_REQUIRED');
        authoritativeRawQuote = rawQuote;
        liveQuoteEvaluation = evaluated;
        ({ medicineTotalPence, deliveryPence, taxPence, totalPence } = authoritativeQuotePricing(evaluated));
        const pharmacyAdjustmentPence = totalPence - transferPence;
        if (pharmacyAdjustmentPence !== 0 && redoContext.priceResolution !== 'absorb') {
          throw new HttpError(409, 'Record that the pharmacy will absorb the replacement difference before committing.', 'REPLACEMENT_ABSORB_REQUIRED', { pharmacyAdjustmentPence });
        }
        paymentRoute = payment.route;
        replacement = {
          source,
          payment,
          activeAllocationId: activeAllocation?.id ?? null,
          activeAllocationPence,
          transferPence,
          rawQuote,
          pharmacyAdjustmentPence,
          reusesSourceSerial: prescriptionPolicy.reusesSourceSerial,
        };
      }

      if (!liveQuoteEvaluation) {
        const connection = await integrationRepo.findConnection(scope.organisationId, 'CURALEAF').catch(() => null);
        if (!connection?.secretResourceName) throw new HttpError(409, 'A live Curaleaf quote is required before creating this order.', 'QUOTE_UNAVAILABLE');
        const basket = input.lineItems.map(line => ({ packId: line.packId, quantity: line.quantity }));
        authoritativeRawQuote = await fetchCuraleafQuote(connection, basket);
        liveQuoteEvaluation = evaluateQuoteGate({ rawQuote: authoritativeRawQuote, basket, dispensingFeePence, pharmacyDeliveryPence });
        if (liveQuoteEvaluation.status === 'OUT_OF_STOCK') {
          throw new HttpError(409, 'The order contains an out-of-stock item. Recheck the quote before payment.', 'QUOTE_OUT_OF_STOCK');
        }
        if (liveQuoteEvaluation.status !== 'MATCHED') {
          throw new HttpError(409, 'The live supplier quote does not exactly match this order basket.', 'QUOTE_RECONCILIATION_REQUIRED');
        }
        ({ medicineTotalPence, deliveryPence, taxPence, totalPence } = authoritativeQuotePricing(liveQuoteEvaluation));
      }
      const orderNumber = generateOrderNumber();

      const authoritativeLineItems = authoritativeQuoteLineItems(input.lineItems, liveQuoteEvaluation);

      let quoteSnapshot = stampPackFieldsOnSnapshot({
        ...(input.quoteSnapshot ?? {}),
        prescriptions: input.prescriptions,
        lineItems: authoritativeLineItems,
        pricingQuote: authoritativeRawQuote,
        quote: authoritativeRawQuote,
        medicineTotalPence,
        dispensingFeePence,
        pharmacyDeliveryPence,
        deliveryPence,
        taxPence,
        totalPence,
        pricingPolicyVersion: CURRENT_PRICING_POLICY_VERSION,
      }, authoritativeLineItems);
      if (replacement) {
        quoteSnapshot = {
          ...(quoteSnapshot && typeof quoteSnapshot === 'object' ? quoteSnapshot as Record<string, unknown> : {}),
          pricingQuote: replacement.rawQuote,
          quote: replacement.rawQuote,
          pharmacyContributionPence: replacement.pharmacyAdjustmentPence,
          redoContext: {
            originalOrderId: replacement.source.id,
            isPaidRedo: true,
            requireCuraleafAuth: true,
            priceResolution: replacement.pharmacyAdjustmentPence === 0 ? 'matched' : 'absorb',
            reusesSourceSerial: replacement.reusesSourceSerial,
          },
        };
      }

      const serialConnection = await integrationRepo.findConnection(scope.organisationId, 'CURALEAF').catch(() => null);
      for (const rx of input.prescriptions) {
        if (rx.clinicScanId || rx.curaleafPrescriptionId) continue;
        const submittedSerial = normalizeSerialNumber(rx.serialNumber);
        const liveSerial = submittedSerial
          ? await serialRepo.findLive(scope.organisationId, submittedSerial)
          : null;
        const occupancy = evaluateSerialOccupancy({
          liveOrderId: liveSerial?.orderId,
          livePatientId: liveSerial?.patientId,
          sourceOrderId: replacement?.source.id ?? redoContext?.originalOrderId,
          currentPatientId: input.patientId,
        });
        const conflict = serialPolicyConflict({
          ...manualSerialCreatePolicy({
            serialNumber: rx.serialNumber,
            issueDate: rx.issueDate,
            occupancy,
          }),
          reusesSourceSerial: false,
        });
        if (conflict) throw conflict;
        if (submittedSerial && serialConnection?.secretResourceName) {
          await assertCuraleafSerialAvailableForCreate(serialConnection, submittedSerial);
        }
      }

      const result = await orderRepo.createOrder({
        organisationId: scope.organisationId,
        patientId: input.patientId,
        draftId: input.draftId || null,
        orderNumber,
        status: 'SUBMITTED',
        paymentStatus: 'PENDING',
        fulfilmentStatus: 'SUPPLIER_PENDING',
        paymentRoute,
        currency: input.currency,
        medicineTotalPence,
        dispensingFeePence,
        pharmacyDeliveryPence,
        deliveryPence,
        taxPence,
        totalPence: totalPence > 0 ? totalPence : 1,
        quoteSnapshot,
        createdByUid: scope.uid,
      });

      if (result.id) {
        await orderLineRepo.replaceOrderLines(result.id, authoritativeLineItems.map(item => {
          return {
            orderId: result.id as string,
            packId: item.packId,
            formulaId: item.formulaId ?? null,
            formulaName: item.name ?? null,
            quantity: item.quantity,
            fixedPatientPricePence: item.unitPricePence,
            wholesalePackPricePence: item.wholesalePackPricePence,
            lineMedicineRevenuePence: item.unitPricePence * item.quantity,
          };
        }));

        const createdSerial = normalizeSerialNumber(input.prescriptions[0]?.serialNumber);
        const createdIssueDate = String(input.prescriptions[0]?.issueDate || '').slice(0, 10);
        if (createdSerial && createdIssueDate) {
          try {
            await serialRepo.claim({
              organisationId: scope.organisationId,
              serialNumber: createdSerial,
              issueDate: createdIssueDate,
              patientId: input.patientId,
              orderId: result.id,
              sourceOrderId: replacement?.source.id ?? redoContext?.originalOrderId ?? null,
            });
          } catch (error) {
            if (error instanceof Error && error.message === 'SERIAL_IN_USE') {
              throw new HttpError(409, 'This prescription serial is already on another live order.', 'SERIAL_IN_USE', {
                occupyingOrderId: (error as { occupyingOrderId?: string }).occupyingOrderId,
              });
            }
            throw error;
          }
        }

        if (replacement) {
          const basket = input.lineItems.map(line => ({ packId: line.packId, quantity: line.quantity }));
          try {
            const quoteCheck = await paymentRepo.createQuoteCheck({
              ...quoteCheckInput({
                organisationId: scope.organisationId,
                orderId: result.id,
                paymentId: replacement.payment.id,
                phase: 'REPLACEMENT',
                basket,
                rawQuote: replacement.rawQuote,
                dispensingFeePence,
                pharmacyDeliveryPence,
              }),
              status: replacement.pharmacyAdjustmentPence === 0 ? 'MATCHED' : 'ABSORBED',
              comparison: {
                reason: replacement.pharmacyAdjustmentPence === 0 ? 'replacement_matches_allocation' : 'replacement_absorbed',
                signedAdjustmentPence: replacement.pharmacyAdjustmentPence,
                sourceOrderId: replacement.source.id,
              },
              decidedByUid: scope.uid,
            });
            let sourceAllocationId = replacement.activeAllocationId;
            if (!sourceAllocationId) {
              const sourceAllocation = await paymentRepo.createPaymentAllocation({
                organisationId: scope.organisationId,
                paymentId: replacement.payment.id,
                orderId: replacement.source.id,
                amountPence: replacement.activeAllocationPence,
              });
              sourceAllocationId = sourceAllocation.id;
            }
            const moved = await paymentRepo.transferPaymentAllocation({
              allocationId: sourceAllocationId,
              organisationId: scope.organisationId,
              fromOrderId: replacement.source.id,
              toOrderId: result.id,
              amountPence: replacement.transferPence,
            });
            await orderRepo.updateQuoteSnapshot({
              id: result.id,
              organisationId: scope.organisationId,
              quoteSnapshot: {
                ...(quoteSnapshot as Record<string, unknown>),
                quoteChecks: [{
                  id: quoteCheck.id,
                  phase: quoteCheck.phase,
                  status: quoteCheck.status,
                  checkedAt: quoteCheck.createdAt,
                  basketFingerprint: quoteCheck.basketFingerprint,
                  baselineQuoteCheckId: quoteCheck.baselineQuoteCheckId,
                  patientTotalPence: Number(quoteCheck.patientTotalPence),
                  wholesaleTotalPence: Number(quoteCheck.wholesaleTotalPence),
                  shippingPence: Number(quoteCheck.shippingPence),
                  comparison: quoteCheck.comparison,
                }],
                paymentAllocation: {
                  id: moved.id,
                  paymentId: moved.paymentId,
                  sourceOrderId: replacement.source.id,
                  replacementOrderId: result.id,
                  amountPence: replacement.transferPence,
                  status: moved.status,
                  updatedAt: moved.updatedAt,
                },
              },
              fulfilmentStatus: 'SUPPLIER_PENDING',
            });
            await orderRepo.linkReplacementResolution({
              sourceOrderId: replacement.source.id,
              replacementOrderId: result.id,
              organisationId: scope.organisationId,
            });
            await orderRepo.appendPlacementEvent({
              organisationId: scope.organisationId,
              orderId: result.id,
              toState: 'PENDING_PLACEMENT',
              reason: 'Paid allocation committed to replacement; new prescription authentication remains required.',
              externalReference: replacement.source.orderNumber || replacement.source.id,
              actorUid: scope.uid,
            });
          } catch (error) {
            await orderRepo.updateQuoteSnapshot({
              id: result.id,
              organisationId: scope.organisationId,
              quoteSnapshot: {
                ...(quoteSnapshot as Record<string, unknown>),
                resolution: {
                  status: 'RECONCILIATION_REQUIRED',
                  reason: 'replacement_commit_incomplete',
                },
              },
              fulfilmentStatus: 'EXCEPTION',
            }).catch(() => undefined);
            throw new HttpError(409, 'The replacement was saved but its paid allocation could not be committed. The source order remains unarchived for reconciliation.', 'REPLACEMENT_COMMIT_RECONCILIATION', {
              replacementOrderId: result.id,
              cause: error instanceof Error ? error.message : 'Unknown allocation error',
            });
          }
        }
      }

      if (input.draftId) {
        await orderRepo.deleteDraft(input.draftId, scope.organisationId).catch(() => undefined);
      }

      const pharmacyRecipients = await listPharmacyRecipients(scope.organisationId, { identityRepo, organisationRepo });
      await queueEmailToRecipients(
        notificationRepo,
        pharmacyRecipients,
        'pharmacy_order_accepted',
        {
          orderNumber,
          amountPence: totalPence,
          currency: input.currency,
        },
        ['pharmacy-order-accepted', result.id, orderNumber],
        { organisationId: scope.organisationId, patientId: input.patientId, orderId: result.id },
      );

      res.status(201).json({
        id: result.id,
        orderNumber,
        status: replacement ? 'replacement_committed' : 'order_submitted',
        ...(replacement ? {
          paymentAllocation: {
            sourceOrderId: replacement.source.id,
            amountPence: replacement.transferPence,
          },
        } : {}),
      });
    } catch (error) {
      next(error);
    }
  });

  // GET /v1/portal/orders - List tenant orders
  router.get('/portal/orders', requireStaff('pharmacy'), async (req: Request, res: Response, next: NextFunction) => {
    try {
      const scope = assertTenantScope(req.context!);
      const orders = await orderRepo.listTenantOrders(scope.organisationId);
      const children = await loadOrganisationOrderChildren(scope.organisationId, paymentRepo, orderLineRepo);
      res.status(200).json(orders.map(order => mapPortalOrderFromSql(order, {
        refunds: children.refundsByOrder.get(order.id) ?? [],
        lines: children.linesByOrder.get(order.id) ?? [],
        quoteChecks: children.quoteChecksByOrder.get(order.id) ?? [],
        paymentAllocations: children.paymentAllocationsByOrder.get(order.id) ?? [],
      })));
    } catch (error) {
      next(error);
    }
  });

  // GET /v1/portal/orders/:id - Get tenant order details
  router.get('/portal/orders/:id', requireStaff('pharmacy'), async (req: Request, res: Response, next: NextFunction) => {
    try {
      const scope = assertTenantScope(req.context!);
      const orderId = String(req.params.id || '');
      const order = await orderRepo.findOrderById(orderId, scope.organisationId);

      if (!order) {
        throw new HttpError(404, 'Order not found.', 'NOT_FOUND');
      }

      const overlay = await loadOrderChildren(order, paymentRepo, orderLineRepo);
      res.status(200).json(mapPortalOrderFromSql(order, overlay));
    } catch (error) {
      next(error);
    }
  });

  // POST /v1/portal/orders/:id/prescriptions/:prescriptionId/place - Place prescription manually
  router.post('/portal/orders/:id/prescriptions/:prescriptionId/place', requireCsrf, requireStaff('pharmacy'), requirePharmacyOperationalWrites, async (req: Request, res: Response, next: NextFunction) => {
    try {
      const scope = assertTenantScope(req.context!);
      const orderId = String(req.params.id || '');
      const prescriptionId = String(req.params.prescriptionId || '');

      const order = await orderRepo.findOrderById(orderId, scope.organisationId);
      if (!order) {
        throw new HttpError(404, 'Order not found.', 'NOT_FOUND');
      }

      if (order.paymentStatus !== 'PAID' && !order.paidAt) {
        throw new HttpError(409, 'Order must be paid before placing with Curaleaf.', 'ORDER_NOT_PAID');
      }
      if (curaleafCancellationBlocksPlacement(order.quoteSnapshot)) {
        throw new HttpError(409, 'This Curaleaf order was cancelled.', 'CURALEAF_ORDER_CANCELLED');
      }

      await orderRepo.updateOrderStatus({
        id: orderId,
        organisationId: scope.organisationId,
        status: 'PROCESSING',
        fulfilmentStatus: 'SUPPLIER_PENDING',
      });

      // Submit purchase order to Curaleaf API if connected (deduped — never double-submit)
      const connection = await integrationRepo.findConnection(scope.organisationId, 'CURALEAF').catch(() => null);
      let curaleafResult: any = null;
      if (connection?.secretResourceName) {
        try {
          curaleafResult = await executeCuraleafOrderPlacement(connection, order);
        } catch (curaleafErr) {
          console.warn('Curaleaf purchase order submission note:', curaleafErr);
        }
      }

      if (curaleafResult?.prescriptionId || curaleafResult?.purchaseOrder) {
        await persistCuraleafPrescriptionIdentity({
          organisationId: scope.organisationId,
          orderId,
          patientId: order.patientId,
          snapshot: order.quoteSnapshot,
          prescriptionId: curaleafResult.prescriptionId,
          prescriberId: curaleafResult.prescriberId,
          purchaseOrder: curaleafResult.purchaseOrder ?? null,
          fulfilmentStatus: curaleafResult.purchaseOrder ? 'SUPPLIER_PROCESSING' : undefined,
        });
      }

      await promotePatientAfterCuraleafPlacement(patientFinanceDeps, order, curaleafResult).catch(err =>
        console.warn('Patient activation after Curaleaf placement note:', err),
      );

      await orderRepo.appendPlacementEvent({
        organisationId: scope.organisationId,
        orderId,
        orderLineId: prescriptionId,
        fromState: 'PENDING_PLACEMENT',
        toState: 'PLACED',
        reason: curaleafResult?.skipped
          ? `Prescription already placed with Curaleaf (${curaleafResult.reason})`
          : curaleafResult?.purchaseOrder?.id
            ? 'Prescription placed with Curaleaf Laboratories'
            : 'Prescription placed manually with pharmacy dispensing',
        externalReference: curaleafResult?.purchaseOrder?.id || order.orderNumber,
        actorUid: scope.uid,
      });

      res.status(200).json({ success: true, status: 'placed_manually', curaleaf: curaleafResult });
    } catch (error) {
      next(error);
    }
  });

  router.post('/portal/orders/:id/cancellations', requireCsrf, requireStaff('pharmacy'), requirePharmacyOperationalWrites, async (req: Request, res: Response, next: NextFunction) => {
    try {
      const scope = assertTenantScope(req.context!);
      const orderId = String(req.params.id || '');
      const input = z.object({
        organisationId: z.string().optional(),
        reason: z.enum(['added_in_error', 'patient_request', 'other']),
        note: z.string().max(1000).optional(),
      }).parse(req.body);
      const order = await orderRepo.findOrderById(orderId, scope.organisationId);
      if (!order) throw new HttpError(404, 'Order not found.', 'NOT_FOUND');
      if (order.archivedAt || String(order.resolutionStatus || '').toUpperCase() === 'RESOLVED') {
        throw new HttpError(409, 'This order has already been resolved and cannot be cancelled again.', 'ORDER_ALREADY_RESOLVED');
      }
      if (!orderAllowsManualCancellation(order)) {
        if (orderMoneyWasTaken(order)) {
          throw new HttpError(409, 'A paid order cannot use pharmacy cancellation. Use its resolution workflow instead.', 'PAID_ORDER_REQUIRES_RESOLUTION');
        }
        throw new HttpError(409, 'This order is not available for pharmacy cancellation.', 'ORDER_CANCELLATION_NOT_AVAILABLE');
      }
      if (curaleafOwnsCancellation(order.quoteSnapshot) && !supplierOrderCancelled(order.quoteSnapshot)) {
        throw new HttpError(409, 'This order is already with Curaleaf. Cancellation is recorded when Curaleaf cancels the prescription or purchase order.', 'CURALEAF_CANCEL_REQUIRED');
      }
      const requiresCuraleafCancel = curaleafRequiresSupplierCancel(order.quoteSnapshot) && !supplierOrderCancelled(order.quoteSnapshot);
      const requestedAt = new Date().toISOString();
      const snapshot = requiresCuraleafCancel
        ? stampCuraleafCancellationOnSnapshot(order.quoteSnapshot, {
          action: 'requested',
          reason: input.reason,
          note: input.note,
          actorUid: scope.uid,
          now: requestedAt,
        })
        : stampUnpaidManualCancellation(order.quoteSnapshot, {
          reason: input.reason,
          note: input.note,
          actorUid: scope.uid,
          now: requestedAt,
        });
      const moneyTaken = orderMoneyWasTaken(order);
      const exception = requiresCuraleafCancel || moneyTaken || supplierOrderCancelled(snapshot);
      await orderRepo.updateQuoteSnapshot({
        id: orderId,
        organisationId: scope.organisationId,
        quoteSnapshot: snapshot,
        fulfilmentStatus: exception ? 'EXCEPTION' : undefined,
      });
      if (!requiresCuraleafCancel) {
        await orderRepo.updateOrderStatus({
          id: orderId,
          organisationId: scope.organisationId,
          status: 'CANCELLED',
          cancelledAt: requestedAt,
        });
        await serialRepo.endLiveForOrder(scope.organisationId, orderId, 'hh_cancelled').catch(() => undefined);
      }
      const mapped = toPortalOrder({
        ...order,
        quoteSnapshot: snapshot,
        fulfilmentStatus: exception ? 'EXCEPTION' : order.fulfilmentStatus,
        status: !requiresCuraleafCancel ? 'CANCELLED' : order.status,
      } as any);
      res.status(201).json(mapped);
    } catch (error) { next(error); }
  });

  router.post('/portal/orders/:id/quote-review/resolve', requireCsrf, requireStaff('pharmacy'), requirePharmacyOperationalWrites, async (req: Request, res: Response, next: NextFunction) => {
    try {
      const scope = assertTenantScope(req.context!);
      const orderId = String(req.params.id || '');
      const input = z.object({
        organisationId: z.string().optional(),
        action: z.enum(['absorb', 'cancel', 'refresh']),
      }).parse(req.body);
      const order = await orderRepo.findOrderById(orderId, scope.organisationId);
      if (!order) throw new HttpError(404, 'Order not found.', 'NOT_FOUND');
      if (!orderMoneyWasTaken(order)) {
        throw new HttpError(409, 'Quote-review cancellation is available only after payment.', 'PAYMENT_REQUIRED');
      }
      if (curaleafCancellationBlocksPlacement(order.quoteSnapshot)) {
        throw new HttpError(409, 'This Curaleaf purchase order was cancelled.', 'CURALEAF_ORDER_CANCELLED');
      }
      const connection = await integrationRepo.findConnection(scope.organisationId, 'CURALEAF').catch(() => null);
      const snapshot = (order.quoteSnapshot && typeof order.quoteSnapshot === 'object' ? order.quoteSnapshot : {}) as Record<string, any>;
      const review = readQuoteReview(snapshot);
      const now = new Date().toISOString();
      const lineItems = Array.isArray(snapshot.lineItems) ? snapshot.lineItems as Array<Record<string, unknown>> : [];
      const quoteItems = lineItems.map(item => ({
        packId: String(item.packId || item.productId || ''),
        quantity: Number(item.quantity || item.count || 1),
      })).filter(item => item.packId && item.quantity > 0);

      const persistAndMaybePlace = async (nextSnapshot: unknown, extra?: { dispensingFeePence?: number; medicineTotalPence?: number; place?: boolean }) => {
        await orderRepo.updateQuoteSnapshot({
          id: orderId,
          organisationId: scope.organisationId,
          quoteSnapshot: nextSnapshot,
          fulfilmentStatus: 'SUPPLIER_PENDING',
          dispensingFeePence: extra?.dispensingFeePence,
          medicineTotalPence: extra?.medicineTotalPence,
        });
        let placement = null;
        if (extra?.place && connection?.secretResourceName) {
          placement = await executeCuraleafOrderPlacement(connection, {
            ...order,
            quoteSnapshot: nextSnapshot,
            paymentStatus: 'PAID',
            paidAt: order.paidAt,
            status: 'PROCESSING',
          });
        }
        const latest = await orderRepo.findOrderById(orderId, scope.organisationId);
        return { order: latest, placement };
      };

      if (input.action === 'refresh') {
        if (!connection?.secretResourceName || !quoteItems.length) throw new HttpError(409, 'A live Curaleaf quote is required.', 'QUOTE_UNAVAILABLE');
        const latestQuote = await fetchCuraleafQuote(connection, quoteItems);
        const decision = evaluateQuoteReview({ snapshot, latestRaw: latestQuote, now });
        if (!decision.hold) {
          const approved = stampQuoteReviewOnSnapshot(snapshot, {
            status: 'approved',
            type: review?.type || 'supplier_cost_changed',
            fingerprint: decision.fingerprint,
            latestQuote,
            differences: [],
            patientDeltaPence: 0,
            checkedAt: now,
            approvedAt: now,
            approvedFingerprint: decision.fingerprint,
          });
          const result = await persistAndMaybePlace(approved, { place: true });
          res.status(200).json({ action: 'refresh', placed: Boolean(result.placement && 'purchaseOrder' in result.placement && result.placement.purchaseOrder), order: toPortalOrder(result.order as any) });
          return;
        }
        const held = stampQuoteReviewOnSnapshot(snapshot, decision.review);
        const result = await persistAndMaybePlace(held);
        res.status(200).json({ action: 'refresh', placed: false, order: toPortalOrder(result.order as any) });
        return;
      }

      if (!review || (review.status !== 'required' && review.status !== 'awaiting_top_up' && review.status !== 'awaiting_refund')) {
        throw new HttpError(409, 'This order is not waiting on quote review.', 'QUOTE_REVIEW_NOT_REQUIRED');
      }

      if (input.action === 'absorb') {
        if (review.type === 'out_of_stock') throw new HttpError(409, 'Out-of-stock lines cannot be absorbed.', 'STOCK_HOLD');
        const signedAdjustment = Number(review.patientDeltaPence || 0);
        const sourceCheck = review.quoteCheckId
          ? await paymentRepo.findQuoteCheckById(String(review.quoteCheckId), scope.organisationId)
          : null;
        if (sourceCheck) {
          await paymentRepo.createQuoteCheck({
            organisationId: scope.organisationId,
            orderId,
            paymentId: sourceCheck.paymentId ?? null,
            phase: 'FINAL_PLACEMENT',
            status: 'ABSORBED',
            baselineQuoteCheckId: sourceCheck.baselineQuoteCheckId ?? null,
            basketFingerprint: sourceCheck.basketFingerprint,
            quoteFingerprint: sourceCheck.quoteFingerprint,
            patientTotalPence: Number(sourceCheck.patientTotalPence),
            wholesaleTotalPence: Number(sourceCheck.wholesaleTotalPence),
            shippingPence: Number(sourceCheck.shippingPence),
            taxPence: Number(sourceCheck.taxPence),
            rawQuote: sourceCheck.rawQuote,
            comparison: { ...(sourceCheck.comparison && typeof sourceCheck.comparison === 'object' ? sourceCheck.comparison as Record<string, unknown> : {}), decision: 'ABSORB', signedAdjustmentPence: signedAdjustment },
            decidedByUid: scope.uid,
          });
        }
        const approved = stampQuoteReviewOnSnapshot({
          ...snapshot,
          pharmacyContributionPence: signedAdjustment,
        }, {
          ...review,
          status: 'approved',
          approvedAt: now,
          approvedFingerprint: review.fingerprint,
          pharmacyContributionPence: signedAdjustment,
        });
        const result = await persistAndMaybePlace(approved, { place: true });
        res.status(200).json({ action: 'absorb', order: toPortalOrder(result.order as any) });
        return;
      }

      if (input.action === 'cancel') {
        const sourceCheck = review.quoteCheckId
          ? await paymentRepo.findQuoteCheckById(String(review.quoteCheckId), scope.organisationId)
          : null;
        if (sourceCheck) {
          await paymentRepo.createQuoteCheck({
            organisationId: scope.organisationId,
            orderId,
            paymentId: sourceCheck.paymentId ?? null,
            phase: sourceCheck.phase,
            status: 'CANCELLED',
            baselineQuoteCheckId: sourceCheck.baselineQuoteCheckId ?? null,
            basketFingerprint: sourceCheck.basketFingerprint,
            quoteFingerprint: sourceCheck.quoteFingerprint,
            patientTotalPence: Number(sourceCheck.patientTotalPence),
            wholesaleTotalPence: Number(sourceCheck.wholesaleTotalPence),
            shippingPence: Number(sourceCheck.shippingPence),
            taxPence: Number(sourceCheck.taxPence),
            rawQuote: sourceCheck.rawQuote,
            comparison: { ...(sourceCheck.comparison && typeof sourceCheck.comparison === 'object' ? sourceCheck.comparison as Record<string, unknown> : {}), decision: 'CANCEL' },
            decidedByUid: scope.uid,
          });
        }
        const cancelled = stampQuoteReviewOnSnapshot({
          ...snapshot,
          resolution: { status: 'required', reason: 'quote_changed', options: ['replace', 'refund'], requestedAt: now, requestedBy: scope.uid },
        }, {
          ...review,
          status: 'recreate_required',
        });
        const result = await persistAndMaybePlace(cancelled);
        res.status(200).json({ action: 'cancel', resolutionRequired: true, order: toPortalOrder(result.order as any) });
        return;
      }

      throw new HttpError(400, 'Unsupported quote review action.', 'QUOTE_REVIEW_ACTION');
    } catch (error) { next(error); }
  });

  // POST /v1/portal/orders/:id/curaleaf-cancellation - Record Curaleaf order cancellation
  router.post('/portal/orders/:id/curaleaf-cancellation', requireCsrf, requireStaff('pharmacy'), requirePharmacyOperationalWrites, async (req: Request, res: Response, next: NextFunction) => {
    try {
      const scope = assertTenantScope(req.context!);
      const orderId = String(req.params.id || '');
      const input = z.object({
        organisationId: z.string().optional(),
        action: z.enum(['contacted', 'confirmed']).default('contacted'),
        reference: z.string().trim().min(3).max(160).optional(),
        note: z.string().max(1000).optional(),
        reason: z.string().min(1).max(255).optional(),
      }).parse(req.body);

      const order = await orderRepo.findOrderById(orderId, scope.organisationId);
      if (!order) {
        throw new HttpError(404, 'Order not found.', 'NOT_FOUND');
      }

      const snapshot = stampCuraleafCancellationOnSnapshot(order.quoteSnapshot, {
        action: input.action,
        reference: input.reference || input.reason || 'curaleaf_contact',
        note: input.note,
        actorUid: scope.uid,
      });
      await orderRepo.updateQuoteSnapshot({
        id: orderId,
        organisationId: scope.organisationId,
        quoteSnapshot: snapshot,
        fulfilmentStatus: input.action === 'confirmed' || supplierOrderCancelled(snapshot)
          ? 'EXCEPTION'
          : undefined,
      });
      const latest = await orderRepo.findOrderById(orderId, scope.organisationId);
      res.status(200).json(toPortalOrder({
        ...(latest as object),
        quoteSnapshot: snapshot,
      } as any));
    } catch (error) {
      next(error);
    }
  });

  // Curaleaf does not expose a REJECTED prescription state. Keep the legacy
  // route fail-closed so older clients cannot recreate the false-terminal path.
  router.post('/portal/orders/:id/curaleaf-rejections', requireCsrf, requireStaff('pharmacy'), requirePharmacyOperationalWrites, (_req: Request, _res: Response, next: NextFunction) => {
    next(new HttpError(410, 'Curaleaf rejection recording is retired. Use the waiting, correction, cancellation, or reconciliation flow.', 'CURALEAF_REJECTION_ROUTE_RETIRED'));
  });

  // POST /v1/portal/orders/:id/refunds/manual - Prepare manual refund task
  router.post('/portal/orders/:id/refunds/manual', requireCsrf, requireStaff('pharmacy'), requirePharmacyOperationalWrites, async (req: Request, res: Response, next: NextFunction) => {
    try {
      const scope = assertTenantScope(req.context!);
      const orderId = String(req.params.id || '');
      const input = z.object({
        organisationId: z.string().optional(),
        reason: z.enum(['patient_cancelled', 'replacement_price_changed']),
        resolution: z.enum(['cancel', 'replace_new_payment']),
      }).parse(req.body);

      const order = await orderRepo.findOrderById(orderId, scope.organisationId);
      if (!order) throw new HttpError(404, 'Order not found.', 'NOT_FOUND');
      if (order.archivedAt || String(order.resolutionStatus || '').toUpperCase() === 'RESOLVED') {
        throw new HttpError(409, 'This order has already been resolved and cannot start another refund.', 'ORDER_ALREADY_RESOLVED');
      }
      if ((curaleafOwnsCancellation(order.quoteSnapshot) || curaleafRequiresSupplierCancel(order.quoteSnapshot)) && !supplierOrderCancelled(order.quoteSnapshot)) {
        throw new HttpError(409, 'Confirm the Curaleaf cancellation before preparing a patient refund.', 'CURALEAF_CANCEL_REQUIRED');
      }
      if (!orderMoneyWasTaken(order)) {
        throw new HttpError(409, 'This order has no settled patient payment to refund.', 'REFUND_NOT_REQUIRED');
      }
      const existingRefunds = await paymentRepo.listRefundsByOrderId(orderId, scope.organisationId);
      if (existingRefunds.some(row => String(row.status).toUpperCase() === 'COMPLETED')) {
        throw new HttpError(409, 'This order refund is already confirmed.', 'REFUND_ALREADY_COMPLETED');
      }
      if (snapshotRefundCompleted(order.quoteSnapshot)) {
        throw new HttpError(409, 'This order refund is already confirmed.', 'REFUND_ALREADY_COMPLETED');
      }

      const snapshot = (order.quoteSnapshot && typeof order.quoteSnapshot === 'object' ? order.quoteSnapshot : {}) as Record<string, any>;
      const payment = await paymentForManualRefund(paymentRepo, order);
      const allocations = await paymentRepo.listPaymentAllocations(payment.id, scope.organisationId);
      const activeAllocation = allocations.find(row => row.orderId === orderId && row.status === 'ACTIVE');
      const sourceLines = await orderLineRepo.listByOrderId(orderId);
      const curaleaf = snapshot.curaleaf && typeof snapshot.curaleaf === 'object' ? snapshot.curaleaf : {};
      let refundAmountPence: number;
      try {
        refundAmountPence = replacementAllocationAmount({
          activeAllocationPence: Number(activeAllocation?.amountPence ?? payment.amountPence),
          hasPurchaseOrder: Boolean(curaleaf.purchaseOrderId || curaleaf.purchaseOrderState || curaleaf.shipments?.length),
          sourceLines,
          fulfilmentLines: Array.isArray(curaleaf.lines) ? curaleaf.lines : [],
        });
      } catch (error) {
        throw new HttpError(409, error instanceof Error ? error.message : 'The refund value requires reconciliation.', 'REFUND_AMOUNT_RECONCILIATION');
      }
      const refundState = {
        ...pendingManualRefund(order, scope.uid),
        amountPence: refundAmountPence,
        partial: refundAmountPence < Number(payment.amountPence),
      };
      const storedRefund = existingRefunds.find(row => ['PENDING_CONFIRMATION', 'VERIFICATION_PENDING', 'RECONCILIATION_REQUIRED'].includes(String(row.status).toUpperCase()))
        ?? await paymentRepo.createRefund({
          organisationId: scope.organisationId,
          orderId,
          paymentId: payment.id,
          amountPence: refundState.amountPence,
          currency: order.currency || 'GBP',
          cause: input.reason,
          route: String(order.paymentRoute || '').toUpperCase() === 'WORLDPAY' ? 'WORLDPAY' : 'MANUAL',
          status: 'PENDING_CONFIRMATION',
          idempotencyKey: `manual-refund:${scope.organisationId}:${orderId}`,
        });
      if (!activeAllocation) {
        await paymentRepo.createPaymentAllocation({
          organisationId: scope.organisationId,
          paymentId: payment.id,
          orderId,
          amountPence: Number(payment.amountPence),
        });
      }
      const nextSnapshot = withPendingPaidRefund({
        ...snapshot,
        cancellation: {
          ...(snapshot.cancellation && typeof snapshot.cancellation === 'object' ? snapshot.cancellation : {}),
          status: 'refund_required',
          reason: input.reason === 'replacement_price_changed' ? 'other' : 'patient_request',
        },
      }, { ...refundState, id: storedRefund.id });

      await orderRepo.updateQuoteSnapshot({
        id: orderId,
        organisationId: scope.organisationId,
        quoteSnapshot: nextSnapshot,
        fulfilmentStatus: 'EXCEPTION',
      });
      await orderRepo.updateOrderStatus({
        id: orderId,
        organisationId: scope.organisationId,
        status: 'CANCELLED',
        paymentStatus: 'REFUND_REQUIRED',
        cancelledAt: new Date().toISOString(),
      });

      await purgeOrderPrescriptionFiles(scope.organisationId, order.quoteSnapshot).catch(error =>
        console.warn('[Prescription file] Purge after cancellation note:', error),
      );

      res.status(201).json({ ...refundState, id: storedRefund.id });
    } catch (error) {
      next(error);
    }
  });

  // POST /v1/portal/orders/:id/refunds/:refundId/confirm - Confirm completed manual refund
  router.post('/portal/orders/:id/refunds/:refundId/confirm', requireCsrf, requireStaff('pharmacy'), requirePharmacyOperationalWrites, async (req: Request, res: Response, next: NextFunction) => {
    try {
      const scope = assertTenantScope(req.context!);
      const orderId = String(req.params.id || '');
      const refundId = String(req.params.refundId || '');
      const input = z.object({
        organisationId: z.string().optional(),
        externalReference: z.string().trim().min(3).max(160),
      }).parse(req.body);

      const order = await orderRepo.findOrderById(orderId, scope.organisationId);
      if (!order) throw new HttpError(404, 'Order not found.', 'NOT_FOUND');
      const sqlRefunds = await paymentRepo.listRefundsByOrderId(orderId, scope.organisationId);
      const sqlRefund = sqlRefunds.find(row => row.id === refundId)
        ?? sqlRefunds.find(row => String(row.status).toUpperCase() === 'PENDING_CONFIRMATION')
        ?? null;
      if (sqlRefund && String(sqlRefund.status).toUpperCase() === 'COMPLETED') {
        if (sqlRefund.externalReference !== input.externalReference) {
          throw new HttpError(409, 'This refund was already confirmed with a different reference.', 'REFUND_REFERENCE_CONFLICT');
        }
        res.status(200).json({
          ...completedManualRefund(order, {
            refundId: sqlRefund.id,
            externalReference: input.externalReference,
            actorUid: sqlRefund.confirmedByUid || scope.uid,
            now: sqlRefund.confirmedAt || undefined,
          }),
          amountPence: Number(sqlRefund.amountPence),
          partial: Number(sqlRefund.amountPence) < Number(order.totalPence),
          reused: true,
        });
        return;
      }
      if (order.archivedAt || String(order.resolutionStatus || '').toUpperCase() === 'RESOLVED') {
        throw new HttpError(409, 'This order has already been resolved and cannot confirm another refund.', 'ORDER_ALREADY_RESOLVED');
      }
      if (!orderMoneyWasTaken(order) && !refundRecord(order.quoteSnapshot).id && !sqlRefund) {
        throw new HttpError(409, 'This order has no settled patient payment to refund.', 'REFUND_NOT_REQUIRED');
      }

      const snapshot = (order.quoteSnapshot && typeof order.quoteSnapshot === 'object' ? order.quoteSnapshot : {}) as Record<string, any>;
      const priorRefund = refundRecord(snapshot);
      const quoteDifference = priorRefund.kind === 'quote_difference' || priorRefund.reason === 'replacement_price_changed';
      if (!quoteDifference && (curaleafOwnsCancellation(order.quoteSnapshot) || curaleafRequiresSupplierCancel(order.quoteSnapshot)) && !supplierOrderCancelled(order.quoteSnapshot)) {
        throw new HttpError(409, 'Confirm the Curaleaf cancellation before recording a patient refund.', 'CURALEAF_CANCEL_REQUIRED');
      }
      const now = new Date().toISOString();
      if (!sqlRefund && priorRefund.id && priorRefund.id !== refundId && refundId !== `refund-${orderId}`) {
        throw new HttpError(404, 'Refund task not found.', 'NOT_FOUND');
      }
      if (sqlRefund && sqlRefund.id !== refundId && refundId !== `refund-${orderId}`) {
        throw new HttpError(404, 'Refund task not found.', 'NOT_FOUND');
      }

      if (!sqlRefund) {
        throw new HttpError(409, 'This legacy refund has no durable refund record and must be reconciled.', 'REFUND_RECONCILIATION_REQUIRED');
      }
      const payment = (await paymentRepo.listPaymentsByOrderId(orderId, scope.organisationId))
        .find(row => row.id === sqlRefund.paymentId) ?? null;
      if (!payment || !['PAID', 'REFUND_REQUIRED', 'REFUNDED'].includes(payment.status)) {
        await paymentRepo.markRefundVerification({
          id: sqlRefund.id,
          status: 'RECONCILIATION_REQUIRED',
          externalReference: input.externalReference,
          confirmedByUid: scope.uid,
          verificationStatus: 'settled_payment_missing',
        });
        throw new HttpError(409, 'The settled payment could not be matched to this refund.', 'REFUND_RECONCILIATION_REQUIRED');
      }

      let verificationStatus = 'manual_reference_recorded';
      let verificationPayload: unknown = null;
      if (payment.route === 'WORLDPAY') {
        const worldpayConnection = await integrationRepo.findConnection(scope.organisationId, 'WORLDPAY').catch(() => null);
        const transactionReference = String(payment.transactionReference || '').trim();
        const queried = transactionReference
          ? await queryWorldpayPayment(worldpayConnection, scope.organisationId, transactionReference)
          : { queried: false as const, reason: 'The Worldpay transaction reference is missing.' };
        if (!queried.queried) {
          await paymentRepo.markRefundVerification({
            id: sqlRefund.id,
            status: 'VERIFICATION_PENDING',
            externalReference: input.externalReference,
            confirmedByUid: scope.uid,
            verificationStatus: 'worldpay_query_pending',
          });
          res.status(202).json({ id: sqlRefund.id, status: 'verification_pending', externalReference: input.externalReference });
          return;
        }
        const provider = queried.query;
        const verification = verifyWorldpayRefund({
          query: provider,
          transactionReference,
          paymentId: provider.paymentId,
          paymentAmountPence: Number(payment.amountPence),
          refundAmountPence: Number(sqlRefund.amountPence),
          currency: payment.currency,
          expectedEntityId: queried.expectedEntityId,
          externalReference: input.externalReference,
        });
        if (!verification.verified) {
          await paymentRepo.markRefundVerification({
            id: sqlRefund.id,
            status: verification.pending ? 'VERIFICATION_PENDING' : 'RECONCILIATION_REQUIRED',
            externalReference: input.externalReference,
            confirmedByUid: scope.uid,
            verificationStatus: verification.reason,
            verificationPayload: { providerStatus: provider.providerStatus, paymentId: provider.paymentId },
          });
          if (verification.pending) {
            res.status(202).json({ id: sqlRefund.id, status: 'verification_pending', externalReference: input.externalReference });
            return;
          }
          throw new HttpError(409, 'Worldpay did not verify the refund reference, exact amount, currency, payment identity and completed state.', 'REFUND_RECONCILIATION_REQUIRED');
        }
        verificationStatus = Number(sqlRefund.amountPence) < Number(payment.amountPence)
          ? 'worldpay_partial_refund_verified'
          : 'worldpay_refund_verified';
        verificationPayload = {
          providerStatus: provider.providerStatus,
          paymentId: provider.paymentId,
          refundAmountPence: Number(sqlRefund.amountPence),
          providerEvidence: verification.evidence,
        };
      }

      const activeAllocations = await paymentRepo.listPaymentAllocations(payment.id, scope.organisationId);
      if (!activeAllocations.some(row => row.orderId === orderId && row.status === 'ACTIVE')) {
        await paymentRepo.createPaymentAllocation({
          organisationId: scope.organisationId,
          paymentId: payment.id,
          orderId,
          amountPence: Number(payment.amountPence),
        });
      }
      await paymentRepo.completeRefundAndConsumeAllocation({
        refundId: sqlRefund.id,
        organisationId: scope.organisationId,
        orderId,
        paymentId: payment.id,
        amountPence: Number(sqlRefund.amountPence),
        externalReference: input.externalReference,
        confirmedByUid: scope.uid,
        verificationStatus,
        verificationPayload,
      });

      const confirmedId = sqlRefund?.id || refundId || String(priorRefund.id || `refund-${orderId}`);
      const nextRefund = {
        ...completedManualRefund(order, {
          refundId: confirmedId,
          externalReference: input.externalReference,
          actorUid: scope.uid,
          now,
        }),
        amountPence: Number(sqlRefund.amountPence),
        partial: Number(sqlRefund.amountPence) < Number(payment.amountPence),
      };

      const nextSnapshot = quoteDifference
        ? stampQuoteReviewOnSnapshot({ ...snapshot, refund: nextRefund }, null)
        : { ...snapshot, refund: nextRefund };

      await orderRepo.updateQuoteSnapshot({
        id: orderId,
        organisationId: scope.organisationId,
        quoteSnapshot: nextSnapshot,
        fulfilmentStatus: 'EXCEPTION',
      });

      await orderRepo.markRefundResolution({
        orderId,
        organisationId: scope.organisationId,
        fullyRefunded: Number(sqlRefund.amountPence) >= Number(payment.amountPence),
      });
      await serialRepo.endLiveForOrder(scope.organisationId, orderId, 'refunded').catch(() => undefined);

      await purgeOrderPrescriptionFiles(scope.organisationId, order.quoteSnapshot).catch(error =>
        console.warn('[Prescription file] Purge after cancellation note:', error),
      );

      const [patient, organisation] = await Promise.all([
        patientRepo.findPatientById(scope.organisationId, order.patientId).catch(() => null),
        organisationRepo.findOrganisationById(scope.organisationId).catch(() => null),
      ]);
      if (patient?.email) {
        await queueEmailToRecipients(
          notificationRepo,
          [{ email: patient.email, displayName: patient.firstName || null }],
          'patient_refunded',
          {
            firstName: patient.firstName || 'Patient',
            amountPence: nextRefund.amountPence,
            currency: order.currency || 'GBP',
            orderNumber: order.orderNumber,
            ...pharmacyEmailContext(organisation),
          },
          ['patient-refunded', orderId, refundId],
          { organisationId: scope.organisationId, patientId: order.patientId, orderId },
        );
      }

      res.status(200).json(nextRefund);
    } catch (error) {
      next(error);
    }
  });

  // POST /v1/portal/orders/:id/handout - Hand out medication to patient
  router.post('/portal/orders/:id/handout', requireCsrf, requireStaff('pharmacy'), requirePharmacyOperationalWrites, async (req: Request, res: Response, next: NextFunction) => {
    try {
      const scope = assertTenantScope(req.context!);
      const orderId = String(req.params.id || '');
      const input = z.object({
        organisationId: z.string().optional(),
        partial: z.boolean().optional(),
        shipmentId: z.string().optional(),
      }).parse(req.body || {});
      const order = await orderRepo.findOrderById(orderId, scope.organisationId);
      if (!order) throw new HttpError(404, 'Order not found.', 'NOT_FOUND');

      const snapshot = (order.quoteSnapshot && typeof order.quoteSnapshot === 'object' ? order.quoteSnapshot : {}) as Record<string, any>;
      const curaleaf = snapshot.curaleaf && typeof snapshot.curaleaf === 'object' ? snapshot.curaleaf : {};
      const requestedItems = snapshot.lineItems || snapshot.items || [];
      const lines = normalisedFulfilmentLines({
        purchaseOrder: curaleaf,
        shipments: curaleaf.shipments || [],
        requestedItems,
        priorLines: curaleaf.lines,
      });
      const result = applyPharmacyHandout({
        lines,
        shipmentStates: curaleaf.shipmentStates || {},
        shipmentId: input.shipmentId,
        partial: input.partial === true,
      });
      if (!result.allowed) {
        throw new HttpError(409, 'Remaining packs are still open with Curaleaf. Use partial handover for arrived packs only.', 'REMAINDER_OPEN');
      }
      if (!order.patientId) {
        throw new HttpError(409, 'The order has no patient.', 'PATIENT_REQUIRED');
      }

      const collectedAt = new Date().toISOString();
      const dispenseKey = input.shipmentId || (input.partial ? `partial-${collectedAt.slice(0, 10)}` : 'full');
      await recordCollectedDispense(patientFinanceDeps, {
        organisationId: scope.organisationId,
        patientId: order.patientId,
        orderId,
        actorUid: scope.uid,
        dispenseKey,
        collectedAt,
      });

      const nextStatus = result.remainingOpen
        ? 'PARTIALLY_RECEIVED'
        : 'COLLECTED';
      await orderRepo.updateQuoteSnapshot({
        id: orderId,
        organisationId: scope.organisationId,
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
        await orderRepo.updateOrderStatus({
          id: orderId,
          organisationId: scope.organisationId,
          status: 'COMPLETED',
          fulfilmentStatus: 'COLLECTED',
        });
      }

      const pharmacyRecipients = await listPharmacyRecipients(scope.organisationId, { identityRepo, organisationRepo });
      await queueEmailToRecipients(
        notificationRepo,
        pharmacyRecipients,
        'pharmacy_collection_completed',
        {
          orderNumber: order.orderNumber,
          summary: result.remainingOpen ? 'Partial collection completed.' : 'Collection completed.',
        },
        ['pharmacy-collection-completed', orderId, dispenseKey],
        { organisationId: scope.organisationId, patientId: order.patientId, orderId },
      );

      res.status(200).json({
        id: orderId,
        status: result.remainingOpen ? 'partially_collected' : 'collected',
        collectedAt,
      });
    } catch (error) {
      next(error);
    }
  });

  // POST /v1/portal/orders/:id/ready-for-collection - Mark order ready for collection
  router.post('/portal/orders/:id/ready-for-collection', requireCsrf, requireStaff('pharmacy'), requirePharmacyOperationalWrites, async (req: Request, res: Response, next: NextFunction) => {
    try {
      const scope = assertTenantScope(req.context!);
      const orderId = String(req.params.id || '');
      const order = await orderRepo.findOrderById(orderId, scope.organisationId);
      if (!order) throw new HttpError(404, 'Order not found.', 'NOT_FOUND');

      const snapshot = (order.quoteSnapshot && typeof order.quoteSnapshot === 'object' ? order.quoteSnapshot : {}) as Record<string, any>;
      const curaleaf = snapshot.curaleaf && typeof snapshot.curaleaf === 'object' ? snapshot.curaleaf : {};
      const lines = Array.isArray(curaleaf.lines) ? curaleaf.lines : [];
      const remainingOpen = lines.some((line: any) => Number(line.remaining || 0) > 0 || Number(line.received || 0) < Number(line.ordered || 0));
      await orderRepo.updateQuoteSnapshot({
        id: orderId,
        organisationId: scope.organisationId,
        quoteSnapshot: snapshot,
        fulfilmentStatus: remainingOpen ? 'PARTIALLY_RECEIVED' : 'READY_FOR_COLLECTION',
      });

      await queueCollectionReadyEmail(
        { notificationRepo, patientRepo, organisationRepo },
        {
          organisationId: scope.organisationId,
          orderId,
          patientId: order.patientId,
          orderNumber: order.orderNumber,
          scopeKey: remainingOpen ? 'partial' : 'full',
        },
      );

      res.status(200).json({ id: orderId, status: 'ready', readyAt: new Date().toISOString() });
    } catch (error) {
      next(error);
    }
  });

  // POST /v1/portal/orders/:id/cancel-and-archive - Cancel with Curaleaf & Replace Order
  router.post('/portal/orders/:id/cancel-and-archive', requireCsrf, requireStaff('pharmacy'), requirePharmacyOperationalWrites, async (req: Request, res: Response, next: NextFunction) => {
    try {
      assertTenantScope(req.context!);
      throw new HttpError(
        410,
        'This unsafe archive shortcut has been retired. Resolve the paid order through a committed replacement with payment allocation transfer, or a verified refund.',
        'REPLACEMENT_RESOLUTION_REQUIRED',
      );
    } catch (error) {
      next(error);
    }
  });

  return router;
}
