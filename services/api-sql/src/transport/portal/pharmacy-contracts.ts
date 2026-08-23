import { paidQuoteFromSnapshot } from '../../application/orders/finance-costing.js';
import { orderMoneyWasTaken, snapshotRefundCompleted } from '../../application/orders/paid-refund.js';
import {
  advanceFulfilmentStatus,
  dispatchStatusFromLines,
  latestShipmentCreatedAt,
  mergePriorPharmacyLines,
  normalisedFulfilmentLines,
  supplierFulfilmentStatus,
} from '../../application/orders/curaleaf-fulfilment.js';
import { parseQuote, type ParsedQuote, type ParsedQuoteItem } from '../../application/orders/quote-review.js';
import { curaleafRequiresSupplierCancel, supplierCancellationAlreadyConfirmed } from '../../application/integrations/curaleaf-events.js';
import { organisationAddressSummary } from '../../repositories/ports/directory.port.js';
import type { OrderDraftRecord, OrderRecord } from '../../repositories/ports/order.port.js';
import type { OrganisationRecord } from '../../repositories/ports/organisation.port.js';
import type { PatientRecord } from '../../repositories/ports/patient.port.js';
import type { TenantPendingEnquiryRecord } from '../../repositories/ports/intake.port.js';
import { formConditionRecords, primaryConditionCode } from '../../domain/eligibility/form-conditions.js';
import { sqlIntakeCaseReference } from './intake-contracts.js';
import { pendingEnquiryDisplayStatus, portalSourceType } from './intake-source.js';

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
  if (typeof item.wholesalePackPricePence === 'number' && Number.isFinite(item.wholesalePackPricePence) && item.wholesalePackPricePence > 0) {
    return Math.round(item.wholesalePackPricePence);
  }
  const stamped = Number(item.wholesalePackPrice ?? item.wholesalePrice);
  if (Number.isFinite(stamped) && stamped > 0) return Math.round(stamped * 100);
  if (quoted && quoted.wholesalePence > 0) return quoted.wholesalePence;
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
  if (state === 'REJECTED') return 'CANCELLED';
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

function overviewOrderReference(order: { id: string; orderNumber?: string | null; paymentTransactionReference?: string | null }) {
  const number = order.orderNumber?.trim() || order.paymentTransactionReference?.trim();
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
  formulaId?: string;
  name?: string;
  quantity: number;
  unitPricePence?: number;
  wholesalePackPricePence?: number;
};

export type PortalOrderSource = OrderRecord & {
  curaleaf?: any;
  sqlRefund?: Record<string, unknown> | null;
  sqlLines?: PortalSqlLine[] | null;
};

export function toPortalOrder(order: PortalOrderSource) {
  const snapshot = (order.quoteSnapshot ?? {}) as any;
  const persistedCuraleaf = snapshot?.curaleaf && typeof snapshot.curaleaf === 'object' ? snapshot.curaleaf : null;
  const po = order.curaleaf || persistedCuraleaf;
  const isHhhCancelled = order.status === 'CANCELLED';
  const isSupplierCancelled = po?.state === 'CANCELLED' || po?.state === 'REJECTED'
    || po?.purchaseOrderState === 'CANCELLED' || po?.purchaseOrderState === 'REJECTED'
    || po?.prescriptionState === 'CANCELLED' || po?.prescriptionState === 'REJECTED'
    || snapshot?.curaleafCancellation?.status === 'confirmed';
  const supplierStillLive = !isSupplierCancelled
    && !supplierCancellationAlreadyConfirmed(snapshot)
    && curaleafRequiresSupplierCancel({ ...snapshot, curaleaf: po || persistedCuraleaf });
  const isCancelledOrder = isSupplierCancelled || (!supplierStillLive && isHhhCancelled);
  const moneyTaken = orderMoneyWasTaken(order);
  const existingRefund = supplierStillLive
    ? null
    : (order.sqlRefund && typeof order.sqlRefund === 'object' ? order.sqlRefund : null)
      ?? (snapshot?.refund && typeof snapshot.refund === 'object' ? snapshot.refund : null);
  const refundCompleted = !supplierStillLive && (
    String(existingRefund?.status || '') === 'completed'
    || snapshotRefundCompleted(snapshot)
    || String(order.paymentStatus).toUpperCase() === 'REFUNDED'
  );
  const refundPrepared = !supplierStillLive && (
    String(existingRefund?.status || '') === 'pending_confirmation'
    || String(order.paymentStatus).toUpperCase() === 'REFUND_REQUIRED'
  );
  const refund = existingRefund?.status ? existingRefund : undefined;
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

  const lineItems = Array.isArray(rawLines) && rawLines.length > 0 ? rawLines.map((item: any) => {
    const packId = String(item.packId || item.productId || item.id || '');
    const quote = quoteByPackId.get(packId);
    const poItem = poItemMap.get(packId);
    const sqlQty = Number(item.quantity ?? item.qty ?? item.count ?? 0);
    const rockyQty = Number(poItem?.packsOrderedCount || 0);
    const itemQty = Math.max(sqlQty, rockyQty) || 1;
    const rawTotal = order.totalPence ? Math.max(0, order.totalPence - (order.dispensingFeePence || 0)) : 0;
    const unitPricePence = Number(
      item.unitPricePence ||
      item.retailPence ||
      item.patientPackPricePence ||
      (quote && quote.patientPence > 0 ? quote.patientPence : 0) ||
      (rawTotal && rawLines.length === 1 && itemQty > 0 ? Math.round(rawTotal / itemQty) : 0)
    );
    const wholesalePackPricePence = lineWholesalePence(item, quote);

    return {
      productId: String(item.productId || item.packId || item.id || ''),
      formulaId: String(item.formulaId || poItem?.formulaId || ''),
      packId,
      name: String(item.name || item.formulaName || (quote ? 'Curaleaf medication' : 'Curaleaf prescription item')),
      quantity: itemQty,
      unitPricePence,
      ...(wholesalePackPricePence != null ? { wholesalePackPricePence } : {}),
    };
  }) : poItems.map((poIt: any) => {
    const packId = String(poIt.productId || '');
    const quote = quoteByPackId.get(packId);
    const wholesalePackPricePence = quote && quote.wholesalePence > 0 ? quote.wholesalePence : undefined;
    return {
      productId: poIt.productId,
      formulaId: poIt.formulaId,
      packId: poIt.productId,
      name: 'Curaleaf medication',
      quantity: Number(poIt.packsOrderedCount || 1),
      unitPricePence: Number(poIt.packsOrderedCount ? Math.round(Number(order.totalPence || 0) / Number(poIt.packsOrderedCount)) : Number(order.totalPence || 0)),
      ...(wholesalePackPricePence != null ? { wholesalePackPricePence } : {}),
    };
  });

  const rawPrescriptions = snapshot?.prescriptions || [];
  const prescriptions = Array.isArray(rawPrescriptions) && rawPrescriptions.length > 0 ? rawPrescriptions.map((rx: any) => ({
    ...rx,
    curaleafPrescriptionId: rx.curaleafPrescriptionId || prescriptionId || persistedCuraleaf?.prescriptionId || null,
    items: lineItems,
  })) : (lineItems.length > 0 ? [{
    id: `rx-${order.id.slice(0, 8)}`,
    fileId: `rx-${order.id.slice(0, 8)}`,
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
  const remainingOpenAfterGoodsIn = hasCheckedInPacks
    && lines.some(line => line.remaining > 0 || line.received < line.ordered || line.collected < line.ordered);
  const shipmentIds = (po?.shipmentIds ?? persistedCuraleaf?.shipmentIds ?? shipments.map((s: any) => s.id)).filter(Boolean);
  const shipmentStates = {
    ...(persistedCuraleaf?.shipmentStates && typeof persistedCuraleaf.shipmentStates === 'object' ? persistedCuraleaf.shipmentStates : {}),
    ...(po?.shipmentStates && typeof po.shipmentStates === 'object' ? po.shipmentStates : {}),
  };
  const placedAt = po?.createdAt || po?.issuedDate || order.paidAt || order.submittedAt || order.createdAt;
  const latestShipmentAt = latestShipmentCreatedAt(shipments);
  const prescriptionFlow: Record<string, any> = {};
  for (const rx of prescriptions) {
    const rxKey = String(rx.id || rx.fileId || `rx-${order.id.slice(0, 8)}`);
    prescriptionFlow[rxKey] = {
      id: rxKey,
      orderId: rxKey,
      state: isSupplierCancelled ? 'CANCELLED_PURCHASE_ORDER'
        : reviewBlocking && quoteReview?.type === 'out_of_stock' ? 'HELD_STOCK'
        : reviewBlocking ? 'HELD_PRICE'
        : remainingOpenAfterGoodsIn ? 'PARTIALLY_RECEIVED'
        : hasCheckedInPacks && order.fulfilmentStatus === 'COLLECTED' ? 'COLLECTED'
        : hasCheckedInPacks && order.fulfilmentStatus === 'READY_FOR_COLLECTION' ? 'READY_FOR_COLLECTION'
        : hasCheckedInPacks && order.fulfilmentStatus === 'RECEIVED' ? 'RECEIVED'
        : hasCheckedInPacks && (order.fulfilmentStatus === 'PARTIALLY_RECEIVED' || computedFulfilment === 'PARTIALLY_RECEIVED') ? 'PARTIALLY_RECEIVED'
        : isSupplierFlowActive || hasPurchaseOrderRecord ? 'PLACED'
        : isPaid ? 'PENDING_PLACEMENT'
        : 'AWAITING_PAYMENT',
      lines,
      shipmentIds,
      shipmentStates,
      dispatchStatus,
      quantityMismatch: lines.some(line => line.quantityMismatch),
      purchaseOrderId,
      placedAt,
      latestShipmentAt,
    };
  }

  const portalFulfilment = isCancelledOrder
    ? 'cancelled'
    : remainingOpenAfterGoodsIn ? 'partially_received'
    : hasCheckedInPacks && order.fulfilmentStatus === 'READY_FOR_COLLECTION' ? 'ready_for_collection'
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
    supplierItems: po?.supplierItems || poItems.map((item: any) => ({
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
  } : undefined;

  return {
    id: order.id,
    organisationId: order.organisationId,
    patientId: order.patientId,
    lineItems,
    prescriptions,
    prescriptionFlow,
    pricingQuote: pricingQuote ?? undefined,
    dispensingFeePence: Number(order.dispensingFeePence),
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
    paymentTransactionReference: order.orderNumber,
    paidAt: order.paidAt,
    curaleafApprovedAt: po?.createdAt || po?.issuedDate || undefined,
    autoPlacementEnabled: true,
    curaleaf,
    quoteReview,
    pharmacyContributionPence: Number(snapshot?.pharmacyContributionPence || quoteReview?.pharmacyContributionPence || 0) || undefined,
    cancellation: supplierStillLive ? undefined : snapshot?.cancellation ?? undefined,
    curaleafCancellation: supplierStillLive ? undefined : snapshot?.curaleafCancellation ?? undefined,
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

export function overviewIntegrationHealth(connections: OverviewIntegrationConnection[] = []) {
  return (['CURALEAF', 'WORLDPAY'] as const).map(integration => {
    const connection = connections.find(item => item.integration === integration);
    const configured = Boolean(connection?.secretResourceName);
    const environment = !connection ? null : connection.environment === 'PRODUCTION' ? 'production' as const : 'test' as const;
    const checkedAt = connection?.lastSuccessfulAt || connection?.validatedAt || null;
    if (!configured) {
      return { integration: integration.toLowerCase() as 'curaleaf' | 'worldpay', state: 'not-configured' as const, environment, checkedAt: null };
    }
    const state = connection!.status === 'ERROR'
      ? 'degraded' as const
      : connection!.status === 'PAUSED'
        ? 'unavailable' as const
        : 'connected' as const;
    return { integration: integration.toLowerCase() as 'curaleaf' | 'worldpay', state, environment, checkedAt };
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

type OverviewPrescriptionStart = {
  id: string;
  kind: 'first' | 'repeat';
  ageDays: number;
  maskedPatientLabel: string;
  lastOrderReference: string | null;
  recordTarget: { kind: 'patient'; id: string };
};

export function overviewPrescriptionStarts(params: {
  patients: PatientRecord[];
  orders: OrderRecord[];
  now?: number;
  firstLimit?: number;
  repeatLimit?: number;
}) {
  const now = params.now ?? Date.now();
  const ordersByPatient = new Map<string, OrderRecord[]>();
  for (const order of params.orders) {
    const bucket = ordersByPatient.get(order.patientId) ?? [];
    bucket.push(order);
    ordersByPatient.set(order.patientId, bucket);
  }

  const firsts: OverviewPrescriptionStart[] = [];
  const repeats: OverviewPrescriptionStart[] = [];

  for (const patient of params.patients) {
    if (patient.status === 'INACTIVE') continue;
    const patientOrders = ordersByPatient.get(patient.id) ?? [];
    const liveOrders = patientOrders.filter(isLiveOrder);
    if (!liveOrders.length) {
      firsts.push({
        id: `first-${patient.id}`,
        kind: 'first',
        ageDays: ageDays(timestamp(patient.statusChangedAt, patient.createdAt), now),
        maskedPatientLabel: overviewPatientLabel(patient),
        lastOrderReference: null,
        recordTarget: { kind: 'patient', id: patient.id },
      });
      continue;
    }
    if (patientOrders.some(isOpenOrder)) continue;
    const latestOrder = liveOrders.reduce((latest, current) => (
      orderActivityAt(current) > orderActivityAt(latest) ? current : latest
    ));
    const daysSince = ageDays(orderActivityAt(latestOrder), now);
    if (!Number.isFinite(daysSince) || daysSince < REPEAT_GAP_DAYS) continue;
    repeats.push({
      id: `repeat-${patient.id}`,
      kind: 'repeat',
      ageDays: daysSince,
      maskedPatientLabel: overviewPatientLabel(patient),
      lastOrderReference: overviewOrderReference(latestOrder),
      recordTarget: { kind: 'patient', id: patient.id },
    });
  }

  firsts.sort((left, right) => right.ageDays - left.ageDays || left.maskedPatientLabel.localeCompare(right.maskedPatientLabel));
  repeats.sort((left, right) => right.ageDays - left.ageDays || left.maskedPatientLabel.localeCompare(right.maskedPatientLabel));
  const firstLimit = params.firstLimit ?? FIRST_START_LIMIT;
  const repeatLimit = params.repeatLimit ?? REPEAT_START_LIMIT;
  return {
    firstCount: firsts.length,
    repeatCount: repeats.length,
    items: [...firsts.slice(0, firstLimit), ...repeats.slice(0, repeatLimit)],
  };
}

export function buildSqlPharmacyOverview(params: {
  organisation: OrganisationRecord;
  patients: PatientRecord[];
  orders: OrderRecord[];
  pendingEnquiries?: Array<{ submittedAt: string }>;
  connections?: OverviewIntegrationConnection[];
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
  const prescriptionStarts = overviewPrescriptionStarts({
    patients: params.patients,
    orders: params.orders,
    now,
  });
  const organisation = params.organisation;
  const activePatients = params.patients.filter(patient => patient.status === 'ACTIVE').length;

  return {
    asOf: new Date(now).toISOString(),
    organisation: {
      id: organisation.id,
      tradingName: organisation.tradingName,
      status: portalAccountStatus(organisation.status),
      trainingMode: organisation.classification === 'TRAINING',
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
    prescriptionStarts,
    priorityItems,
    recentSessions: [],
    handover: {
      activePatients,
      activePaymentLinks: awaitingPayment.length,
      supplierOrdersInProgress: supplierOrders.length,
      agedCollections: priorityItems.filter(item => item.kind === 'collection').length,
    },
    integrations: overviewIntegrationHealth(params.connections),
  };
}
