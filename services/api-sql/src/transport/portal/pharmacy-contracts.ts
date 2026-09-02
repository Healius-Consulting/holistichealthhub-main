import { paidQuoteFromSnapshot } from '../../application/orders/finance-costing.js';
import { curaleafWaitingSla } from '../../application/orders/curaleaf-waiting-sla.js';
import { orderMoneyWasTaken, snapshotRefundCompleted } from '../../application/orders/paid-refund.js';
import {
  advanceFulfilmentStatus,
  dispatchStatusFromLines,
  latestShipmentCreatedAt,
  mergePriorPharmacyLines,
  normalisedFulfilmentLines,
  supplierFulfilmentStatus,
  type CuraleafShipmentLike,
} from '../../application/orders/curaleaf-fulfilment.js';
import { parseQuote, type ParsedQuote, type ParsedQuoteItem } from '../../application/orders/quote-review.js';
import { curaleafRequiresSupplierCancel, supplierCancellationAlreadyConfirmed } from '../../application/integrations/curaleaf-events.js';
import { organisationAddressSummary } from '../../repositories/ports/directory.port.js';
import type { OrderDraftRecord, OrderRecord } from '../../repositories/ports/order.port.js';
import type { OrganisationRecord } from '../../repositories/ports/organisation.port.js';
import type { PatientRecord } from '../../repositories/ports/patient.port.js';
import type { PaymentAllocationRecord, QuoteCheckRecord } from '../../repositories/ports/payment.port.js';
import type { TenantPendingEnquiryRecord } from '../../repositories/ports/intake.port.js';
import { formConditionRecords, primaryConditionCode } from '../../domain/eligibility/form-conditions.js';
import { sqlIntakeCaseReference } from './intake-contracts.js';
import { pendingEnquiryDisplayStatus, portalSourceType } from './intake-source.js';
import { overviewFinanceSnapshot } from '../../application/finance/pharmacy-ledger.js';
import { serialReuseUntilDate } from '../../application/prescriptions/serial-reuse.js';
import {
  curaleafSubOrders,
  filterRecordsByPackIds,
  packIdFromRecord,
  packIdsForRx,
  snapshotRxKey,
} from '../../application/prescriptions/snapshot-rx.js';

type PortalOrder = ReturnType<typeof toPortalOrder>;

const DAY_MS = 24 * 60 * 60 * 1000;

function lower(value: string) {
  return value.toLowerCase();
}

/** Workspace lifecycle shown to staff. Intake is a separate flag from day 0. */
function portalAccountStatus(status: OrganisationRecord['status']) {
  if (status === 'INTAKE_LIVE') return 'onboarding' as const;
  return lower(status) as 'onboarding' | 'live' | 'paused';
}

function snapshotRecord(snapshot: unknown): Record<string, unknown> {
  return snapshot && typeof snapshot === 'object' && !Array.isArray(snapshot)
    ? snapshot as Record<string, unknown>
    : {};
}

function moneyFromPence(pence: number) {
  return (pence / 100).toFixed(2);
}

/** Paid snapshot quote only — never a later live recheck. */
function parsedPaidQuote(snapshot: unknown): ParsedQuote | null {
  const paid = paidQuoteFromSnapshot(snapshot);
  if (paid) return paid;
  const root = snapshotRecord(snapshot);
  return parseQuote(root.pricingQuote) ?? parseQuote(root.quote);
}

function portalQuotePayload(quote: ParsedQuote) {
  return {
    shippingPrice: moneyFromPence(quote.shippingPence),
    taxRate: quote.taxRate,
    shippingPence: quote.shippingPence,
    wholesaleProductPence: quote.items.reduce((sum, item) => sum + item.wholesalePence * item.quantity, 0),
    items: quote.items.map(item => ({
      packId: item.packId,
      quantity: item.quantity,
      inStock: item.inStock,
      stockStatus: item.stockStatus,
      wholesalePackPrice: moneyFromPence(item.wholesalePence),
      patientPackPrice: moneyFromPence(item.patientPence),
    })),
  };
}

function lineWholesalePence(item: Record<string, unknown>, quoted: ParsedQuoteItem | undefined): number | undefined {
  if (quoted && quoted.wholesalePence > 0) return quoted.wholesalePence;
  if (typeof item.wholesalePackPricePence === 'number' && Number.isFinite(item.wholesalePackPricePence) && item.wholesalePackPricePence > 0) {
    return Math.round(item.wholesalePackPricePence);
  }
  const stamped = Number(item.wholesalePackPrice ?? item.wholesalePrice);
  if (Number.isFinite(stamped) && stamped > 0) return Math.round(stamped * 100);
  return undefined;
}

const POST_PURCHASE_ORDER_FULFILMENT = new Set([
  'SUPPLIER_ALLOCATED',
  'PARTIALLY_DISPATCHED_TO_PHARMACY',
  'DISPATCHED_TO_PHARMACY',
  'PARTIALLY_RECEIVED',
  'RECEIVED',
  'READY_FOR_COLLECTION',
  'COLLECTED',
]);

function realPurchaseOrderId(po: { id?: unknown; purchaseOrderId?: unknown } | null | undefined, order: Pick<OrderRecord, 'id' | 'orderNumber'>) {
  for (const candidate of [po?.id, po?.purchaseOrderId]) {
    if (typeof candidate !== 'string' || !candidate.trim()) continue;
    const id = candidate.trim();
    if (id === order.id || id === order.orderNumber) continue;
    return id;
  }
  return null;
}

function asPrescriptionState(value: unknown): 'ACTIVE' | 'FULFILLED' | 'EXPIRED' | 'CANCELLED' | 'PENDING' | undefined {
  const state = String(value || '').trim().toUpperCase();
  if (state === 'ACTIVE' || state === 'FULFILLED' || state === 'EXPIRED' || state === 'CANCELLED' || state === 'PENDING') {
    return state;
  }
  return undefined;
}

function timestamp(value: string | null | undefined, fallback: string) {
  const parsed = Date.parse(value || '');
  return Number.isFinite(parsed) ? parsed : Date.parse(fallback);
}

function ageDays(at: number, now: number) {
  return Math.max(0, Math.floor((now - at) / DAY_MS));
}

function orderActivityAt(order: Pick<OrderRecord, 'collectedAt' | 'paidAt' | 'submittedAt' | 'updatedAt' | 'createdAt'>) {
  for (const value of [order.collectedAt, order.paidAt, order.submittedAt, order.updatedAt, order.createdAt]) {
    const parsed = Date.parse(value || '');
    if (Number.isFinite(parsed)) return parsed;
  }
  return Date.now();
}

function overviewPatientLabel(patient: PatientRecord | undefined) {
  const surname = patient?.surname?.trim();
  const firstInitial = patient?.firstName?.trim()?.[0]?.toUpperCase();
  if (!surname && !firstInitial) return 'Patient record';
  if (!firstInitial) return surname!;
  return surname ? `${surname}, ${firstInitial}` : firstInitial;
}

function overviewOrderReference(order: { id: string; orderNumber?: string | null }) {
  const number = order.orderNumber?.trim();
  if (number) return `#${number}`;
  return `#${order.id.replaceAll('-', '').slice(0, 8).toUpperCase()}`;
}

export function toPortalOrganisation(
  organisation: OrganisationRecord,
  extras?: {
    websiteDomains?: string[];
    emailLogoUrl?: string | null;
    emailLogoStoragePath?: string | null;
    emailLogoWidth?: number | null;
    emailLogoHeight?: number | null;
    emailLogoUpdatedAt?: string | null;
    curaleafPharmacyCode?: string | null;
  },
) {
  return {
    id: organisation.id,
    orgId: organisation.companyId ?? organisation.id,
    name: organisation.name,
    tradingName: organisation.tradingName,
    logoText: organisation.logoText,
    emailLogoUrl: extras?.emailLogoUrl ?? null,
    emailLogoStoragePath: extras?.emailLogoStoragePath ?? null,
    emailLogoWidth: extras?.emailLogoWidth ?? null,
    emailLogoHeight: extras?.emailLogoHeight ?? null,
    emailLogoUpdatedAt: extras?.emailLogoUpdatedAt ?? null,
    gphcNumber: organisation.gphcNumber,
    superintendent: organisation.superintendentName,
    companyNumber: organisation.companyNumber ?? undefined,
    mainContactName: organisation.mainContactName ?? undefined,
    mainContactPhone: organisation.mainContactPhone ?? undefined,
    mainContactEmail: organisation.mainContactEmail ?? undefined,
    curaleafPharmacyCode: extras?.curaleafPharmacyCode ?? undefined,
    address: organisationAddressSummary(organisation),
    addressLine1: organisation.addressLine1 ?? undefined,
    addressLine2: organisation.addressLine2 ?? undefined,
    locality: organisation.locality ?? undefined,
    county: organisation.county ?? undefined,
    postcode: organisation.postcode ?? undefined,
    websiteDomains: extras?.websiteDomains ?? [],
    primaryColour: organisation.primaryColour,
    status: portalAccountStatus(organisation.status),
    portalName: organisation.portalName,
    worldpayEnabled: organisation.worldpayEnabled,
    defaultPaymentRoute: lower(organisation.defaultPaymentRoute),
    pharmacyDeliveryEnabled: organisation.pharmacyDeliveryEnabled,
    autoPlacementEnabled: organisation.autoPlacementEnabled,
    intakeEnabled: organisation.intakeEnabled,
    testAccount: organisation.classification === 'TRAINING',
    gdprExempt: !organisation.gdprComplianceFlag,
    workspaceClassification: lower(organisation.classification),
  };
}

export function toPortalPendingEnquiry(record: TenantPendingEnquiryRecord) {
  const sourceType = portalSourceType(record.sourceType);
  const fromForm = formConditionRecords({
    conditionCodes: record.conditionCodes,
    primaryConditionCode: record.primaryConditionCode,
  });
  return {
    id: record.id,
    submittedAt: record.submittedAt,
    caseReference: sqlIntakeCaseReference(record.id, record.submittedAt),
    displayStatus: pendingEnquiryDisplayStatus(record.followUpStatus),
    sourceType: sourceType ?? 'legacy_pharmacy_qr' as const,
    firstName: record.firstName,
    surname: record.surname,
    dob: record.dob,
    email: record.email,
    mobile: record.mobile,
    postcode: record.postcode,
    conditions: fromForm.map(condition => condition.conditionCode),
    primaryCondition: primaryConditionCode(fromForm),
    triedTwoTreatments: record.triedTwoTreatments ?? null,
    psychiatricExclusion: record.psychiatricExclusion ?? null,
    heardAbout: record.heardAbout ?? null,
  };
}

export function toPortalPatient(patient: PatientRecord) {
  const fromForm = formConditionRecords({
    conditionCodes: patient.sourceSubmission?.conditionCodes,
    primaryConditionCode: patient.sourceSubmission?.primaryConditionCode,
    conditions: patient.conditions,
  });
  const conditions = fromForm.map(condition => condition.conditionCode);
  const primary = primaryConditionCode(fromForm);
  const source = patient.sourceSubmission;
  return {
    id: patient.id,
    organisationId: patient.organisationId,
    firstName: patient.firstName,
    surname: patient.surname,
    dob: patient.dob,
    email: patient.email,
    mobile: patient.mobile,
    address: patient.address ?? '',
    postcode: patient.postcode,
    status: lower(patient.status),
    conditions,
    primaryCondition: primary,
    referralSource: source?.sourceType ? portalSourceType(source.sourceType) : null,
    triedTwoTreatments: source?.triedTwoTreatments ?? null,
    psychiatricExclusion: source?.psychiatricExclusion ?? null,
    heardAbout: source?.heardAbout ?? null,
    marketingConsent: source?.marketingConsent ?? null,
    createdAt: patient.createdAt,
    updatedAt: patient.updatedAt,
  };
}

export function buildPharmacyPatientDirectory(input: {
  patients: PatientRecord[];
  pendingEnquiries: TenantPendingEnquiryRecord[];
}) {
  return {
    patients: input.patients.map(toPortalPatient),
    enquiries: input.pendingEnquiries.map(toPortalPendingEnquiry),
    counts: {
      patients: input.patients.length,
      pendingEnquiries: input.pendingEnquiries.length,
      referred: input.patients.filter(patient => patient.status === 'REFERRED').length,
      active: input.patients.filter(patient => patient.status === 'ACTIVE').length,
    },
  };
}

export type PortalSqlLine = {
  packId: string;
  productId?: string;
  /** Internal ownership key used while mapping an order; not returned to the portal. */
  prescriptionId?: string;
  formulaId?: string;
  name?: string;
  quantity: number;
  unitPricePence?: number;
  wholesalePackPricePence?: number;
};

type PortalMappedLine = {
  productId: string;
  formulaId: string;
  packId: string;
  name: string;
  quantity: number;
  unitPricePence: number;
  wholesalePackPricePence?: number;
  prescriptionId?: string;
  localPrescriptionId?: string;
};

export type PortalOrderSource = OrderRecord & {
  curaleaf?: any;
  sqlRefund?: Record<string, unknown> | null;
  sqlLines?: PortalSqlLine[] | null;
  sqlQuoteChecks?: QuoteCheckRecord[] | null;
  sqlPaymentAllocation?: PaymentAllocationRecord | null;
};

export function toPortalOrder(order: PortalOrderSource) {
  const snapshot = (order.quoteSnapshot ?? {}) as any;
  const storedQuoteChecks = Array.isArray(order.sqlQuoteChecks) && order.sqlQuoteChecks.length > 0
    ? order.sqlQuoteChecks
    : Array.isArray(snapshot.quoteChecks) ? snapshot.quoteChecks : [];
  const paymentQuote = snapshot.paymentQuote && typeof snapshot.paymentQuote === 'object' ? snapshot.paymentQuote : null;
  const reviewQuoteCheck = snapshot.quoteReview?.quoteCheckId ? {
    id: snapshot.quoteReview.quoteCheckId,
    phase: 'POST_PAYMENT',
    status: snapshot.quoteReview.type === 'out_of_stock' ? 'OUT_OF_STOCK' : snapshot.quoteReview.status === 'recreate_required' ? 'RECONCILIATION_REQUIRED' : 'CHANGED',
    checkedAt: snapshot.quoteReview.checkedAt,
    basketFingerprint: snapshot.paymentQuote?.basketFingerprint || '',
    comparedWithQuoteCheckId: snapshot.quoteReview.baselineQuoteCheckId ?? null,
    patientTotalPence: Number(snapshot.paymentQuote?.patientTotalPence || order.totalPence || 0),
    wholesaleTotalPence: Number(snapshot.paymentQuote?.wholesaleTotalPence || 0),
    shippingPence: 0,
    patientDeltaPence: Number(snapshot.quoteReview.patientDeltaPence || 0),
    stockAvailable: snapshot.quoteReview.type !== 'out_of_stock',
  } : null;
  const quoteChecks = [
    ...(paymentQuote?.id ? [{
      id: paymentQuote.id,
      phase: 'PRE_PAYMENT',
      status: paymentQuote.status === 'MATCHED' ? 'MATCHED' : paymentQuote.status === 'OUT_OF_STOCK' ? 'OUT_OF_STOCK' : 'RECONCILIATION_REQUIRED',
      checkedAt: paymentQuote.checkedAt,
      basketFingerprint: paymentQuote.basketFingerprint || '',
      comparedWithQuoteCheckId: null,
      patientTotalPence: Number(paymentQuote.patientTotalPence || order.totalPence || 0),
      wholesaleTotalPence: Number(paymentQuote.wholesaleTotalPence || 0),
      shippingPence: Number(paymentQuote.shippingPence || 0),
      stockAvailable: paymentQuote.status !== 'OUT_OF_STOCK',
    }] : []),
    ...storedQuoteChecks.map((check: any) => ({
      id: String(check.id || ''),
      phase: String(check.phase || 'REPLACEMENT'),
      status: check.status === 'MATCHED' ? 'MATCHED'
        : check.status === 'OUT_OF_STOCK' ? 'OUT_OF_STOCK'
          : check.status === 'RECONCILIATION_REQUIRED' ? 'RECONCILIATION_REQUIRED'
            : check.status === 'ABSORBED' ? 'ABSORBED'
              : check.status === 'CANCELLED' ? 'CANCELLED'
            : 'CHANGED',
      checkedAt: String(check.checkedAt || check.createdAt || order.updatedAt),
      basketFingerprint: String(check.basketFingerprint || ''),
      comparedWithQuoteCheckId: check.baselineQuoteCheckId ?? null,
      patientTotalPence: Number(check.patientTotalPence || order.totalPence || 0),
      wholesaleTotalPence: Number(check.wholesaleTotalPence || 0),
      shippingPence: Number(check.shippingPence || 0),
      patientDeltaPence: Number(check.comparison?.patientDeltaPence ?? check.comparison?.signedAdjustmentPence ?? 0),
      wholesaleDeltaPence: Number(check.comparison?.wholesaleDeltaPence || 0),
      stockAvailable: check.status !== 'OUT_OF_STOCK',
    })),
    ...(reviewQuoteCheck ? [reviewQuoteCheck] : []),
  ].filter((check, index, rows) => check.id && rows.findIndex(candidate => candidate.id === check.id) === index);
  const storedAllocation = order.sqlPaymentAllocation
    ?? (snapshot.paymentAllocation && typeof snapshot.paymentAllocation === 'object'
      ? snapshot.paymentAllocation
      : null);
  const persistedCuraleaf = snapshot?.curaleaf && typeof snapshot.curaleaf === 'object' ? snapshot.curaleaf : null;
  const po = order.curaleaf || persistedCuraleaf;
  const isHhhCancelled = order.status === 'CANCELLED';
  const snapshotCuraleafCancellation = snapshot?.curaleafCancellation && typeof snapshot.curaleafCancellation === 'object'
    ? snapshot.curaleafCancellation
    : null;
  const hasSupplierCancellationReference = Boolean(
    po?.purchaseOrderId
    || po?.prescriptionId
    || snapshotCuraleafCancellation?.purchaseOrderId
    || snapshotCuraleafCancellation?.prescriptionId,
  );
  const supplierCancellationConfirmed = snapshotCuraleafCancellation?.status === 'confirmed' && hasSupplierCancellationReference;
  const isSupplierCancelled = po?.state === 'CANCELLED'
    || po?.purchaseOrderState === 'CANCELLED'
    || po?.prescriptionState === 'CANCELLED'
    || supplierCancellationConfirmed;
  const supplierStillLive = !isSupplierCancelled
    && !supplierCancellationAlreadyConfirmed(snapshot)
    && curaleafRequiresSupplierCancel({ ...snapshot, curaleaf: po || persistedCuraleaf });
  const isCancelledOrder = isSupplierCancelled || (!supplierStillLive && isHhhCancelled);
  const moneyTaken = orderMoneyWasTaken(order);
  const existingRefund = supplierStillLive
    ? null
    : (order.sqlRefund && typeof order.sqlRefund === 'object' ? order.sqlRefund : null)
      ?? (snapshot?.refund && typeof snapshot.refund === 'object' ? snapshot.refund : null);
  const refundCompleted = moneyTaken && !supplierStillLive && (
    String(existingRefund?.status || '') === 'completed'
    || snapshotRefundCompleted(snapshot)
    || String(order.paymentStatus).toUpperCase() === 'REFUNDED'
  );
  const refundPrepared = moneyTaken && !supplierStillLive && (
    String(existingRefund?.status || '') === 'pending_confirmation'
    || String(order.paymentStatus).toUpperCase() === 'REFUND_REQUIRED'
  );
  const refund = moneyTaken && existingRefund?.status ? existingRefund : undefined;
  const storedCancellation = snapshot?.cancellation && typeof snapshot.cancellation === 'object'
    ? snapshot.cancellation
    : null;
  const cancellation = !moneyTaken && isHhhCancelled && storedCancellation
    ? { ...storedCancellation, status: 'cancelled' }
    : storedCancellation ?? undefined;
  const curaleafCancellation = snapshotCuraleafCancellation
    && (snapshotCuraleafCancellation.status !== 'confirmed' || hasSupplierCancellationReference)
    ? snapshotCuraleafCancellation
    : undefined;
  const isPaid = moneyTaken && !refundCompleted && !isCancelledOrder && !refundPrepared;
  const quoteReview = snapshot?.quoteReview && typeof snapshot.quoteReview === 'object' && !isSupplierCancelled
    ? snapshot.quoteReview
    : undefined;
  const reviewBlocking = Boolean(quoteReview && ['required', 'awaiting_top_up', 'awaiting_refund'].includes(String(quoteReview.status)));
  const purchaseOrderId = realPurchaseOrderId(po, order);
  const hasPurchaseOrderRecord = Boolean((purchaseOrderId || po?.shipments?.length) && !reviewBlocking);
  const prescriptionId = typeof po?.prescriptionId === 'string' && po.prescriptionId.trim() ? po.prescriptionId.trim() : null;
  const prescriberId = typeof po?.prescriberId === 'string' && po.prescriberId.trim() ? po.prescriberId.trim() : null;
  const hasClinicPlacement = Boolean(prescriptionId || prescriberId);
  const isSupplierFlowActive = isPaid && !reviewBlocking && (hasPurchaseOrderRecord || POST_PURCHASE_ORDER_FULFILMENT.has(order.fulfilmentStatus));
  const prescriptionState = asPrescriptionState(po?.prescriptionState)
    ?? (hasPurchaseOrderRecord ? 'ACTIVE' : prescriptionId ? 'PENDING' : undefined);
  const prescriberState = String(po?.prescriberState || '').toUpperCase();
  const supplierApprovalWaiting = !hasPurchaseOrderRecord && (
    prescriberState === 'UNVERIFIED'
    || prescriptionState === 'PENDING'
  );
  const supplierWaitingSince = supplierApprovalWaiting
    ? String(po?.waitingSince || snapshot?.curaleafAttention?.recordedAt || order.updatedAt || order.paidAt || order.createdAt)
    : '';
  const waitingSla = supplierWaitingSince ? curaleafWaitingSla(supplierWaitingSince) : null;
  const attention = snapshot?.curaleafAttention && typeof snapshot.curaleafAttention === 'object'
    ? snapshot.curaleafAttention
    : null;
  const waitingFor = String(po?.waitingFor || '');
  const attentionCode = String(attention?.code || '');
  const placementStage = hasPurchaseOrderRecord ? 'PLACED'
    : attention?.status === 'terminal' ? 'TERMINAL'
      : attentionCode.includes('UPLOAD') ? 'UPLOAD_CORRECTION_REQUIRED'
        : attention?.status === 'correction_required' ? 'CORRECTION_REQUIRED'
          : waitingFor === 'prescriber_verification' || prescriberState === 'UNVERIFIED' ? 'AWAITING_PRESCRIBER_VERIFICATION'
            : waitingFor === 'prescription_activation' || prescriptionState === 'PENDING' ? 'AWAITING_PRESCRIPTION_ACTIVATION'
              : isPaid ? 'CHECKING_PRESCRIBER'
                : 'AWAITING_PAYMENT';
  const firstPrescription = Array.isArray(snapshot?.prescriptions) ? snapshot.prescriptions[0] : null;
  const curaleafPlacement = (isPaid || hasClinicPlacement || attention) ? {
    route: firstPrescription?.clinicScanId ? 'CLINIC_BARCODE' : 'MANUAL_PRESCRIPTION',
    stage: placementStage,
    prescriberState: prescriberState || null,
    prescriptionState: prescriptionState ?? null,
    nextCheckAt: po?.nextCheckAt ?? null,
    attentionReason: attentionCode.includes('UPLOAD') ? 'image_reupload'
      : attention?.status === 'terminal' ? 'reconciliation'
        : attention?.status === 'correction_required' ? 'provider_correction'
          : waitingFor === 'prescriber_verification' ? 'prescriber_verification'
            : waitingFor === 'prescription_activation' ? 'prescription_activation'
              : null,
    supportReference: attention?.supportReference ?? null,
    waitingSince: supplierWaitingSince || null,
    slaDueAt: waitingSla?.dueAt ?? null,
    slaAlert: waitingSla?.alert ?? false,
    slaPolicy: waitingSla?.policy ?? null,
    updatedAt: String(attention?.recordedAt || po?.updatedAt || order.updatedAt),
  } : null;

  const poItems = (po?.items && Array.isArray(po.items)) ? po.items : [];
  const poItemMap = new Map<string, any>(poItems.map((it: any) => [String(it.productId || it.formulaId || ''), it]));

  const rawLines = (Array.isArray(order.sqlLines) && order.sqlLines.length > 0)
    ? order.sqlLines
    : (snapshot?.lineItems || snapshot?.items || []);
  const parsedQuote = parsedPaidQuote(snapshot);
  const quoteByPackId = new Map((parsedQuote?.items || []).map(item => [item.packId, item]));
  const pricingQuote = parsedQuote
    ? portalQuotePayload(parsedQuote)
    : (snapshot?.pricingQuote || snapshot?.quote || null);
  const rawPrescriptions = snapshot?.prescriptions || [];
  const multiRx = Array.isArray(rawPrescriptions) && rawPrescriptions.length > 1;

  const lineItemsWithOwnership: PortalMappedLine[] = Array.isArray(rawLines) && rawLines.length > 0 ? rawLines.map((item: any): PortalMappedLine => {
    const packId = String(item.packId || item.productId || item.id || '');
    const quote = quoteByPackId.get(packId);
    const poItem = poItemMap.get(packId);
    const sqlQty = Number(item.quantity ?? item.qty ?? item.count ?? 0);
    // The order-level supplier record is a legacy single-prescription summary. In a
    // multi-prescription order its pack quantity belongs only to its keyed placement.
    const rockyQty = multiRx ? 0 : Number(poItem?.packsOrderedCount || 0);
    const itemQty = Math.max(sqlQty, rockyQty) || 1;
    const rawTotal = order.totalPence ? Math.max(0, order.totalPence - (order.dispensingFeePence || 0) - (order.pharmacyDeliveryPence || 0)) : 0;
    const quotedPatientPence = quote && quote.patientPence > 0 ? quote.patientPence : 0;
    const snapshotPatientPence = Number(
      item.unitPricePence ||
      item.retailPence ||
      item.patientPackPricePence ||
      0,
    );
    const unitPricePence = Number(
      quotedPatientPence ||
      snapshotPatientPence ||
      (rawTotal && rawLines.length === 1 && itemQty > 0 ? Math.round(rawTotal / itemQty) : 0),
    );
    const wholesalePackPricePence = lineWholesalePence(item, quote);

    return {
      productId: String(item.productId || item.packId || item.id || ''),
      formulaId: String(item.formulaId || poItem?.formulaId || ''),
      packId,
      name: String(item.name || item.formulaName || (quote ? 'Curaleaf medicine' : 'Curaleaf prescription item')),
      quantity: itemQty,
      unitPricePence,
      prescriptionId: typeof item.prescriptionId === 'string' ? item.prescriptionId : undefined,
      localPrescriptionId: typeof item.localPrescriptionId === 'string' ? item.localPrescriptionId : undefined,
      ...(wholesalePackPricePence != null ? { wholesalePackPricePence } : {}),
    };
  }) : poItems.map((poIt: any): PortalMappedLine => {
    const packId = String(poIt.productId || '');
    const quote = quoteByPackId.get(packId);
    const wholesalePackPricePence = quote && quote.wholesalePence > 0 ? quote.wholesalePence : undefined;
    return {
      productId: poIt.productId,
      formulaId: poIt.formulaId,
      packId: poIt.productId,
      name: 'Curaleaf medicine',
      quantity: Number(poIt.packsOrderedCount || 1),
      unitPricePence: Number(poIt.packsOrderedCount ? Math.round(Number(order.totalPence || 0) / Number(poIt.packsOrderedCount)) : Number(order.totalPence || 0)),
      ...(wholesalePackPricePence != null ? { wholesalePackPricePence } : {}),
    };
  });

  const lineItems = lineItemsWithOwnership.map(({ prescriptionId: _prescriptionId, localPrescriptionId: _localPrescriptionId, ...item }) => item);
  const hasExplicitLineOwnership = lineItemsWithOwnership.some(item => item.prescriptionId || item.localPrescriptionId);
  const prescriptions = Array.isArray(rawPrescriptions) && rawPrescriptions.length > 0 ? rawPrescriptions.map((rx: any, index: number) => {
    const rxKey = snapshotRxKey(rx && typeof rx === 'object' ? rx : {}, index);
    const sub = snapshot?.curaleafSubOrders && typeof snapshot.curaleafSubOrders === 'object'
      ? (snapshot.curaleafSubOrders as Record<string, any>)[rxKey]
      : null;
    const snapshotLines = Array.isArray(snapshot?.lineItems) ? snapshot.lineItems as Array<Record<string, unknown>> : [];
    const localId = String(rx?.clientKey ?? rx?.id ?? '');
    const sqlId = String(rx?.hhhPrescriptionId ?? '');
    const attributed = lineItemsWithOwnership.filter(line => (
      (sqlId && line.prescriptionId === sqlId)
      || (localId && line.localPrescriptionId === localId)
    ));
    const snapshotAttributed = snapshotLines.filter(line => String(line.localPrescriptionId || '') === localId);
    const packIds = new Set(
      (snapshotAttributed.length ? snapshotAttributed : Array.isArray(rx?.items) ? rx.items : []).map((item: any) => String(item.packId || item.productId || '')).filter(Boolean),
    );
    const prescriptionItems = Array.isArray(rx?.items) ? rx.items as Array<Record<string, unknown>> : [];
    const reconstructed = !hasExplicitLineOwnership && prescriptionItems.length
      ? prescriptionItems.map(item => {
        const packId = String(item.packId || item.productId || '');
        const priced = lineItems.find(line => line.packId === packId || line.productId === packId);
        return {
          ...(priced ?? {}),
          productId: String(item.productId || item.packId || priced?.productId || ''),
          formulaId: String(item.formulaId || priced?.formulaId || ''),
          packId,
          name: String(item.name || priced?.name || 'Curaleaf prescription item'),
          quantity: Number(item.quantity ?? item.qty ?? item.count ?? priced?.quantity ?? 1),
        };
      })
      : [];
    const legacyByPack = !hasExplicitLineOwnership && !reconstructed.length && packIds.size
      ? lineItems.filter((item: { packId: string; productId: string }) => packIds.has(item.packId) || packIds.has(item.productId))
      : [];
    const ownItems = attributed.length ? attributed.map(({ prescriptionId: _prescriptionId, localPrescriptionId: _localPrescriptionId, ...item }) => item) : (reconstructed.length ? reconstructed : legacyByPack);
    return {
      ...rx,
      curaleafPrescriptionId: rx.curaleafPrescriptionId || sub?.prescriptionId || (!multiRx ? (prescriptionId || persistedCuraleaf?.prescriptionId || null) : null),
      items: ownItems.length ? ownItems : (!multiRx ? lineItems : []),
    };
  }) : (lineItems.length > 0 ? [{
    clientKey: `legacy-rx-${order.id.slice(0, 8)}`,
    fileId: '',
    curaleafPrescriptionId: prescriptionId || persistedCuraleaf?.prescriptionId || null,
    serialNumber: `RX-${order.orderNumber || order.id.slice(0, 8)}`,
    issueDate: order.submittedAt ? order.submittedAt.split('T')[0] : new Date().toISOString().split('T')[0],
    prescriber: {
      id: 'prescriber-default',
      name: 'Dr. S. Patel',
      gphcNumber: '2078912',
    },
    items: lineItems,
  }] : []);

  // Build prescriptionFlow with live pack quantities (ordered, allocated, shipped, awaiting shipment)
  const shipments = Array.isArray(po?.shipments) ? po.shipments : (Array.isArray(persistedCuraleaf?.shipments) ? persistedCuraleaf.shipments : []);
  const requestedItems = lineItems.map((item: { packId: string; productId: string; quantity: number }) => ({ packId: item.packId || item.productId, productId: item.productId, quantity: item.quantity }));
  const priorLines = mergePriorPharmacyLines(
    po?.lines,
    persistedCuraleaf?.lines,
    Object.values(snapshot?.prescriptionFlow || {}).flatMap((flow: any) => Array.isArray(flow?.lines) ? flow.lines : []),
  );
  const lines = isSupplierFlowActive ? normalisedFulfilmentLines({
    purchaseOrder: po,
    shipments,
    requestedItems,
    priorLines,
  }) : [];
  const dispatchStatus = dispatchStatusFromLines(shipments, lines);
  const hasCheckedInPacks = lines.some(line => line.received > 0 || line.collected > 0);
  const hasInTransitPacks = lines.some(line => line.shipped > line.received);
  const supplierComputed = supplierFulfilmentStatus({ purchaseOrder: po, shipments, lines });
  const rawComputedFulfilment = advanceFulfilmentStatus(
    order.fulfilmentStatus,
    supplierComputed,
  );
  const computedFulfilment = !hasCheckedInPacks && hasInTransitPacks
    ? (lines.some(line => line.remaining > 0) ? 'PARTIALLY_DISPATCHED_TO_PHARMACY' : 'DISPATCHED_TO_PHARMACY')
    : rawComputedFulfilment;
  /*
   * Supply completeness and collection are different questions. Packs verified onto the
   * dispensary shelf are ready to hand out, not stock the supplier still owes — so an
   * uncollected pack must not read as an open remainder. Including `collected < ordered`
   * here meant every fully checked-in order reported `partially_received` until the
   * patient walked in, so nothing ever reached the ready-to-collect queue.
   */
  const remainingOpenAfterGoodsIn = hasCheckedInPacks
    && lines.some(line => line.remaining > 0 || line.received < line.ordered);
  const shipmentIds = (po?.shipmentIds ?? persistedCuraleaf?.shipmentIds ?? shipments.map((s: any) => s.id)).filter(Boolean);
  const shipmentStates = {
    ...(persistedCuraleaf?.shipmentStates && typeof persistedCuraleaf.shipmentStates === 'object' ? persistedCuraleaf.shipmentStates : {}),
    ...(po?.shipmentStates && typeof po.shipmentStates === 'object' ? po.shipmentStates : {}),
  };
  const placedAt = po?.createdAt || po?.issuedDate || order.paidAt || order.submittedAt || order.createdAt;
  const latestShipmentAt = latestShipmentCreatedAt(shipments);
  const subOrders = curaleafSubOrders(snapshot);
  const hasNamedSubOrders = Object.keys(subOrders).length > 0;
  const prescriptionFlow: Record<string, any> = {};
  for (const [index, rx] of prescriptions.entries()) {
    const rxRecord = rx && typeof rx === 'object' ? rx as Record<string, unknown> : {};
    const rxKey = snapshotRxKey(rxRecord, index);
    const packIds = new Set(packIdsForRx(rxRecord));
    const sub = subOrders[rxKey] ?? null;
    const overlappingLines = filterRecordsByPackIds(lines, packIds);
    const poPackIds = new Set(
      ([
        ...(Array.isArray(po?.items) ? po.items : []),
        ...(Array.isArray(po?.lines) ? po.lines : []),
      ] as Array<{ packId?: unknown; productId?: unknown }>)
        .map(row => packIdFromRecord(row))
        .filter(Boolean),
    );
    const overlappingPoLines = poPackIds.size
      ? overlappingLines.filter(line => poPackIds.has(packIdFromRecord(line)))
      : overlappingLines;
    const legacySharedPo = multiRx && !hasNamedSubOrders && Boolean(purchaseOrderId) && overlappingPoLines.length > 0;
    const rxPurchaseOrderId = typeof sub?.purchaseOrderId === 'string' && sub.purchaseOrderId.trim()
      ? sub.purchaseOrderId.trim()
      : (!multiRx ? purchaseOrderId : (legacySharedPo ? purchaseOrderId : null));
    const rxHasPo = Boolean(rxPurchaseOrderId);
    const subShipments: CuraleafShipmentLike[] = Array.isArray(sub?.shipments) ? sub.shipments : [];
    const sourceShipments: CuraleafShipmentLike[] = subShipments.length
      ? subShipments
      : Array.isArray(shipments) ? shipments : [];
    const ownRequestedItems = (Array.isArray(rxRecord.items) ? rxRecord.items : []).flatMap(item => {
      const record = item && typeof item === 'object' ? item as Record<string, unknown> : {};
      const packId = packIdFromRecord(record);
      const quantity = Number(record.quantity ?? record.qty ?? record.count ?? 0);
      return packId && quantity > 0 ? [{ packId, productId: packId, quantity }] : [];
    });
    const subLines = sub && rxHasPo ? normalisedFulfilmentLines({
      purchaseOrder: sub,
      shipments: sourceShipments,
      requestedItems: ownRequestedItems,
      priorLines: Array.isArray(sub.lines) ? sub.lines : [],
    }) : [];
    const rxLines = !rxHasPo
      ? []
      : subLines.length
        ? subLines
        : (multiRx ? (legacySharedPo ? overlappingPoLines : overlappingLines) : lines);
    const rxShipments: CuraleafShipmentLike[] = !rxHasPo
      ? []
      : (multiRx
        ? sourceShipments.filter(shipment => {
          const items = Array.isArray(shipment.items) ? shipment.items : [];
          if (!items.length) return false;
          return items.some(item => packIds.has(packIdFromRecord(item)));
        }).map(shipment => {
          const items = Array.isArray(shipment.items) ? shipment.items : [];
          return {
            ...shipment,
            items: filterRecordsByPackIds(items, packIds),
          };
        })
        : sourceShipments);
    const rxShipmentIds = rxHasPo
      ? (multiRx
        ? rxShipments.map(shipment => String(shipment.id || '').trim()).filter(Boolean)
        : shipmentIds)
      : [];
    const rxShipmentStates = Object.fromEntries(
      Object.entries(shipmentStates).filter(([id]) => rxShipmentIds.includes(id)),
    );
    const rxCheckedIn = rxLines.some(line => Number(line.received || 0) > 0 || Number(line.collected || 0) > 0);
    const rxRemainingOpen = rxCheckedIn && rxLines.some(line => Number(line.remaining || 0) > 0 || Number(line.received || 0) < Number(line.ordered || 0));
    const rxDispatch = rxHasPo ? dispatchStatusFromLines(rxShipments, rxLines) : dispatchStatus;
    prescriptionFlow[rxKey] = {
      id: rxKey,
      orderId: rxKey,
      state: reviewBlocking && quoteReview?.type === 'out_of_stock' ? 'HELD_STOCK'
        : reviewBlocking ? 'HELD_PRICE'
        : !rxHasPo
          ? (isPaid ? 'PENDING_PLACEMENT' : 'AWAITING_PAYMENT')
        : isSupplierCancelled ? 'CANCELLED_PURCHASE_ORDER'
        : rxCheckedIn && order.fulfilmentStatus === 'COLLECTED' ? 'COLLECTED'
        : rxCheckedIn && order.fulfilmentStatus === 'READY_FOR_COLLECTION' ? 'READY_FOR_COLLECTION'
        : rxRemainingOpen ? 'PARTIALLY_RECEIVED'
        : rxCheckedIn && order.fulfilmentStatus === 'RECEIVED' ? 'RECEIVED'
        : rxCheckedIn && (order.fulfilmentStatus === 'PARTIALLY_RECEIVED' || computedFulfilment === 'PARTIALLY_RECEIVED') ? 'PARTIALLY_RECEIVED'
        : 'PLACED',
      lines: rxLines,
      shipmentIds: rxShipmentIds,
      shipmentStates: rxShipmentStates,
      dispatchStatus: rxDispatch,
      quantityMismatch: rxLines.some(line => Boolean(line.quantityMismatch)),
      purchaseOrderId: rxPurchaseOrderId,
      placedAt: rxHasPo ? (sub?.createdAt || sub?.issuedDate || placedAt) : null,
      latestShipmentAt: rxHasPo ? latestShipmentCreatedAt(rxShipments) : null,
      goodsInAt: rxCheckedIn ? (sub?.goodsInAt ?? persistedCuraleaf?.goodsInAt ?? po?.goodsInAt ?? null) : null,
    };
  }

  const portalFulfilment = isCancelledOrder
    ? 'cancelled'
    : hasCheckedInPacks && order.fulfilmentStatus === 'READY_FOR_COLLECTION' ? 'ready_for_collection'
    : remainingOpenAfterGoodsIn ? 'partially_received'
    : hasCheckedInPacks && order.fulfilmentStatus === 'RECEIVED' ? 'received'
    : hasCheckedInPacks && (order.fulfilmentStatus === 'PARTIALLY_RECEIVED' || computedFulfilment === 'PARTIALLY_RECEIVED') ? 'partially_received'
    : computedFulfilment === 'PARTIALLY_DISPATCHED_TO_PHARMACY' ? 'partially_dispatched_to_pharmacy'
    : computedFulfilment === 'DISPATCHED_TO_PHARMACY' ? 'dispatched_to_pharmacy'
    : computedFulfilment === 'PARTIALLY_RECEIVED' && hasCheckedInPacks ? 'partially_received'
    : computedFulfilment === 'SUPPLIER_ALLOCATED' ? 'supplier_allocated'
    : !hasCheckedInPacks && hasInTransitPacks
      ? (lines.some(line => line.remaining > 0) ? 'partially_dispatched_to_pharmacy' : 'dispatched_to_pharmacy')
    : !hasCheckedInPacks && ['ready_for_collection', 'received', 'partially_received'].includes(lower(order.fulfilmentStatus))
      ? (lines.some(line => line.remaining > 0) ? 'partially_dispatched_to_pharmacy' : 'dispatched_to_pharmacy')
    : hasClinicPlacement && isPaid && !hasPurchaseOrderRecord ? 'supplier_pending'
    : lower(order.fulfilmentStatus);

  const clinicPlacementStatus = prescriptionState === 'EXPIRED' || prescriptionState === 'CANCELLED'
    ? 'prescription_closed' as const
    : 'prescription_pending' as const;
  const curaleaf = isSupplierCancelled && hasPurchaseOrderRecord ? {
    status: 'prescription_closed' as const,
    prescriptionState,
    prescriptionId: prescriptionId ?? undefined,
    prescriberId: prescriberId ?? undefined,
    customerReference: po?.customerReference || order.orderNumber || order.id,
    purchaseOrderId,
    purchaseOrderState: 'CANCELLED' as const,
  } : isPaid && reviewBlocking ? {
    status: 'quote_review_required' as const,
    prescriptionState,
    prescriptionId: prescriptionId ?? undefined,
    prescriberId: prescriberId ?? undefined,
    customerReference: order.orderNumber || order.id,
    purchaseOrderId: null,
    purchaseOrderState: null,
  } : (isPaid || hasPurchaseOrderRecord) && !reviewBlocking && hasPurchaseOrderRecord ? {
    status: 'purchase_order_submitted' as const,
    prescriptionState,
    prescriptionId: prescriptionId ?? undefined,
    prescriberId: prescriberId ?? undefined,
    customerReference: po?.customerReference || order.orderNumber || order.id,
    purchaseOrderId,
    purchaseOrderState: po?.state || po?.purchaseOrderState || 'CREATED',
    courier: po?.courier ?? undefined,
    shippingAddress: po?.shippingAddress ?? undefined,
    issuedDate: po?.issuedDate ?? null,
    createdAt: po?.createdAt ?? null,
    shipments,
    shipmentIds,
    shipmentStates,
    dispatchStatus,
    quantityMismatch: lines.some(line => line.quantityMismatch),
    lines,
    supplierItems: (Array.isArray(po?.supplierItems) ? po.supplierItems : poItems).map((item: any) => ({
      productId: item.productId ?? null,
      packsOrderedCount: Number(item.packsOrderedCount || item.count || 0),
      packsAllocatedCount: Number(item.packsAllocatedCount || 0),
      packsReturnedCount: Number(item.packsReturnedCount || 0),
    })),
    quote: pricingQuote ?? undefined,
    items: po?.items,
  } : isPaid && hasClinicPlacement ? {
    status: clinicPlacementStatus,
    prescriptionState,
    prescriptionId: prescriptionId ?? undefined,
    prescriberId: prescriberId ?? undefined,
    customerReference: order.orderNumber || order.id,
    purchaseOrderId: null,
    purchaseOrderState: null,
    ...(waitingSla ? { waitingSla } : {}),
  } : undefined;

  return {
    id: order.id,
    orderNumber: order.orderNumber ?? undefined,
    organisationId: order.organisationId,
    patientId: order.patientId,
    lineItems,
    prescriptions,
    prescriptionFlow,
    pricingQuote: pricingQuote ?? undefined,
    medicineTotalPence: Number(order.medicineTotalPence),
    dispensingFeePence: Number(order.dispensingFeePence),
    pharmacyDeliveryPence: Number(order.pharmacyDeliveryPence),
    deliveryPence: Number(order.deliveryPence),
    totalPence: Number(order.totalPence),
    currency: order.currency === 'GBP' ? 'GBP' as const : 'GBP' as const,
    paymentRoute: lower(order.paymentRoute) === 'worldpay' ? 'worldpay' as const : 'manual' as const,
    paymentStatus: refundCompleted
      ? 'refunded'
      : refundPrepared
        ? 'refund_required'
        : moneyTaken
          ? 'paid'
          : isHhhCancelled || order.paymentStatus === 'CANCELLED'
            ? 'cancelled'
            : lower(order.paymentStatus),
    fulfilmentStatus: portalFulfilment,
    status: isCancelledOrder ? 'cancelled' : supplierStillLive || (isPaid && order.status === 'SUBMITTED') ? 'processing' : lower(order.status),
    paidAt: order.paidAt,
    curaleafApprovedAt: po?.createdAt || po?.issuedDate || undefined,
    auditEvents: Array.isArray(snapshot?.auditEvents)
      ? snapshot.auditEvents.filter((event: unknown) => event && typeof event === 'object')
      : undefined,
    autoPlacementEnabled: true,
    curaleaf,
    curaleafSubOrders: snapshot?.curaleafSubOrders && typeof snapshot.curaleafSubOrders === 'object'
      ? snapshot.curaleafSubOrders
      : undefined,
    curaleafPlacement,
    quoteReview,
    quoteChecks,
    activeQuoteCheck: quoteChecks.at(-1) ?? null,
    paymentAllocation: storedAllocation ? {
      id: String(storedAllocation.id || ''),
      paymentId: String(storedAllocation.paymentId || ''),
      amountPence: Number(storedAllocation.amountPence || 0),
      status: String(storedAllocation.status || 'ACTIVE').toUpperCase(),
      sourceOrderId: storedAllocation.sourceOrderId ?? null,
      replacementOrderId: storedAllocation.replacementOrderId ?? order.id,
      updatedAt: String(storedAllocation.updatedAt || order.updatedAt),
    } : null,
    resolution: order.resolutionStatus === 'RESOLVED' ? {
      status: order.resolutionReason === 'REPLACED' ? 'REPLACED' : order.paymentStatus === 'REFUNDED' ? 'REFUNDED' : 'SPLIT_RESOLVED',
      reason: order.resolutionReason === 'REPLACED' ? 'REPLACED' : order.paymentStatus === 'REFUNDED' ? 'REFUNDED' : 'SPLIT_RESOLVED',
      resolvedAt: order.resolvedAt ?? null,
      archivedAt: order.archivedAt ?? null,
    } : snapshot.resolution ?? null,
    redoOfOrderId: order.redoOfId ?? null,
    redoContext: snapshot.redoContext ?? undefined,
    serialReuse: Array.isArray(rawPrescriptions) && rawPrescriptions[0] ? {
      until: serialReuseUntilDate(String((rawPrescriptions[0] as { issueDate?: string }).issueDate || '')) ?? null,
      filePresent: Boolean((rawPrescriptions[0] as { fileId?: string | null }).fileId),
    } : null,
    pharmacyContributionPence: Number(snapshot?.pharmacyContributionPence || quoteReview?.pharmacyContributionPence || 0) || undefined,
    cancellation: supplierStillLive ? undefined : cancellation,
    curaleafCancellation: supplierStillLive ? undefined : curaleafCancellation,
    refund,
    unresolvedReason: isSupplierCancelled ? 'cancelled' : undefined,
    createdAt: order.createdAt,
    updatedAt: order.updatedAt,
  };
}

export function toPortalOrderDraft(draft: OrderDraftRecord) {
  return {
    id: draft.id,
    organisationId: draft.organisationId,
    patientId: draft.patientId,
    status: 'draft' as const,
    pharmacyDeliveryEnabledAtCreation: Boolean(draft.pharmacyDeliveryEnabledAtCreation),
    payload: draft.payload && typeof draft.payload === 'object' && !Array.isArray(draft.payload)
      ? draft.payload as Record<string, unknown>
      : {},
    createdAt: draft.createdAt,
    updatedAt: draft.updatedAt,
  };
}

function isCancelled(order: PortalOrder) {
  return order.status === 'cancelled' || order.paymentStatus === 'cancelled';
}

function isAwaitingPayment(order: PortalOrder) {
  return ['pending', 'awaiting_manual_payment'].includes(order.paymentStatus);
}

function isSupplierFlow(order: PortalOrder) {
  return [
    'supplier_pending',
    'supplier_processing',
    'supplier_allocated',
    'partially_dispatched_to_pharmacy',
    'dispatched_to_pharmacy',
    'partially_received',
    'received',
  ].includes(order.fulfilmentStatus);
}

export type OverviewIntegrationConnection = {
  integration: 'CURALEAF' | 'WORLDPAY';
  environment: 'TEST' | 'PRODUCTION';
  status: 'DISCONNECTED' | 'PENDING_VALIDATION' | 'ACTIVE' | 'PAUSED' | 'ERROR';
  secretResourceName: string | null;
  lastSuccessfulAt: string | null;
  validatedAt: string | null;
};

/**
 * Integration health for the Overview.
 *
 * `connected` means one thing only: the last real call to the vendor succeeded, and
 * `checkedAt` says when. Credentials sitting in Secret Manager are not evidence that
 * the integration works — a rotated key, a revoked customer id or a vendor outage all
 * leave the stored credential untouched. Reporting those as Connected with "no recent
 * check" underneath told pharmacy staff the supply chain was healthy while orders were
 * failing to place, so anything unverified is reported as `degraded` instead.
 *
 * The state vocabulary stays fixed at connected / degraded / unavailable /
 * not-configured; `detail` carries the plain-language reason.
 */
export function overviewIntegrationHealth(connections: OverviewIntegrationConnection[] = []) {
  return (['CURALEAF', 'WORLDPAY'] as const).map(integration => {
    const connection = connections.find(item => item.integration === integration);
    const configured = Boolean(connection?.secretResourceName);
    const environment = !connection ? null : connection.environment === 'PRODUCTION' ? 'production' as const : 'test' as const;
    const name = integration.toLowerCase() as 'curaleaf' | 'worldpay';
    if (!configured) {
      return {
        integration: name,
        state: 'not-configured' as const,
        environment,
        checkedAt: null,
        detail: 'No credentials on file. HHH sets this up.',
      };
    }
    // Only a successful call counts as a check. `validatedAt` records when a credential
    // was accepted for storage, which is not the same as the vendor answering today.
    const checkedAt = connection!.lastSuccessfulAt ?? null;
    if (connection!.status === 'PAUSED') {
      return { integration: name, state: 'unavailable' as const, environment, checkedAt, detail: 'Paused by HHH.' };
    }
    if (connection!.status === 'ERROR') {
      return { integration: name, state: 'degraded' as const, environment, checkedAt, detail: 'The last attempt failed. HHH is notified.' };
    }
    if (!checkedAt) {
      return {
        integration: name,
        state: 'degraded' as const,
        environment,
        checkedAt: null,
        detail: 'Credentials stored but never confirmed with the supplier.',
      };
    }
    if (connection!.status === 'PENDING_VALIDATION') {
      return { integration: name, state: 'degraded' as const, environment, checkedAt, detail: 'Awaiting re-validation since the credential changed.' };
    }
    return { integration: name, state: 'connected' as const, environment, checkedAt, detail: 'Last call to the supplier succeeded.' };
  });
}

const REPEAT_GAP_DAYS = 30;
const FIRST_START_LIMIT = 12;
const REPEAT_START_LIMIT = 8;

function isLiveOrder(order: OrderRecord) {
  return order.status !== 'CANCELLED' && order.paymentStatus !== 'CANCELLED';
}

function isOpenOrder(order: OrderRecord) {
  return isLiveOrder(order) && order.fulfilmentStatus !== 'COLLECTED';
}

export function buildSqlPharmacyOverview(params: {
  organisation: OrganisationRecord;
  patients: PatientRecord[];
  orders: OrderRecord[];
  pendingEnquiries?: Array<{ submittedAt: string }>;
  connections?: OverviewIntegrationConnection[];
  /**
   * Rows from the one shared pharmacy ledger. Omitted only where the caller
   * genuinely cannot cost the orders (a repository outage), in which case the
   * money headline is left off rather than shown as zero — a pharmacy that
   * traded is never told it earned nothing.
   */
  financeRows?: Parameters<typeof overviewFinanceSnapshot>[0];
  now?: number;
}) {
  const now = params.now ?? Date.now();
  const patientById = new Map(params.patients.map(patient => [patient.id, patient]));
  const orders = params.orders.map(toPortalOrder);
  const pendingEnquiries = params.pendingEnquiries ?? [];
  const activeOrders = orders.filter(order => !isCancelled(order));
  const awaitingPayment = activeOrders.filter(isAwaitingPayment);
  const supplierOrders = activeOrders.filter(isSupplierFlow);
  const readyForCollection = activeOrders.filter(order => order.fulfilmentStatus === 'ready_for_collection');
  const priorityItems: Array<{
    id: string;
    kind: 'payment' | 'collection' | 'repeat';
    ageDays: number;
    maskedPatientLabel: string;
    orderReference: string;
    recordTarget: { kind: 'order' | 'patient'; id: string };
    summary: string;
    actionLabel: string;
  }> = [];

  for (const order of awaitingPayment) {
    const age = ageDays(timestamp(order.updatedAt, order.createdAt), now);
    priorityItems.push({
      id: `payment-${order.id}`,
      kind: 'payment',
      ageDays: age,
      maskedPatientLabel: overviewPatientLabel(patientById.get(order.patientId)),
      orderReference: overviewOrderReference(order),
      recordTarget: { kind: 'order', id: order.id },
      summary: age === 0
        ? 'Payment link sent today.'
        : `Payment outstanding for ${age} day${age === 1 ? '' : 's'}.`,
      actionLabel: 'Open order',
    });
  }

  for (const order of readyForCollection) {
    const age = ageDays(timestamp(order.updatedAt, order.createdAt), now);
    if (age < 10) continue;
    priorityItems.push({
      id: `collection-${order.id}`,
      kind: 'collection',
      ageDays: age,
      maskedPatientLabel: overviewPatientLabel(patientById.get(order.patientId)),
      orderReference: overviewOrderReference(order),
      recordTarget: { kind: 'order', id: order.id },
      summary: `Ready to collect for ${age} day${age === 1 ? '' : 's'}.`,
      actionLabel: 'Open order',
    });
  }

  priorityItems.sort((left, right) => right.ageDays - left.ageDays);
  const organisation = params.organisation;
  const activePatients = params.patients.filter(patient => patient.status === 'ACTIVE').length;

  return {
    asOf: new Date(now).toISOString(),
    organisation: {
      id: organisation.id,
      tradingName: organisation.tradingName,
      status: portalAccountStatus(organisation.status),
      trainingMode: false,
      allocationHoldingMode: organisation.classification === 'ALLOCATION_HOLDING',
    },
    enquiries: {
      pendingCount: pendingEnquiries.length,
      latestSubmittedAt: pendingEnquiries[0]?.submittedAt ?? null,
      state: pendingEnquiries.length ? 'hhh_reviewing' as const : 'none' as const,
    },
    summary: {
      activePatients,
      awaitingPayment: awaitingPayment.length,
      supplierFulfilment: supplierOrders.length,
      readyForCollection: readyForCollection.length,
      urgentTotal: priorityItems.length,
    },
    priorityItems,
    recentSessions: [],
    handover: {
      activePatients,
      activePaymentLinks: awaitingPayment.length,
      supplierOrdersInProgress: supplierOrders.length,
      agedCollections: priorityItems.filter(item => item.kind === 'collection').length,
    },
    finance: params.financeRows ? overviewFinanceSnapshot(params.financeRows, now) : null,
    integrations: overviewIntegrationHealth(params.connections),
  };
}
