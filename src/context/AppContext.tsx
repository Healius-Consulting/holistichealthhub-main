import { createContext, useContext, useReducer, useEffect, type ReactNode } from 'react';
import { prescriptionDateIsCurrent } from '@hhh/domain/prescription-date';
import { getCuraleafCatalogue, getCuraleafConnectionStatus, getDevCuraleafCatalogue, getOrderDrafts, getPortalPatientDirectory, getPortalOrders, getWorldpayConnectionStatus, isApiConfigured } from '../shared/api';
import type { CuraleafCancellationState, CuraleafCatalogue, OrderCancellationState, OrderDraftRecord, OrderRefundState, PortalOrderRecord, PortalPendingEnquiryRecord, RedoPriceResolution } from '../shared/contracts';
import { activeRedoPriceResolution } from '../shared/contracts';
import { mapPortalEnquiryRecord, mapPortalPatientRecord } from '../utils/pharmacyPatientDirectory';
import { isLocalPortalPreview, localPortalPreview, localPreviewStaff } from '../dev/localPortalPreview';
import { ORGANISATIONS, isTrainingSandboxPatient, resolvePharmacyWorkspaceMode, trainingWorkspace } from '../training/workspace';
import { canCreateOrderForPatient } from '../utils/patientOrderEligibility';
import { portalPrescriptionStatus } from '../utils/portalPrescriptionStatus';
import { formatShippingAddress } from '../utils/shippingAddress';
import { nextDraftIdAfterDeletion, preferredDraftIndex, preferredDraftPaymentRoute } from '../utils/createOrderDraft';
import { orderRequiresCuraleafCancel, orderSupplyIncomplete } from '../utils/orderStage';
import { LEGACY_PHARMACY_DECISION_REASON, PHARMACY_REVIEWER_DISPLAY, isNegativeEligibilityStatus } from '../utils/eligibilityPresentation';

export { ORGANISATIONS };

/* ═══════════════════════════════════════════════════════════
   Types
   ═══════════════════════════════════════════════════════════ */

export interface CatalogueItem {
  id: string;
  formulaId?: string;
  name: string;
  cost: number | null; // Order-specific wholesale price from a Curaleaf quote.
  retail: number;      // Curaleaf's authoritative patient pack price.
  availability: 'unknown' | 'in' | 'low' | 'out';
  type: 'oil' | 'flos' | 'capsule' | 'lozenge' | 'vape' | 'other';
  unit?: string;
  packSize?: number;
  source?: 'curaleaf' | 'training';
  supplierState?: string;
}

export interface CRMPatient {
  id: string;
  organisationId: string;
  name: string;
  email: string;
  mobile: string;
  dob?: string;
  address?: string;
  postcode?: string;
  conditions?: string[];
  primaryCondition?: string | null;
  referralSource?: string | null;
  marketingConsent?: boolean | null;
  triedTwoTreatments?: boolean | null;
  psychiatricExclusion?: boolean | null;
  heardAbout?: string | null;
  status: 'Referred' | 'HHH approved' | 'Suspended';
  interactions?: { ts: Date | string; type: string; detail: string }[];
}

export interface LineItem {
  productId: string;
  formulaId?: string;
  name: string;
  qty: number;
  unitsNeededCount?: number;
  cost: number | null;
  retail: number;
}

export type RxStatus =
  | 'draft'
  | 'awaiting-approval'
  | 'processing'
  | 'approved'
  | 'dispatched'
  | 'partially-received'
  | 'received'
  | 'ready'
  | 'collected'
  | 'cancelled';

export interface GoodsReceiptLine {
  productId: string;
  quantityReceived: number;
}

export interface PrescriptionFulfilmentLine {
  purchaseOrderItemId?: string | null;
  productId: string;
  ordered: number;
  requested: number;
  sent: number | null;
  supplierReportedOrdered: number;
  allocated: number;
  shipped: number;
  remaining: number;
  received: number;
  collected: number;
  returned: number;
  cancelledRemainder?: number;
  remainingExpected?: number;
  backordered: boolean;
  quantityMismatch: boolean;
}

export interface Prescription {
  id: number;
  backendId?: string;
  entryMode: 'clinic' | 'manual';
  clinicScanId?: string;
  curaleafPrescriptionId?: string;
  curaleafPrescriptionState?: 'ACTIVE' | 'FULFILLED' | 'EXPIRED' | 'CANCELLED' | 'PENDING';
  purchaseOrderState?: 'CREATED' | 'PROCESSING' | 'FULLY_ALLOCATED' | 'CANCELLED' | null;
  dispatchStatus?: 'not_dispatched' | 'partial' | 'complete';
  quantityMismatch?: boolean;
  curaleafPatientName?: string;
  curaleafPatientDob?: string;
  prescriber: string;
  prescriberId?: string;
  prescriberPin?: string;
  prescriberGmcNumber?: string;
  prescriberGphcNumber?: string;
  serialNumber?: string;
  issueDate?: string;
  expiryDate?: string;
  copyFileName: string | null;
  fileId?: string | null;
  items: LineItem[];
  placed: boolean;
  placedAt?: Date | string | null;
  poRef: string | null;
  status: RxStatus;
  invoiceRef: string | null;
  trackingNumber: string | null;
  carrier: string | null;
  deliveryAddress?: string | null;
  shipmentId?: string;
  shipmentIds?: string[];
  shipmentStates?: Record<string, string>;
  manualPlaceRequired?: boolean;
  receivedItems?: GoodsReceiptLine[];
  goodsInAt?: Date | string | null;
  goodsInBy?: string | null;
  goodsInNote?: string | null;
  readyAt?: Date | string | null;
  fulfilmentLines?: PrescriptionFulfilmentLine[];
  supplierItems?: Array<{ productId: string | null; packsOrderedCount: number; packsAllocatedCount: number; packsReturnedCount: number }>;
  latestShipmentAt?: string | null;
  shipments?: Array<{
    id: string;
    createdAt?: string | null;
    shipmentCharge?: string | null;
    shippingAddress?: Array<{ line1?: string; line2?: string; city?: string; county?: string; postcode?: string; country?: string; name?: string } | string>;
    items?: Array<{ productId?: string | null; packCount?: number }>;
  }>;
}

export type PaymentStatus = 'none' | 'sent' | 'paid' | 'cancelled';
export type PaymentRoute = 'worldpay' | 'pharmacy' | null;
export type ManualTender = 'epos-card' | 'cash' | 'bank-transfer' | 'other';

export type UnresolvedOrderReason = 'expired' | 'rejected' | 'cancelled';

export interface OrderRedoContext {
  originalOrderId: number;
  originalBackendId?: string;
  rootOrderId?: number;
  rootBackendId?: string;
  replacementSequence?: number;
  priceResolution?: RedoPriceResolution;
  isPaidRedo: boolean;
  reason: UnresolvedOrderReason;
}

function replacementSuffix(sequence: number) {
  let value = Math.max(1, Math.floor(sequence));
  let suffix = '';
  while (value > 0) {
    value -= 1;
    suffix = String.fromCharCode(65 + (value % 26)) + suffix;
    value = Math.floor(value / 26);
  }
  return suffix;
}

export function orderReference(order: PatientOrder) {
  if (!order.redoContext) return `#${order.id}`;
  const root = order.redoContext.rootOrderId ?? order.redoContext.originalOrderId;
  return `#${root}${replacementSuffix(order.redoContext.replacementSequence ?? 1)}`;
}

export interface PatientOrder {
  id: number;
  backendId?: string;
  draftId?: string;
  organisationId: string;
  patientId: string | null;
  date: Date;
  dispensingFee: number;
  paymentRoute?: 'manual' | 'worldpay';
  autoPlacementEnabled?: boolean;
  payment: {
    status: PaymentStatus;
    route: PaymentRoute;
    amount: number;
    ref: string | null;
    sentAt: Date | null;
    paidAt: Date | null;
    manualTender: ManualTender | null;
    manualReference: string | null;
    manualNotes: string | null;
    manualRecordedBy: string | null;
  };
  prescriptions: Prescription[];
  curaleafApprovedAt?: Date | string | null;
  refund?: OrderRefundState;
  cancellation?: OrderCancellationState;
  curaleafCancellation?: CuraleafCancellationState;
  pharmacyContribution?: number;
  quoteReview?: PortalOrderRecord['quoteReview'];
  quoteChecks?: PortalOrderRecord['quoteChecks'];
  activeQuoteCheck?: PortalOrderRecord['activeQuoteCheck'];
  paymentAllocation?: PortalOrderRecord['paymentAllocation'];
  resolution?: PortalOrderRecord['resolution'];
  curaleafPlacement?: PortalOrderRecord['curaleafPlacement'];
  redoContext?: OrderRedoContext;
  lifecycleStatus?: string;
  isExpired?: boolean;
  unresolvedReason?: UnresolvedOrderReason | null;
  redoEligible?: boolean;
  redoneByOrderId?: string | null;
  cycleExpiresAt?: string;
  expiryCheck?: PortalOrderRecord['expiryCheck'];
}

/** Archived (28-day expired), Curaleaf-rejected, or Curaleaf-cancelled orders that need a redo or refund. */
export function getUnresolvedReason(order: PatientOrder, now = new Date()): UnresolvedOrderReason | null {
  if (order.payment.status === 'none') return null;
  if (order.prescriptions.length > 0 && order.prescriptions.every(prescription => prescription.status === 'collected')) return null;
  if (order.redoneByOrderId) return null;
  if (order.unresolvedReason === 'cancelled' || order.cancellation?.status === 'refund_required' || order.cancellation?.status === 'confirmed' || order.curaleafCancellation?.status === 'confirmed' || order.prescriptions.some(rx => rx.status === 'cancelled' || rx.purchaseOrderState === 'CANCELLED')) return 'cancelled';
  if (order.unresolvedReason === 'expired' || order.unresolvedReason === 'rejected') return order.unresolvedReason;
  if (order.redoEligible === false) return null;
  if (order.quoteReview?.status === 'recreate_required') return 'rejected';
  if (order.lifecycleStatus === 'archived' || order.isExpired) return 'expired';
  const entryDate = new Date(order.date);
  const expiryDate = order.cycleExpiresAt ? new Date(order.cycleExpiresAt) : (() => {
    const value = new Date(entryDate);
    value.setDate(value.getDate() + 28);
    return value;
  })();
  if (now > expiryDate) return 'expired';
  return null;
}

export type SubmissionStatus = 'New' | 'Under HHH review' | 'Approved' | 'Declined' | 'Rejected';

export interface EligibilitySubmission {
  id: number | string;
  name: string;
  dob: string;
  mobile: string;
  email: string;
  postcode: string;
  conditions: string[];
  primaryCondition: string;
  tried2: boolean;
  psychExclusion: boolean;
  consentReferral: boolean;
  consentShare: boolean;
  marketing: boolean;
  source: string;
  status: SubmissionStatus;
  calls: { ts: Date }[];
  reviewedAt: Date | string | null;
  reviewedBy: string | null;
  reviewerDisplay: string | null;
  decisionNote: string | null;
  pharmacyDecisionReason: string | null;
  pharmacyDecisionReasonNeedsReview: boolean;
  recordsCheck?: {
    status: 'pending' | 'completed';
    notes?: string | null;
    completedAt: Date | string | null;
    completedBy?: string | null;
  };
  referral?: {
    status: 'pending' | 'completed' | 'declined';
    notes?: string | null;
    completedAt: Date | string | null;
    completedBy?: string | null;
  };
  emailDelivery?: {
    status: 'not_sent' | 'queued' | 'sent' | 'failed';
    queuedAt: Date | string | null;
    sentAt: Date | string | null;
    failedAt: Date | string | null;
  };
  patientId?: string | null;
  submittedAt: Date;
  organisationId: string;
  pharmacyName: string;
  trainingSubmission?: boolean;
  referralToken: string;
}

export type PendingEnquiry = PortalPendingEnquiryRecord & { organisationId: string };

export interface PharmacyTenant {
  id: string;
  slug: string;
  referralToken: string;
  name: string;
  tradingName: string;
  logoText: string;
  emailLogoUrl?: string | null;
  emailLogoStoragePath?: string | null;
  emailLogoWidth?: number | null;
  emailLogoHeight?: number | null;
  emailLogoUpdatedAt?: Date | string | null;
  gphcNumber: string;
  superintendent: string;
  companyNumber?: string;
  mainContactName?: string;
  mainContactPhone?: string;
  mainContactEmail?: string;
  curaleafPharmacyCode?: string;
  address: string;
  addressLine1?: string;
  addressLine2?: string;
  locality?: string;
  county?: string;
  postcode?: string;
  websiteDomains: string[];
  status: 'live' | 'intake_live' | 'onboarding' | 'paused';
  testAccount?: boolean;
  gdprExempt?: boolean;
  workspaceClassification?: 'standard' | 'training' | 'allocation_holding';
  intakeEnabled?: boolean;
  staffCount: number;
  defaultPaymentRoute: 'manual' | 'worldpay';
  brand: {
    primary: string;
    portalName: string;
  };
  worldpay: {
    enabled: boolean;
    status: 'not-connected' | 'onboarding' | 'connected' | 'action-required';
    environment: 'sandbox' | 'live';
    merchantId: string | null;
    merchantName: string | null;
    lastSyncedAt: Date | string | null;
  };
}

export const PLATFORM_OPERATOR = {
  operatingName: 'Healius Consulting',
  platformName: 'HHH',
  platformLongName: 'Holistic Health Hub',
  legalName: null as string | null,
  companyNumber: null as string | null,
  registeredOffice: null as string | null,
  website: 'www.healiusconsulting.com',
  contactEmail: 'spatel@healiusconsulting.com',
} as const;

export type ComplianceStatus = 'not-started' | 'in-progress' | 'ready' | 'not-applicable' | 'blocked';

export interface ComplianceItem {
  id: string;
  organisationId: string | null;
  category: 'Data protection' | 'Pharmacy governance' | 'Payments' | 'Security' | 'Clinical scope' | 'Contracts';
  requirement: string;
  reference: string;
  owner: string;
  status: ComplianceStatus;
  requiredForLive: boolean;
  evidence: string | null;
  reviewDate: string | null;
}

export interface PlatformIntegration {
  id: 'curaleaf' | 'worldpay' | 'eligibility-api' | 'notifications';
  name: string;
  description: string;
  status: 'connected' | 'pending' | 'attention';
}

export type Screen = 'home' | 'formulary' | 'create' | 'orders' | 'patients' | 'finance' | 'settings';

export type NavigationTarget =
  | { kind: 'patient'; id: string }
  | { kind: 'order'; key: string }
  | { kind: 'catalogue'; query: string }
  | null;

export type PortalMode = 'gateway' | 'admin' | 'clinician';
export type WorkspaceMode = 'training' | 'live';

export interface StaffSession {
  email: string;
  name: string;
  role: 'admin' | 'pharmacy';
  organisationId?: string;
}

export interface Toast {
  id: string;
  message: string;
  type: 'success' | 'info' | 'warning' | 'error';
  /** Identical keys collapse so a single gesture never stacks duplicate toasts. */
  dedupeKey?: string;
}

/** Ceiling on the toast stack so the workspace never disappears behind notices. */
const MAX_VISIBLE_TOASTS = 3;

export interface AppState {
  screen: Screen;
  screenHistory: Screen[];
  navigationTarget: NavigationTarget;
  catalogue: CatalogueItem[];
  catalogueSource: 'curaleaf' | 'training' | 'unavailable';
  catalogueLoading: boolean;
  catalogueError: string | null;
  catalogueUpdatedAt: string | null;
  crm: CRMPatient[];
  submissions: EligibilitySubmission[];
  enquiries: PendingEnquiry[];
  orders: PatientOrder[];
  activeOrderId: number | null;
  toasts: Toast[];
  nextIds: {
    patient: number;
    rx: number;
    order: number;
    submission: number;
    invoice: number;
  };
  portalMode: PortalMode;
  workspaceMode: WorkspaceMode;
  organisations: PharmacyTenant[];
  currentOrganisationId: string;
  staffSession: StaffSession | null;
  platformIntegrations: PlatformIntegration[];
  complianceItems: ComplianceItem[];
}

/* ═══════════════════════════════════════════════════════════
   Helpers
   ═══════════════════════════════════════════════════════════ */

export const money = (n: number) => '£' + n.toFixed(2);
export const marginPct = (cost: number | null, retail: number) => cost !== null && retail > 0 ? Math.round((1 - cost / retail) * 100) : null;

export const lineRevenue = (item: LineItem) => item.retail * item.qty;
export const lineCost = (item: LineItem) => (item.cost ?? 0) * item.qty;
export const lineMargin = (item: LineItem) => {
  if (item.cost === null) return null;
  const rev = lineRevenue(item);
  return rev > 0 ? Math.round((rev - lineCost(item)) / rev * 100) : 0;
};

function prescriptionIsPaymentReady(prescription: Prescription) {
  const sourceVerified = prescription.entryMode === 'manual'
    ? Boolean(prescription.serialNumber?.trim())
    : Boolean(prescription.clinicScanId && prescription.curaleafPrescriptionId);
  const prescriberComplete = Boolean(
    prescription.issueDate
    && prescription.prescriber.trim()
    && (prescription.entryMode === 'manual' ? prescription.prescriberPin?.trim() : prescription.prescriberId),
  );
  const medicinesComplete = prescription.items.length > 0 && prescription.items.every(item => (
    Boolean(item.productId && item.formulaId)
    && Number.isInteger(item.qty) && item.qty > 0
    && Number.isInteger(item.unitsNeededCount) && item.unitsNeededCount! > 0
    && Number.isFinite(item.retail) && item.retail > 0
  ));
  return Boolean(prescription.copyFileName)
    && sourceVerified
    && prescriberComplete
    && prescriptionDateIsCurrent(prescription.issueDate, prescription.expiryDate)
    && medicinesComplete;
}

export const rxRevenue = (rx: Prescription) => rx.items.reduce((t, i) => t + lineRevenue(i), 0);
export const rxCost = (rx: Prescription) => rx.items.reduce((t, i) => t + lineCost(i), 0);
export const orderRevenue = (o: PatientOrder) => (o.refund?.status === 'completed' || o.payment.status === 'refunded' || o.lifecycleStatus === 'cancelled' ? 0 : o.prescriptions.reduce((t, r) => t + rxRevenue(r), 0) + (o.dispensingFee || 0));
export const orderCost = (o: PatientOrder) => (o.refund?.status === 'completed' || o.payment.status === 'refunded' || o.lifecycleStatus === 'cancelled' ? 0 : o.prescriptions.reduce((t, r) => t + rxCost(r), 0));

export const TYPE_LABELS: Record<string, string> = {
  flos: 'Flower (Flos)', oil: 'Oil', capsule: 'Capsule', lozenge: 'Lozenge / Pastille', vape: 'Vape', other: 'Other',
};

function catalogueType(form: string | undefined): CatalogueItem['type'] {
  if (form === 'FLOS' || form === 'GRANULATE' || form === 'SHAKE' || form === 'PRE_ROLL') return 'flos';
  if (form === 'OIL' || form === 'ORAL_DROPS' || form === 'ORAL_SPRAY') return 'oil';
  if (form === 'CAPSULE') return 'capsule';
  if (form === 'LOZENGE' || form === 'PASTILLE') return 'lozenge';
  if (form === 'VAPE_CARTRIDGE' || form === 'DEVICE') return 'vape';
  return 'other';
}

function mapCuraleafCatalogue(catalogue: CuraleafCatalogue): CatalogueItem[] {
  const formulaById = new Map(catalogue.formulas.map(formula => [formula.id, formula]));
  return catalogue.products
    .filter(product => {
      const name = product.formulaName || formulaById.get(product.formulaId)?.printedName || '';
      return !/(?:BPTEST|onerror\s*=|<(?:script|img|a|b)\b)/i.test(name);
    })
    .map(product => {
      const formula = formulaById.get(product.formulaId);
      const packSize = Math.max(0, Number(product.quantity) || 0);
      const patientPackPrice = Math.max(0, Number(product.patientPackPrice) || 0);
      const wholesalePackPrice = product.wholesalePackPrice ? Math.max(0, Number(product.wholesalePackPrice) || 0) : null;
      const availability = product.quoteBankStockStatus === 'out_of_stock' || product.quoteBankInStock === false
        ? 'out' as const
        : product.quoteBankStockStatus === 'low_stock'
          ? 'low' as const
          : product.quoteBankStockStatus === 'in_stock' || product.quoteBankInStock === true
            ? 'in' as const
            : 'unknown' as const;
      return {
        id: product.id,
        formulaId: product.formulaId,
        name: product.formulaName || formula?.printedName || product.id,
        cost: wholesalePackPrice,
        retail: patientPackPrice,
        availability,
        type: catalogueType(formula?.formulaForm),
        unit: product.formulaUnit || formula?.unit,
        packSize,
        source: 'curaleaf' as const,
        supplierState: product.state,
      };
    })
    .sort((a, b) => a.name.localeCompare(b.name));
}

function loadCachedCatalogue(orgId?: string): { items: CatalogueItem[]; updatedAt: string | null } {
  try {
    if (typeof window === 'undefined') return { items: [], updatedAt: null };
    const key = orgId ? `hhh_catalogue_cache_${orgId}` : 'hhh_catalogue_cache';
    const raw = window.localStorage.getItem(key) || window.localStorage.getItem('hhh_catalogue_cache');
    if (!raw) return { items: [], updatedAt: null };
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed.items) && parsed.items.length > 0) {
      return { items: parsed.items, updatedAt: parsed.updatedAt ?? null };
    }
  } catch {
    // ignore
  }
  return { items: [], updatedAt: null };
}

function saveCachedCatalogue(items: CatalogueItem[], updatedAt: string | null, orgId?: string) {
  try {
    if (typeof window === 'undefined' || !items.length) return;
    const payload = JSON.stringify({ items, updatedAt, timestamp: Date.now() });
    if (orgId) window.localStorage.setItem(`hhh_catalogue_cache_${orgId}`, payload);
    window.localStorage.setItem('hhh_catalogue_cache', payload);
  } catch (e) {
    console.warn('Catalogue caching warning:', e);
  }
}

export const RX_STATUS_LABELS: Record<RxStatus, string> = {
  draft: 'Draft',
  'awaiting-approval': 'Awaiting supplier approval',
  processing: 'Processing — Curaleaf picking',
  approved: 'Approved',
  dispatched: 'Dispatched to pharmacy',
  'partially-received': 'Partially received',
  received: 'Received — checks required',
  ready: 'Ready for collection',
  collected: 'Collected by patient',
  cancelled: 'Cancelled purchase order',
};

const params = new URLSearchParams(typeof window !== 'undefined' ? window.location.search : '');
const token = params.get('token');
const urlOrganisation = ORGANISATIONS.find(org => org.referralToken === token) ?? ORGANISATIONS[0];
const PORTAL_ORDER_SYNC_INTERVAL_MS = 15_000;

export const PHARMACY = {
  name: urlOrganisation.name,
  initials: urlOrganisation.logoText,
  logoText: urlOrganisation.logoText,
  formUrl: `/eligibility?token=${urlOrganisation.referralToken}`,
  brandName: `${urlOrganisation.tradingName} × Curaleaf`,
  collectionPlace: urlOrganisation.tradingName,
};

/* ═══════════════════════════════════════════════════════════
   Actions
   ═══════════════════════════════════════════════════════════ */

export type Action =
  | { type: 'SET_PORTAL_MODE'; mode: PortalMode }
  | { type: 'SET_WORKSPACE_MODE'; mode: WorkspaceMode; organisationId?: string }
  | { type: 'SIGN_IN_STAFF'; session: StaffSession }
  | { type: 'SIGN_OUT_STAFF' }
  | { type: 'SET_CURRENT_ORGANISATION'; organisationId: string }
  | { type: 'SET_ORGANISATIONS'; organisations: PharmacyTenant[] }
  | { type: 'ADD_ORGANISATION'; organisation: PharmacyTenant }
  | { type: 'UPDATE_ORGANISATION'; organisationId: string; updates: Partial<PharmacyTenant> }
  | { type: 'UPDATE_WORLDPAY'; organisationId: string; updates: Partial<PharmacyTenant['worldpay']> }
  | { type: 'UPDATE_COMPLIANCE'; itemId: string; status: ComplianceStatus; evidence?: string }
  | { type: 'UPDATE_PLATFORM_INTEGRATION'; integrationId: PlatformIntegration['id']; status: PlatformIntegration['status']; description?: string }
  | { type: 'SET_SCREEN'; screen: Screen }
  | { type: 'GO_BACK' }
  | { type: 'SET_NAVIGATION_TARGET'; target: NavigationTarget }
  | { type: 'CLEAR_NAVIGATION_TARGET' }
  | { type: 'SET_CATALOGUE_LOADING' }
  | { type: 'SET_CATALOGUE'; catalogue: CatalogueItem[]; updatedAt: string }
  | { type: 'SET_CATALOGUE_ERROR'; message: string }
  | { type: 'APPLY_CURALEAF_QUOTE'; items: Array<{ productId: string; wholesalePrice: number; patientPrice: number; inStock: boolean; stockStatus?: 'in_stock' | 'low_stock' | 'out_of_stock' }> }
  | { type: 'SYNC_PATIENT_DIRECTORY'; organisationId: string; patients: CRMPatient[]; enquiries: PendingEnquiry[] }
  | { type: 'SYNC_PORTAL_ORDERS'; organisationId: string; orders: PatientOrder[]; preferredActiveOrderId?: number }
  | { type: 'LOG_INTERACTION'; patientId: string; interactionType: string; detail: string }
  // Referrals
  | { type: 'ADD_SUBMISSION'; submission: EligibilitySubmission }
  | { type: 'UPDATE_SUBMISSION'; subId: EligibilitySubmission['id']; updates: Partial<EligibilitySubmission> }
  | { type: 'LOG_CALL'; subId: EligibilitySubmission['id'] }
  | { type: 'APPROVE_ONBOARDING'; subId: EligibilitySubmission['id']; note?: string }
  | { type: 'DECLINE_ONBOARDING'; subId: EligibilitySubmission['id']; note?: string; pharmacyDecisionReason: string }
  // Orders
  | { type: 'NEW_ORDER'; patientId?: string }
  | { type: 'START_REDO_ORDER'; sourceOrderId: number }
  | { type: 'APPLY_REDO_FROM_ORDER'; orderId: number; sourceOrderId: number }
  | { type: 'CLEAR_ORDER_REDO_CONTEXT'; orderId: number }
  | { type: 'SET_ACTIVE_ORDER'; orderId: number }
  | { type: 'SET_ORDER_PATIENT'; orderId: number; patientId: string }
  | { type: 'SET_ORDER_DISPENSING_FEE'; orderId: number; amount: number }
  | { type: 'SET_ORDER_PAYMENT_ROUTE'; orderId: number; paymentRoute: 'manual' | 'worldpay' }
  | { type: 'ADD_RX'; orderId: number }
  | { type: 'SET_RX_ENTRY_MODE'; orderId: number; rxId: number; mode: 'clinic' | 'manual' }
  | { type: 'SET_RX_PRESCRIBER'; orderId: number; rxId: number; prescriber: string }
  | { type: 'SET_RX_PATIENT_IDENTITY'; orderId: number; rxId: number; name: string; dob: string }
  | { type: 'SET_RX_METADATA'; orderId: number; rxId: number; updates: Partial<Pick<Prescription, 'prescriberPin' | 'prescriberGmcNumber' | 'prescriberGphcNumber' | 'serialNumber' | 'issueDate'>> }
  | { type: 'SET_RX_COPY'; orderId: number; rxId: number; fileName: string }
  | { type: 'SET_RX_FILE'; orderId: number; rxId: number; fileName: string; fileId: string | null }
  | { type: 'CLEAR_RX_FILE'; orderId: number; rxId: number }
  | {
      type: 'APPLY_CURALEAF_SCAN';
      orderId: number;
      rxId: number;
      scan: {
        scanId: string;
        prescriptionId: string;
        state: 'ACTIVE' | 'FULFILLED' | 'EXPIRED' | 'CANCELLED' | 'PENDING';
        serialNumber: string;
        issueDate: string;
        expiryDate: string;
        prescriberId: string;
        prescriberName: string;
        prescriberGmcNumber: string;
        prescriberGphcNumber: string;
        items: LineItem[];
      };
    }
  | { type: 'SET_ORDER_BACKEND_ID'; orderId: number; backendId: string }
  | { type: 'SET_ORDER_DRAFT_ID'; orderId: number; draftId: string }
  | { type: 'SYNC_ORDER_PATIENT_PRICES'; orderId: number; items: Array<{ productId: string; patientPrice: number }> }
  | { type: 'CONFIRM_CURALEAF_SUBMISSION'; orderId: number; rxId: number; customerReference: string }
  | { type: 'ADD_ITEM_TO_RX'; orderId: number; rxId: number; item: LineItem }
  | { type: 'REMOVE_ITEM_FROM_RX'; orderId: number; rxId: number; productId: string }
  | { type: 'UPDATE_ITEM_QTY'; orderId: number; rxId: number; productId: string; qty: number }
  | { type: 'UPDATE_ITEM_UNITS'; orderId: number; rxId: number; productId: string; unitsNeededCount: number }
  | { type: 'REMOVE_RX'; orderId: number; rxId: number }
  | { type: 'CLEAR_ORDER'; orderId: number }
  // Payment
  | { type: 'SEND_PAYMENT_LINK'; orderId: number }
  | { type: 'START_MANUAL_PAYMENT'; orderId: number }
  | { type: 'CARRY_OVER_PAYMENT'; orderId: number; sourceOrderId: number }
  | { type: 'SET_REDO_PRICE_RESOLUTION'; orderId: number; resolution: RedoPriceResolution | undefined }
  | { type: 'START_ORDER_REFUND'; orderId: number; reason: OrderRefundState['reason']; resolution: OrderRefundState['resolution'] }
  | { type: 'CONFIRM_ORDER_REFUND'; orderId: number; externalReference: string }
  | { type: 'SET_ORDER_REFUND'; orderId: number; refund: OrderRefundState }
  | { type: 'REQUEST_ORDER_CANCELLATION'; orderId: number; reason: OrderCancellationState['reason']; note?: string }
  | { type: 'RECORD_CURALEAF_CANCELLATION_CONTACT'; orderId: number; reference: string; note?: string }
  | { type: 'CONFIRM_CURALEAF_CANCELLATION'; orderId: number; reference: string }
  | { type: 'SET_ORDER_CANCELLATION'; orderId: number; cancellation: OrderCancellationState; curaleafCancellation?: CuraleafCancellationState; lifecycleStatus?: string; paymentStatus?: PaymentStatus }
  | { type: 'SET_QUOTE_REVIEW'; orderId: number; quoteReview?: PatientOrder['quoteReview']; refund?: OrderRefundState; dispensingFee?: number }
  | { type: 'CONFIRM_PAYMENT'; orderId: number }
  | { type: 'RECORD_MANUAL_PAYMENT'; orderId: number; tender: ManualTender; reference?: string; notes?: string }
  // Submission to Curaleaf.
  | { type: 'PLACE_ORDER'; orderId: number }
  | { type: 'RECORD_GOODS_RECEIPT'; orderId: number; rxId: number; lines: GoodsReceiptLine[]; note?: string }
  | { type: 'MARK_READY_FOR_COLLECTION'; orderId: number; rxId: number }
  | { type: 'HANDOVER_TO_PATIENT'; orderId: number; rxId: number }
  | { type: 'HANDOUT_ORDER'; orderId: number; partial?: boolean; shipmentId?: string }
  // Toasts
  | { type: 'ADD_TOAST'; message: string; toastType?: 'success' | 'info' | 'warning' | 'error'; dedupeKey?: string }
  | { type: 'REMOVE_TOAST'; id: string }
  ;

/* ═══════════════════════════════════════════════════════════
   Initial State
   ═══════════════════════════════════════════════════════════ */

function blankRx(id: number): Prescription {
  return {
    id, entryMode: 'clinic', prescriber: '', copyFileName: null, items: [], placed: false,
    poRef: null, status: 'draft', invoiceRef: null, trackingNumber: null, carrier: null,
  };
}

function blankOrder(id: number, patientId: string | null, organisationId: string, paymentRoute: 'manual' | 'worldpay' = 'manual'): PatientOrder {
  return {
    id, organisationId, patientId, date: new Date(), dispensingFee: 0, paymentRoute,
    payment: { status: 'none', route: null, amount: 0, ref: null, sentAt: null, paidAt: null, manualTender: null, manualReference: null, manualNotes: null, manualRecordedBy: null },
    prescriptions: [blankRx(1)],
  };
}

function customerReferenceBelongsToOrder(reference: string | null | undefined, record: PortalOrderRecord) {
  const ref = String(reference || '').trim();
  if (!ref) return false;
  const orderNum = String(record.paymentTransactionReference || '').trim();
  const orderId = String(record.id || '').trim();
  if (orderNum && (
    ref === orderNum
    || ref === `ORD-${orderNum}`
    || orderNum === `ORD-${ref}`
    || ref === `HHH-${orderNum}`
    || orderNum === `HHH-${ref}`
  )) return true;
  if (orderId && (
    ref === orderId
    || ref === `HHH-${orderId}`
    || ref.startsWith(`HHH-${orderId}-`)
    || ref.includes(orderId)
  )) return true;
  return false;
}

function asQuoteRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function quoteItemsByPackId(quote: unknown): Map<string, Record<string, unknown>> {
  const map = new Map<string, Record<string, unknown>>();
  const record = asQuoteRecord(quote);
  let items = Array.isArray(record.items) ? record.items : [];
  if (!items.length) {
    for (const key of ['data', 'quote', 'pricingQuote']) {
      const nested = asQuoteRecord(record[key]);
      if (Array.isArray(nested.items) && nested.items.length) {
        items = nested.items;
        break;
      }
    }
  }
  for (const entry of items) {
    const item = asQuoteRecord(entry);
    const packId = String(item.packId || item.productId || item.pack_id || item.id || '').trim();
    if (packId) map.set(packId, item);
  }
  return map;
}

function poundsFromQuoteMoney(pence: unknown, money: unknown): number | null {
  if (typeof pence === 'number' && Number.isFinite(pence) && pence > 0) return pence / 100;
  const value = Number(money);
  return Number.isFinite(value) && value > 0 ? value : null;
}

function lineWholesalePounds(
  persisted: { wholesalePackPricePence?: number } | undefined,
  quote: Record<string, unknown> | undefined,
  catalogueCostPence?: number,
): number | null {
  const fromLine = poundsFromQuoteMoney(persisted?.wholesalePackPricePence, undefined);
  if (fromLine != null) return fromLine;
  const fromQuote = poundsFromQuoteMoney(quote?.wholesalePackPricePence, quote?.wholesalePackPrice ?? quote?.wholesalePrice);
  if (fromQuote != null) return fromQuote;
  if (catalogueCostPence && catalogueCostPence > 0) return catalogueCostPence / 100;
  return null;
}

function portalMoneyTaken(record: PortalOrderRecord) {
  return ['paid', 'refund_required', 'refunded'].includes(record.paymentStatus) || Boolean(record.paidAt);
}

function mapPortalOrder(record: PortalOrderRecord, index: number, records: PortalOrderRecord[], catalogue: CatalogueItem[] = []): PatientOrder {
  const orderId = index + 1;
  const rxStatus: RxStatus = portalPrescriptionStatus(record);
  const persistedQuote = record.pricingQuote ?? record.curaleaf?.quote;
  const quoteItems = quoteItemsByPackId(persistedQuote);
  const orderItems = (items: Array<{ packId: string; formulaId: string; quantity: number; unitsNeededCount?: number }>): LineItem[] => items.map((item, itemIdx) => {
    const persisted = record.lineItems.find(line => line.packId === item.packId || line.productId === item.packId || line.formulaId === item.formulaId) ?? record.lineItems[itemIdx];
    const quote = quoteItems.get(item.packId)
      ?? (persisted?.packId ? quoteItems.get(persisted.packId) : undefined)
      ?? (persisted?.productId ? quoteItems.get(persisted.productId) : undefined);
    let unitRetail = 0;
    const itemQty = item.quantity || 1;
    const basketItemsTotal = Math.max(0, (record.totalPence - (record.dispensingFeePence || 0)) / 100);

    if (persisted && persisted.unitPricePence > 0) {
      const candidatePrice = persisted.unitPricePence / 100;
      // If persisted.unitPricePence was the total order basket value, calculate true unit pack price
      if (basketItemsTotal > 0 && Math.abs(candidatePrice - basketItemsTotal) < 0.01 && itemQty > 1) {
        unitRetail = candidatePrice / itemQty;
      } else {
        unitRetail = candidatePrice;
      }
    } else if (quote && Number(quote.patientPackPrice) > 0) {
      unitRetail = Number(quote.patientPackPrice);
    } else if (record.totalPence > 0) {
      const totalQty = items.reduce((sum, it) => sum + (it.quantity || 1), 0) || 1;
      unitRetail = basketItemsTotal > 0 ? basketItemsTotal / totalQty : (record.totalPence / 100) / totalQty;
    }

    const catItem = catalogue.find(c =>
      (item.packId && c.id === item.packId) ||
      (item.formulaId && c.formulaId === item.formulaId) ||
      (persisted?.packId && c.id === persisted.packId) ||
      (persisted?.productId && c.id === persisted.productId) ||
      (persisted?.formulaId && c.formulaId === persisted.formulaId)
    );
    const hasSpecificName = persisted?.name && !['Curaleaf prescription item', 'Curaleaf formulary product', 'Curaleaf medication', 'Prescribed product'].includes(persisted.name);
    const resolvedName = hasSpecificName
      ? persisted.name
      : catItem?.name
        ?? persisted?.name
        ?? (quote ? 'Curaleaf medication' : 'Curaleaf prescription item');

    return {
      productId: item.packId,
      formulaId: item.formulaId || persisted?.formulaId || catItem?.formulaId,
      name: resolvedName,
      qty: item.quantity,
      unitsNeededCount: item.unitsNeededCount,
      cost: lineWholesalePounds(persisted, quote, catItem?.cost != null ? Math.round(catItem.cost * 100) : undefined),
      retail: unitRetail || (catItem?.rrpPence ? catItem.rrpPence / 100 : 0),
    };
  });
  const isPaid = ['paid', 'refund_required', 'refunded'].includes(record.paymentStatus) || Boolean(record.paidAt) || Boolean(record.curaleaf?.purchaseOrderId);
  const prescriptions: Prescription[] = record.prescriptions?.length
    ? record.prescriptions.map((prescription, rxIndex) => {
        const rawCuraleaf = isPaid ? (record.curaleafSubOrders?.[prescription.fileId] ?? record.curaleaf) : undefined;
        const poRef = (rawCuraleaf?.customerReference || '').trim();
        const isMatchedPO = !rawCuraleaf || !poRef || customerReferenceBelongsToOrder(poRef, record);
        const curaleaf = isMatchedPO ? rawCuraleaf : undefined;
        const flowKey = prescription.id ?? prescription.fileId;
        const flow = isMatchedPO ? record.prescriptionFlow?.[flowKey] : undefined;
        const isFlowPlaced = isPaid && flow?.state === 'PLACED';
        const flowLines = (isPaid && flow?.lines?.length && flow.state !== 'AWAITING_PAYMENT') ? flow.lines : [];
        const totalReceivedPacks = flowLines.reduce((sum, line) => sum + (line.received ?? 0), 0);
        const totalShippedPacks = flowLines.reduce((sum, line) => sum + (line.shipped ?? 0), 0);
        const hasCheckedInPacks = totalReceivedPacks > 0;
        const receivedItems = flowLines.length
          ? flowLines.filter(line => line.received > 0).map(line => ({ productId: line.productId, quantityReceived: line.received }))
          : undefined;
        const flowStatus: RxStatus | null = !isPaid ? 'draft'
          : flow?.state === 'CANCELLED_PURCHASE_ORDER' ? 'cancelled'
          : flow?.state === 'COLLECTED' ? 'collected'
          : flow?.state === 'READY_FOR_COLLECTION' && hasCheckedInPacks ? 'ready'
          : flow?.state === 'RECEIVED' && hasCheckedInPacks ? 'received'
          : flow?.state === 'PARTIALLY_RECEIVED' && hasCheckedInPacks ? 'partially-received'
          : !hasCheckedInPacks && totalShippedPacks > 0 ? 'dispatched'
          : isFlowPlaced && curaleaf?.purchaseOrderState === 'CANCELLED' ? 'cancelled'
          : isFlowPlaced && (totalShippedPacks > 0 || flow?.shipmentIds?.length || curaleaf?.shipmentIds?.length) ? 'dispatched'
          : isFlowPlaced ? 'processing'
          : null;
        const shipmentIds = (isPaid && flow?.shipmentIds?.length) ? flow.shipmentIds : (isPaid ? (curaleaf?.shipmentIds ?? []) : []);
        const latestShipmentAt = isPaid
          ? (curaleaf?.shipments ?? []).map(shipment => shipment.createdAt).filter((value): value is string => Boolean(value)).sort().at(-1)
            ?? flow?.latestShipmentAt
            ?? null
          : null;
        const mappedShipments = isPaid
          ? (curaleaf?.shipments ?? []).map(shipment => ({
            id: shipment.id,
            createdAt: shipment.createdAt ?? null,
            shipmentCharge: shipment.shipmentCharge ?? null,
            shippingAddress: shipment.shippingAddress,
            items: (shipment.items ?? []).map(item => ({
              productId: item.productId ?? null,
              packCount: Number(item.packCount ?? 0),
            })),
          }))
          : undefined;
        const deliveryAddress = isPaid
          ? (
            formatShippingAddress(mappedShipments?.find(shipment => shipment.shippingAddress)?.shippingAddress)
            ?? formatShippingAddress(curaleaf?.shippingAddress)
            ?? null
          )
          : null;
        return {
          id: orderId * 100 + rxIndex + 1,
          backendId: flowKey,
          entryMode: prescription.clinicScanId ? 'clinic' : 'manual',
          clinicScanId: prescription.clinicScanId,
          curaleafPrescriptionId: prescription.curaleafPrescriptionId,
          curaleafPrescriptionState: curaleaf?.prescriptionState,
          purchaseOrderState: curaleaf?.purchaseOrderState,
          dispatchStatus: isPaid ? (flow?.dispatchStatus ?? curaleaf?.dispatchStatus) : undefined,
          quantityMismatch: isPaid ? (flow?.quantityMismatch ?? curaleaf?.quantityMismatch) : false,
          prescriber: curaleaf?.prescriberName ?? prescription.prescriber.name,
          prescriberId: prescription.prescriber.id,
          prescriberPin: prescription.prescriber.pin,
          prescriberGmcNumber: prescription.prescriber.gmcNumber?.toString(),
          prescriberGphcNumber: prescription.prescriber.gphcNumber ?? undefined,
          serialNumber: prescription.serialNumber,
          issueDate: prescription.issueDate,
          expiryDate: prescription.expiryDate,
          copyFileName: null,
          fileId: prescription.fileId,
          items: orderItems(prescription.items),
          placed: isPaid && Boolean(flow?.purchaseOrderId || curaleaf?.purchaseOrderId || isFlowPlaced),
          placedAt: isPaid ? (flow?.placedAt ?? curaleaf?.createdAt ?? curaleaf?.issuedDate ?? record.paidAt ?? record.createdAt) : null,
          poRef: isPaid ? (curaleaf?.customerReference ?? record.orderNumber ?? record.paymentTransactionReference ?? flow?.purchaseOrderId ?? null) : null,
          status: flowStatus ?? portalPrescriptionStatus({ curaleaf: isPaid ? curaleaf : undefined, fulfilmentStatus: isPaid ? record.fulfilmentStatus : 'supplier_pending' }),
          invoiceRef: null,
          trackingNumber: null,
          carrier: curaleaf?.courier ? String(curaleaf.courier) : null,
          deliveryAddress,
          shipmentId: shipmentIds[0],
          shipmentIds,
          shipmentStates: isPaid ? (flow?.shipmentStates ?? curaleaf?.shipmentStates) : undefined,
          manualPlaceRequired: isPaid ? flow?.manualPlaceRequired : false,
          receivedItems,
          goodsInAt: hasCheckedInPacks
            ? (flow?.goodsInAt ?? latestShipmentAt)
            : null,
          fulfilmentLines: flowLines.length ? flowLines.map(line => ({
            purchaseOrderItemId: line.purchaseOrderItemId,
            productId: line.productId,
            ordered: line.ordered,
            requested: line.requested,
            sent: line.sent,
            supplierReportedOrdered: line.supplierReportedOrdered,
            allocated: line.allocated,
            shipped: line.shipped,
            remaining: line.remaining,
            received: line.received,
            collected: line.collected,
            returned: line.returned,
            cancelledRemainder: line.cancelledRemainder ?? 0,
            remainingExpected: line.remainingExpected ?? Math.max(0, line.remaining - (line.cancelledRemainder ?? 0)),
            backordered: line.backordered,
            quantityMismatch: line.quantityMismatch,
          })) : undefined,
          supplierItems: isPaid ? (curaleaf?.supplierItems ?? []) : undefined,
          latestShipmentAt,
          shipments: mappedShipments,
        };
      })
    : [{
        id: orderId * 100 + 1,
        entryMode: 'clinic',
        prescriber: 'Curaleaf prescription',
        copyFileName: null,
        items: orderItems(record.lineItems.map(item => ({ packId: item.packId, formulaId: item.formulaId, quantity: item.quantity }))),
        placed: Boolean(record.curaleaf?.purchaseOrderId),
        poRef: record.curaleaf?.customerReference ?? record.orderNumber ?? record.paymentTransactionReference ?? null,
        status: rxStatus,
        invoiceRef: null,
        trackingNumber: null,
        carrier: record.curaleaf?.courier ?? null,
        shipmentId: record.curaleaf?.shipmentIds?.[0],
        shipmentIds: record.curaleaf?.shipmentIds ?? [],
      }];
  const paid = portalMoneyTaken(record);
  const cancelled = !paid && record.paymentStatus === 'cancelled';
  const redoSourceBackendId = record.redoContext ? String(record.redoOfOrderId ?? record.redoContext.originalOrderId) : null;
  let redoSource = redoSourceBackendId ? records.find(candidate => candidate.id === redoSourceBackendId) : undefined;
  let redoSequence = 0;
  const seenRedoIds = new Set<string>();
  while (redoSource && !seenRedoIds.has(redoSource.id)) {
    seenRedoIds.add(redoSource.id);
    redoSequence += 1;
    const nextSourceId = redoSource.redoContext ? String(redoSource.redoOfOrderId ?? redoSource.redoContext.originalOrderId) : null;
    if (!nextSourceId) break;
    redoSource = records.find(candidate => candidate.id === nextSourceId);
  }
  const rootBackendId = record.redoContext?.rootOrderId ? String(record.redoContext.rootOrderId) : redoSource?.id ?? redoSourceBackendId ?? undefined;
  const rootIndex = rootBackendId ? records.findIndex(candidate => candidate.id === rootBackendId) : -1;
  const sourceIndex = redoSourceBackendId ? records.findIndex(candidate => candidate.id === redoSourceBackendId) : -1;
  return {
    id: orderId,
    backendId: record.id,
    organisationId: record.organisationId,
    patientId: record.patientId,
    paymentRoute: record.paymentRoute === 'worldpay' ? 'worldpay' : 'manual',
    date: new Date(record.createdAt),
    dispensingFee: record.dispensingFeePence / 100,
    autoPlacementEnabled: record.autoPlacementEnabled !== false,
    payment: {
      status: paid ? 'paid' : cancelled ? 'cancelled' : 'sent',
      route: record.paymentRoute === 'manual' ? 'pharmacy' : 'worldpay',
      amount: record.totalPence / 100,
      ref: record.paymentTransactionReference ?? record.worldpayPaymentId ?? record.paymentId ?? null,
      sentAt: new Date(record.createdAt),
      paidAt: paid ? (record.paidAt ? new Date(record.paidAt) : new Date(record.updatedAt)) : null,
      manualTender: (record as any).manualTender ?? (record.paymentRoute === 'manual' ? 'epos-card' : null),
      manualReference: (record as any).manualReference ?? (record.paymentRoute === 'manual' ? record.paymentTransactionReference : null),
      manualNotes: null,
      manualRecordedBy: null,
    },
    prescriptions,
    curaleafApprovedAt: record.curaleafApprovedAt ?? null,
    refund: record.refund,
    cancellation: record.cancellation,
    curaleafCancellation: record.curaleafCancellation,
    pharmacyContribution: record.pharmacyContributionPence ? record.pharmacyContributionPence / 100 : 0,
    quoteReview: record.quoteReview,
    quoteChecks: record.quoteChecks,
    activeQuoteCheck: record.activeQuoteCheck,
    paymentAllocation: record.paymentAllocation,
    resolution: record.resolution,
    curaleafPlacement: record.curaleafPlacement,
    lifecycleStatus: record.status,
    isExpired: Boolean(record.isExpired || record.unresolvedReason === 'expired'),
    unresolvedReason: record.unresolvedReason ?? null,
    redoEligible: record.redoEligible,
    redoneByOrderId: record.redoneByOrderId ?? null,
    cycleExpiresAt: record.cycleExpiresAt,
    expiryCheck: record.expiryCheck,
    redoContext: record.redoContext ? {
      originalOrderId: sourceIndex >= 0 ? sourceIndex + 1 : 0,
      originalBackendId: String(record.redoOfOrderId ?? record.redoContext.originalOrderId),
      rootOrderId: rootIndex >= 0 ? rootIndex + 1 : sourceIndex >= 0 ? sourceIndex + 1 : orderId,
      rootBackendId,
      replacementSequence: record.redoContext.replacementSequence ?? Math.max(1, redoSequence),
      priceResolution: activeRedoPriceResolution(record.redoContext.priceResolution),
      isPaidRedo: Boolean(record.redoContext.isPaidRedo),
      reason: record.redoContext.unresolvedReason ?? 'expired',
    } : undefined,
  };
}

function mapPortalDraft(record: OrderDraftRecord, index: number, defaultPaymentRoute: 'manual' | 'worldpay' = 'manual'): PatientOrder {
  const payload = record.payload as Partial<PatientOrder> & { localOrderId?: number; prescriptions?: Prescription[] };
  const id = 1_000_000 + index;
  const prescriptions = Array.isArray(payload.prescriptions) && payload.prescriptions.length
    ? payload.prescriptions.map((prescription, rxIndex) => ({ ...prescription, id: id * 100 + rxIndex + 1, status: 'draft' as const, placed: false, poRef: null }))
    : [blankRx(id * 100 + 1)];
  return {
    id,
    draftId: record.id,
    organisationId: record.organisationId,
    patientId: record.patientId,
    date: new Date(record.createdAt),
    dispensingFee: Number((record.payload.dispensingFeePence ?? 0)) / 100,
    paymentRoute: record.payload.paymentRoute === 'worldpay' ? 'worldpay' : record.payload.paymentRoute === 'manual' ? 'manual' : defaultPaymentRoute,
    payment: { status: 'none', route: null, amount: 0, ref: null, sentAt: null, paidAt: null, manualTender: null, manualReference: null, manualNotes: null, manualRecordedBy: null },
    prescriptions,
    redoContext: payload.redoContext
      ? { ...payload.redoContext, priceResolution: activeRedoPriceResolution(payload.redoContext.priceResolution) }
      : undefined,
  };
}





const urlParams = typeof window !== 'undefined' ? new URLSearchParams(window.location.search) : null;
let storedStaffSession: StaffSession | null = null;
try {
  storedStaffSession = JSON.parse(sessionStorage.getItem('hhh_staff_session') || 'null') as StaffSession | null;
} catch { storedStaffSession = null; }
const previewStaffSession: StaffSession | null = isLocalPortalPreview && localPreviewStaff
  ? {
      email: localPreviewStaff.email,
      name: localPreviewStaff.name,
      role: localPreviewStaff.role === 'hhh_admin' ? 'admin' : 'pharmacy',
      organisationId: localPreviewStaff.organisationId,
    }
  : null;
const initialPortalMode: PortalMode = localPortalPreview === 'admin' ? 'admin' : localPortalPreview === 'pharmacy' ? 'clinician' : storedStaffSession?.role === 'admin' ? 'admin' : storedStaffSession?.role === 'pharmacy' ? 'clinician' : 'gateway';
const initialToken = urlParams?.get('token');
const initialCachedCatalogue = loadCachedCatalogue(storedStaffSession?.organisationId);

const previewOrganisationId = previewStaffSession?.organisationId ?? (isLocalPortalPreview ? ORGANISATIONS[0]?.id ?? '' : '');
const previewTraining = isLocalPortalPreview && localPortalPreview === 'pharmacy' && previewOrganisationId
  ? trainingWorkspace(previewOrganisationId)
  : null;

const initialState: AppState = {
  screen: urlParams?.has('patient') ? 'patients' : 'home',
  screenHistory: [],
  navigationTarget: null,
  catalogue: initialCachedCatalogue.items,
  catalogueSource: initialCachedCatalogue.items.length ? 'curaleaf' : 'unavailable',
  catalogueLoading: initialCachedCatalogue.items.length ? false : isApiConfigured,
  catalogueError: null,
  catalogueUpdatedAt: initialCachedCatalogue.updatedAt,
  crm: previewTraining?.crm ?? [],
  submissions: [],
  enquiries: [],
  orders: previewTraining?.orders ?? [],
  activeOrderId: null,
  toasts: [],
  nextIds: previewTraining?.nextIds ?? { patient: 2000, rx: 1, order: 7, submission: 5, invoice: 4072 },
  portalMode: initialPortalMode,
  workspaceMode: 'training',
  organisations: isLocalPortalPreview ? ORGANISATIONS : [],
  currentOrganisationId: previewStaffSession?.organisationId ?? (isLocalPortalPreview ? ORGANISATIONS[0]?.id ?? '' : ''),
  staffSession: previewStaffSession ?? storedStaffSession,
  platformIntegrations: [
    { id: 'eligibility-api', name: 'HHH Eligibility API', description: 'Token routing and patient intake', status: 'connected' },
    { id: 'curaleaf', name: 'Curaleaf', description: 'Product, prescription and supplier ordering', status: 'pending' },
    { id: 'worldpay', name: 'Worldpay', description: 'Pharmacy-owned hosted checkout, payment webhooks and direct settlement', status: 'pending' },
    { id: 'notifications', name: 'Patient notifications', description: 'Ready-for-collection SMS and email', status: 'pending' },
  ],
  complianceItems: [],
};

/* ═══════════════════════════════════════════════════════════
   Reducer
   ═══════════════════════════════════════════════════════════ */

function findOrder(state: AppState, orderId: number) {
  return state.orders.find(o => o.id === orderId);
}

function applyRedoOntoDraft(draft: PatientOrder, source: PatientOrder, reason: UnresolvedOrderReason): PatientOrder {
  const cancelledRemainders = source.prescriptions.flatMap(rx => rx.items.flatMap(item => {
    const cancelledPacks = rx.fulfilmentLines?.find(line => line.productId === item.productId)?.cancelledRemainder ?? 0;
    if (cancelledPacks <= 0) return [];
    const unitsPerPack = item.unitsNeededCount && item.qty > 0 ? item.unitsNeededCount / item.qty : undefined;
    return [{ ...item, qty: cancelledPacks, unitsNeededCount: unitsPerPack ? Math.max(1, Math.round(unitsPerPack * cancelledPacks)) : item.unitsNeededCount }];
  }));
  const items = cancelledRemainders.length
    ? cancelledRemainders
    : source.prescriptions.flatMap(rx => rx.items).map(item => ({ ...item }));
  const targetRxId = draft.prescriptions[0]?.id;
  return {
    ...draft,
    patientId: source.patientId ?? draft.patientId,
    redoContext: {
      originalOrderId: source.id,
      originalBackendId: source.backendId,
      rootOrderId: source.redoContext?.rootOrderId ?? source.redoContext?.originalOrderId ?? source.id,
      rootBackendId: source.redoContext?.rootBackendId ?? source.redoContext?.originalBackendId ?? source.backendId,
      replacementSequence: (source.redoContext?.replacementSequence ?? 0) + 1,
      isPaidRedo: source.payment.status === 'paid' && source.refund?.status !== 'completed',
      reason,
    },
    prescriptions: draft.prescriptions.map(rx => {
      if (rx.id !== targetRxId) return rx;
      const sourceRx = source.prescriptions[0];
      return {
        ...rx,
        items,
        prescriber: sourceRx?.prescriber ?? rx.prescriber,
        prescriberId: sourceRx?.prescriberId ?? rx.prescriberId,
        prescriberPin: sourceRx?.prescriberPin ?? rx.prescriberPin,
        prescriberGmcNumber: sourceRx?.prescriberGmcNumber ?? rx.prescriberGmcNumber,
        prescriberGphcNumber: sourceRx?.prescriberGphcNumber ?? rx.prescriberGphcNumber,
        copyFileName: null,
        fileId: undefined,
        clinicScanId: undefined,
        curaleafPrescriptionId: undefined,
        serialNumber: undefined,
        issueDate: undefined,
        expiryDate: undefined,
        curaleafPatientName: undefined,
        curaleafPatientDob: undefined,
        placed: false,
        poRef: null,
        status: 'draft',
        invoiceRef: null,
        trackingNumber: null,
        carrier: null,
      };
    }),
  };
}

function mapOrder(state: AppState, orderId: number, fn: (o: PatientOrder) => PatientOrder): AppState {
  return { ...state, orders: state.orders.map(o => o.id === orderId ? fn({ ...o }) : o) };
}

function mapRx(order: PatientOrder, rxId: number, fn: (rx: Prescription) => Prescription): PatientOrder {
  return { ...order, prescriptions: order.prescriptions.map(r => r.id === rxId ? fn({ ...r }) : r) };
}

function reducer(state: AppState, action: Action): AppState {
  switch (action.type) {
    case 'SET_SCREEN':
      if (action.screen === state.screen) return state;
      return { ...state, screen: action.screen, screenHistory: [...state.screenHistory.slice(-7), state.screen] };
    case 'GO_BACK': {
      const previous = state.screenHistory.at(-1);
      if (!previous) return state;
      return { ...state, screen: previous, screenHistory: state.screenHistory.slice(0, -1), navigationTarget: null };
    }
    case 'SET_NAVIGATION_TARGET':
      return { ...state, navigationTarget: action.target };
    case 'CLEAR_NAVIGATION_TARGET':
      return { ...state, navigationTarget: null };
    case 'SET_CATALOGUE_LOADING':
      return { ...state, catalogueLoading: true, catalogueError: null };
    case 'SET_CATALOGUE': {
      const catMap = new Map(action.catalogue.map(c => [c.id, c.name]));
      const formulaMap = new Map(action.catalogue.filter(c => c.formulaId).map(c => [c.formulaId!, c.name]));
      const enrichedOrders = state.orders.map(order => ({
        ...order,
        prescriptions: order.prescriptions.map(rx => ({
          ...rx,
          items: rx.items.map(item => {
            const isGeneric = !item.name || ['Curaleaf prescription item', 'Curaleaf formulary product', 'Curaleaf medication', 'Prescribed product'].includes(item.name);
            if (!isGeneric) return item;
            const actualName = catMap.get(item.productId) || (item.formulaId ? formulaMap.get(item.formulaId) : undefined);
            return actualName ? { ...item, name: actualName } : item;
          }),
        })),
      }));
      saveCachedCatalogue(action.catalogue, action.updatedAt, state.currentOrganisationId);
      return {
        ...state,
        orders: enrichedOrders,
        catalogue: action.catalogue,
        catalogueSource: 'curaleaf',
        catalogueLoading: false,
        catalogueError: null,
        catalogueUpdatedAt: action.updatedAt,
        platformIntegrations: state.platformIntegrations.map(integration => integration.id === 'curaleaf'
          ? { ...integration, status: 'connected', description: `${action.catalogue.length} Curaleaf products loaded from the connected environment.` }
          : integration),
      };
    }
    case 'SET_CATALOGUE_ERROR':
      return {
        ...state,
        catalogueLoading: false,
        catalogueError: action.message,
        catalogueSource: state.catalogue.length ? state.catalogueSource : 'unavailable',
        platformIntegrations: state.platformIntegrations.map(integration => integration.id === 'curaleaf'
          ? { ...integration, status: 'attention', description: action.message }
          : integration),
      };
    case 'APPLY_CURALEAF_QUOTE': {
      const quoted = new Map(action.items.map(item => [item.productId, item]));
      return {
        ...state,
        catalogue: state.catalogue.map(product => {
          const item = quoted.get(product.id);
          return item ? {
            ...product,
            retail: item.patientPrice,
            availability: !item.inStock || item.stockStatus === 'out_of_stock' ? 'out' : item.stockStatus === 'low_stock' ? 'low' : 'in',
          } : product;
        }),
        orders: state.orders.map(order => order.payment.status !== 'none' ? order : ({
          ...order,
          prescriptions: order.prescriptions.map(rx => ({
            ...rx,
            items: rx.items.map(line => {
              const item = quoted.get(line.productId);
              return item ? { ...line, cost: item.wholesalePrice, retail: item.patientPrice } : line;
            }),
          })),
        })),
      };
    }
    case 'SYNC_PATIENT_DIRECTORY': {
      const retainedPatients = state.crm.filter(patient =>
        patient.organisationId !== action.organisationId && !isTrainingSandboxPatient(patient),
      );
      const byId = new Map(retainedPatients.map(patient => [patient.id, patient]));
      action.patients.forEach(patient => byId.set(patient.id, patient));
      const retainedEnquiries = state.enquiries.filter(enquiry => enquiry.organisationId !== action.organisationId);
      return {
        ...state,
        crm: [...byId.values()],
        enquiries: [...retainedEnquiries, ...action.enquiries],
      };
    }
    case 'SYNC_PORTAL_ORDERS': {
      const previousActive = state.orders.find(order => order.id === state.activeOrderId && order.payment.status === 'none');
      const incomingPersisted = action.orders.filter(order => order.payment.status !== 'none');
      const incomingDrafts = action.orders.filter(order => order.payment.status === 'none');

      // Preserve the user's in-progress active draft without overwriting it with stale server snapshots
      const preservedDrafts = previousActive
        ? incomingDrafts.map(draft => (draft.draftId && draft.draftId === previousActive.draftId) || draft.id === previousActive.id ? previousActive : draft)
        : incomingDrafts;

      if (previousActive && !preservedDrafts.some(draft => draft.id === previousActive.id || (previousActive.draftId && draft.draftId === previousActive.draftId))) {
        preservedDrafts.unshift(previousActive);
      }

      const retainedOtherOrgs = state.orders.filter(order => order.organisationId !== action.organisationId);
      const orders = [...retainedOtherOrgs, ...incomingPersisted, ...preservedDrafts];
      const nextOrderId = Math.max(state.nextIds.order, ...orders.map(order => order.id + 1));
      const nextRxId = Math.max(state.nextIds.rx, ...orders.flatMap(order => order.prescriptions.map(rx => rx.id + 1)));
      const activeOrderId = previousActive?.id ?? state.activeOrderId ?? action.preferredActiveOrderId ?? null;
      return { ...state, orders, activeOrderId, nextIds: { ...state.nextIds, order: nextOrderId, rx: nextRxId } };
    }
    case 'LOG_INTERACTION': {
      return {
        ...state,
        crm: state.crm.map(p =>
          p.id === action.patientId
            ? {
                ...p,
                interactions: [
                  ...(p.interactions || []),
                  { ts: new Date(), type: action.interactionType, detail: action.detail }
                ]
              }
            : p
        )
      };
    }
    case 'SET_PORTAL_MODE':
      return { ...state, portalMode: action.mode, screenHistory: [], navigationTarget: null };
    case 'SET_WORKSPACE_MODE': {
      const organisationId = action.organisationId ?? state.currentOrganisationId;
      if (action.mode === 'training') {
        const stayingInTraining = state.workspaceMode === 'training'
          && state.crm.some(patient => patient.organisationId === organisationId && isTrainingSandboxPatient(patient));
        if (stayingInTraining) {
          return {
            ...state,
            workspaceMode: 'training',
            currentOrganisationId: organisationId || state.currentOrganisationId,
            enquiries: [],
          };
        }
        const training = trainingWorkspace(organisationId);
        return {
          ...state,
          workspaceMode: 'training',
          currentOrganisationId: organisationId || state.currentOrganisationId,
          navigationTarget: null,
          crm: training.crm,
          submissions: [],
          enquiries: [],
          orders: training.orders,
          activeOrderId: null,
          nextIds: training.nextIds,
        };
      }
      if (state.workspaceMode === action.mode) return state;
      return {
        ...state,
        workspaceMode: action.mode,
        currentOrganisationId: organisationId || state.currentOrganisationId,
        navigationTarget: null,
        catalogue: action.mode === 'live' && state.catalogueSource === 'curaleaf' ? state.catalogue : [],
        catalogueSource: action.mode === 'live' && state.catalogueSource === 'curaleaf' ? 'curaleaf' : 'unavailable',
        crm: [],
        submissions: [],
        orders: [],
        activeOrderId: null,
      };
    }
    case 'SIGN_IN_STAFF':
      return {
        ...state,
        staffSession: action.session,
        currentOrganisationId: action.session.organisationId ?? state.currentOrganisationId,
        portalMode: action.session.role === 'admin' ? 'admin' : 'clinician',
      };
    case 'SIGN_OUT_STAFF': {
      return {
        ...state,
        staffSession: null,
        portalMode: 'gateway',
        workspaceMode: 'training',
        screen: 'home',
        screenHistory: [],
        navigationTarget: null,
        catalogue: state.catalogueSource === 'curaleaf' ? state.catalogue : [],
        catalogueSource: state.catalogueSource === 'curaleaf' ? 'curaleaf' : 'unavailable',
        crm: [],
        submissions: [],
        orders: [],
        activeOrderId: null,
        organisations: [],
        currentOrganisationId: '',
        complianceItems: [],
      };
    }
    case 'SET_CURRENT_ORGANISATION':
      return { ...state, currentOrganisationId: action.organisationId };
    case 'SET_ORGANISATIONS': {
      const organisations = action.organisations.map(organisation => {
        const previous = state.organisations.find(item => item.id === organisation.id);
        if (!previous?.worldpay.lastSyncedAt) return organisation;
        return {
          ...organisation,
          worldpay: {
            ...organisation.worldpay,
            status: previous.worldpay.status,
            environment: previous.worldpay.environment,
            merchantId: previous.worldpay.merchantId,
            merchantName: previous.worldpay.merchantName,
            lastSyncedAt: previous.worldpay.lastSyncedAt,
            enabled: organisation.worldpay.enabled || previous.worldpay.enabled,
          },
        };
      });
      return {
        ...state,
        organisations,
        currentOrganisationId: organisations.some(organisation => organisation.id === state.currentOrganisationId)
          ? state.currentOrganisationId
          : organisations[0]?.id ?? '',
      };
    }
    case 'UPDATE_PLATFORM_INTEGRATION':
      return { ...state, platformIntegrations: state.platformIntegrations.map(integration => integration.id === action.integrationId ? { ...integration, status: action.status, description: action.description ?? integration.description } : integration) };
    case 'ADD_ORGANISATION':
      if (state.organisations.some(organisation => organisation.id === action.organisation.id)) {
        return { ...state, organisations: state.organisations.map(organisation => organisation.id === action.organisation.id ? action.organisation : organisation) };
      }
      return { ...state, organisations: [...state.organisations, action.organisation] };
    case 'UPDATE_ORGANISATION':
      return { ...state, organisations: state.organisations.map(org => org.id === action.organisationId ? { ...org, ...action.updates } : org) };
    case 'UPDATE_WORLDPAY':
      return { ...state, organisations: state.organisations.map(org => org.id === action.organisationId ? { ...org, worldpay: { ...org.worldpay, ...action.updates } } : org) };
    case 'UPDATE_COMPLIANCE':
      return { ...state, complianceItems: state.complianceItems.map(item => item.id === action.itemId ? { ...item, status: action.status, evidence: action.evidence ?? item.evidence } : item) };
    // ---- Referrals ----
    case 'ADD_SUBMISSION': {
      if (state.submissions.some(s =>
        s.id === action.submission.id ||
        (s.organisationId === action.submission.organisationId &&
          s.email.toLowerCase() === action.submission.email.toLowerCase())
      )) {
        return {
          ...state,
          submissions: state.submissions.map(submission =>
            submission.id === action.submission.id ||
            (submission.organisationId === action.submission.organisationId &&
              submission.email.toLowerCase() === action.submission.email.toLowerCase())
              ? { ...submission, ...action.submission }
              : submission
          ),
        };
      }
      return {
        ...state,
        submissions: [action.submission, ...state.submissions],
      };
    }
    case 'UPDATE_SUBMISSION':
      return {
        ...state,
        submissions: state.submissions.map(submission => submission.id === action.subId ? { ...submission, ...action.updates } : submission),
      };
    case 'LOG_CALL': {
      return {
        ...state,
        submissions: state.submissions.map(s =>
          s.id === action.subId && s.status !== 'Approved' && !isNegativeEligibilityStatus(s.status)
            ? { ...s, calls: [...s.calls, { ts: new Date() }], status: 'Under HHH review' as const }
            : s
        ),
      };
    }
    case 'APPROVE_ONBOARDING': {
      const sub = state.submissions.find(s => s.id === action.subId);
      if (!sub || sub.calls.length === 0 || isNegativeEligibilityStatus(sub.status)) return state;
      const existing = state.crm.find(patient => patient.organisationId === sub.organisationId && patient.email.toLowerCase() === sub.email.toLowerCase());
      const patientId = existing?.id ?? `P-${state.nextIds.patient}`;
      const approvedBy = state.staffSession?.name ?? 'HHH administrator';
      const approvedAt = new Date();
      return {
        ...state,
        crm: existing ? state.crm.map(patient => patient.id === existing.id ? { ...patient, dob: sub.dob, conditions: sub.conditions, primaryCondition: sub.primaryCondition, referralSource: sub.source, marketingConsent: sub.marketing, status: 'HHH approved' as const } : patient) : [...state.crm, {
          id: patientId,
          organisationId: sub.organisationId,
          name: sub.name,
          email: sub.email,
          mobile: sub.mobile,
          dob: sub.dob,
          address: sub.postcode,
          conditions: sub.conditions,
          primaryCondition: sub.primaryCondition,
          referralSource: sub.source,
          marketingConsent: sub.marketing,
          status: 'HHH approved' as const,
          interactions: [{ ts: approvedAt, type: 'HHH onboarding approved', detail: `${PHARMACY_REVIEWER_DISPLAY} approved programme onboarding after patient review.` }],
        }],
        nextIds: { ...state.nextIds, patient: existing ? state.nextIds.patient : state.nextIds.patient + 1 },
        submissions: state.submissions.map(s =>
          s.id === action.subId ? { ...s, status: 'Approved' as const, reviewedAt: approvedAt, reviewedBy: approvedBy, reviewerDisplay: PHARMACY_REVIEWER_DISPLAY, decisionNote: action.note?.trim() || 'Approved for programme onboarding after HHH telephone review.', pharmacyDecisionReason: null, pharmacyDecisionReasonNeedsReview: false } : s
        ),
      };
    }
    case 'DECLINE_ONBOARDING': {
      const sub = state.submissions.find(s => s.id === action.subId);
      if (!sub || sub.calls.length === 0 || sub.status === 'Approved' || isNegativeEligibilityStatus(sub.status)) return state;
      const reviewedBy = state.staffSession?.name ?? 'HHH administrator';
      return {
        ...state,
        submissions: state.submissions.map(s =>
          s.id === action.subId ? { ...s, status: 'Declined' as const, reviewedAt: new Date(), reviewedBy, reviewerDisplay: PHARMACY_REVIEWER_DISPLAY, decisionNote: action.note?.trim() || 'Not onboarded following HHH review.', pharmacyDecisionReason: action.pharmacyDecisionReason.trim(), pharmacyDecisionReasonNeedsReview: false } : s
        ),
      };
    }

    // ---- Orders ----
    case 'NEW_ORDER': {
      if (action.patientId && !state.crm.some(patient => patient.id === action.patientId && patient.organisationId === state.currentOrganisationId && canCreateOrderForPatient(patient))) return state;
      const id = state.nextIds.order;
      const rxId = state.nextIds.rx;
      const organisation = state.organisations.find(item => item.id === state.currentOrganisationId);
      const defaultRoute = preferredDraftPaymentRoute(Boolean(organisation?.worldpay.enabled), organisation?.worldpay.status ?? 'not-connected');
      const newOrder = blankOrder(id, action.patientId || null, state.currentOrganisationId, defaultRoute);
      newOrder.prescriptions = [blankRx(rxId)];
      return {
        ...state,
        orders: [...state.orders, newOrder],
        activeOrderId: id,
        nextIds: { ...state.nextIds, order: id + 1, rx: rxId + 1 },
      };
    }
    case 'START_REDO_ORDER': {
      const source = state.orders.find(order => order.id === action.sourceOrderId && order.organisationId === state.currentOrganisationId);
      if (!source?.patientId || source.payment.status === 'none') return state;
      const reason = getUnresolvedReason(source);
      if (!reason) return state;
      if (!state.crm.some(patient => patient.id === source.patientId && patient.organisationId === state.currentOrganisationId && canCreateOrderForPatient(patient))) return state;
      const existingDraft = state.orders.find(order => order.organisationId === state.currentOrganisationId && order.payment.status === 'none' && order.redoContext?.originalOrderId === source.id);
      if (existingDraft) return {
        ...state,
        activeOrderId: existingDraft.id,
        screen: 'create',
        screenHistory: state.screen === 'create' ? state.screenHistory : [...state.screenHistory.slice(-7), state.screen],
      };
      const id = state.nextIds.order;
      const rxId = state.nextIds.rx;
      const organisation = state.organisations.find(item => item.id === state.currentOrganisationId);
      const defaultRoute = preferredDraftPaymentRoute(Boolean(organisation?.worldpay.enabled), organisation?.worldpay.status ?? 'not-connected');
      const draft = blankOrder(id, source.patientId, state.currentOrganisationId, defaultRoute);
      draft.prescriptions = [blankRx(rxId)];
      const redone = applyRedoOntoDraft(draft, source, reason);
      return {
        ...state,
        orders: [...state.orders, redone],
        activeOrderId: id,
        nextIds: { ...state.nextIds, order: id + 1, rx: rxId + 1 },
        screen: 'create',
        screenHistory: state.screen === 'create' ? state.screenHistory : [...state.screenHistory.slice(-7), state.screen],
      };
    }
    case 'APPLY_REDO_FROM_ORDER': {
      const source = state.orders.find(order => order.id === action.sourceOrderId && order.organisationId === state.currentOrganisationId);
      const draft = state.orders.find(order => order.id === action.orderId && order.organisationId === state.currentOrganisationId);
      if (!source || !draft || draft.payment.status !== 'none') return state;
      const reason = getUnresolvedReason(source);
      if (!reason) return state;
      if (source.patientId && draft.patientId && source.patientId !== draft.patientId) return state;
      const existingDraft = state.orders.find(order => order.id !== draft.id && order.organisationId === state.currentOrganisationId && order.payment.status === 'none' && order.redoContext?.originalOrderId === source.id);
      if (existingDraft) return { ...state, activeOrderId: existingDraft.id };
      return mapOrder(state, action.orderId, order => applyRedoOntoDraft(order, source, reason));
    }
    case 'CLEAR_ORDER_REDO_CONTEXT':
      return mapOrder(state, action.orderId, order => {
        if (!order.redoContext) return order;
        const { redoContext: _removed, ...rest } = order;
        return rest;
      });
    case 'SET_ACTIVE_ORDER':
      return { ...state, activeOrderId: action.orderId };
    case 'SET_ORDER_PATIENT': {
      const order = state.orders.find(item => item.id === action.orderId);
      const patient = state.crm.find(item => item.id === action.patientId && item.organisationId === order?.organisationId && canCreateOrderForPatient(item));
      return patient ? mapOrder(state, action.orderId, o => ({
        ...o,
        patientId: patient.id,
        redoContext: o.redoContext && o.redoContext.originalOrderId
          ? (state.orders.find(source => source.id === o.redoContext!.originalOrderId)?.patientId === patient.id ? o.redoContext : undefined)
          : undefined,
        prescriptions: o.prescriptions.map(prescription => prescription.entryMode === 'manual' ? {
          ...prescription,
          curaleafPatientName: patient.name,
          curaleafPatientDob: patient.dob ?? '',
        } : prescription),
      })) : state;
    }
    case 'SET_ORDER_DISPENSING_FEE':
      return mapOrder(state, action.orderId, order => ({ ...order, dispensingFee: Math.max(0, action.amount) }));
    case 'SET_ORDER_PAYMENT_ROUTE':
      return mapOrder(state, action.orderId, order => order.payment.status === 'none' ? { ...order, paymentRoute: action.paymentRoute } : order);
    case 'ADD_RX': {
      const rxId = state.nextIds.rx;
      return {
        ...mapOrder(state, action.orderId, o => ({ ...o, prescriptions: [...o.prescriptions, blankRx(rxId)] })),
        nextIds: { ...state.nextIds, rx: rxId + 1 },
      };
    }
    case 'SET_RX_ENTRY_MODE':
      return mapOrder(state, action.orderId, order => {
        const patient = order.patientId
          ? state.crm.find(item => item.id === order.patientId && item.organisationId === order.organisationId && canCreateOrderForPatient(item))
          : null;
        return mapRx(order, action.rxId, prescription => ({
          ...blankRx(prescription.id),
          entryMode: action.mode,
          ...(action.mode === 'manual' && patient ? {
            curaleafPatientName: patient.name,
            curaleafPatientDob: patient.dob ?? '',
          } : {}),
        }));
      });
    case 'SET_RX_PRESCRIBER':
      return mapOrder(state, action.orderId, o => mapRx(o, action.rxId, r => ({ ...r, prescriber: action.prescriber })));
    case 'SET_RX_PATIENT_IDENTITY':
      return mapOrder(state, action.orderId, o => mapRx(o, action.rxId, r => ({
        ...r,
        curaleafPatientName: action.name,
        curaleafPatientDob: action.dob,
      })));
    case 'SET_RX_METADATA':
      return mapOrder(state, action.orderId, o => mapRx(o, action.rxId, r => ({ ...r, ...action.updates })));
    case 'SET_RX_COPY':
      return mapOrder(state, action.orderId, o => mapRx(o, action.rxId, r => ({ ...r, copyFileName: action.fileName })));
    case 'SET_RX_FILE':
      return mapOrder(state, action.orderId, o => mapRx(o, action.rxId, r => ({
        ...r,
        copyFileName: action.fileName,
        fileId: action.fileId,
        ...(r.entryMode === 'clinic' ? {
          clinicScanId: undefined,
          curaleafPrescriptionId: undefined,
          curaleafPrescriptionState: undefined,
          curaleafPatientName: undefined,
          curaleafPatientDob: undefined,
          serialNumber: undefined,
          issueDate: undefined,
          expiryDate: undefined,
          prescriberId: undefined,
          prescriber: '',
          prescriberPin: undefined,
          prescriberGmcNumber: undefined,
          prescriberGphcNumber: undefined,
          items: [],
        } : {}),
      })));
    case 'CLEAR_RX_FILE':
      return mapOrder(state, action.orderId, o => mapRx(o, action.rxId, r => ({
        ...r,
        copyFileName: null,
        fileId: null,
        ...(r.entryMode === 'clinic' ? {
          clinicScanId: undefined,
          curaleafPrescriptionId: undefined,
          curaleafPrescriptionState: undefined,
          curaleafPatientName: undefined,
          curaleafPatientDob: undefined,
          serialNumber: undefined,
          issueDate: undefined,
          expiryDate: undefined,
          prescriberId: undefined,
          prescriber: '',
          prescriberPin: undefined,
          prescriberGmcNumber: undefined,
          prescriberGphcNumber: undefined,
          items: [],
        } : {}),
      })));
    case 'APPLY_CURALEAF_SCAN':
      return mapOrder(state, action.orderId, o => mapRx(o, action.rxId, r => ({
        ...r,
        clinicScanId: action.scan.scanId,
        curaleafPrescriptionId: action.scan.prescriptionId,
        curaleafPrescriptionState: action.scan.state,
        entryMode: 'clinic',
        serialNumber: action.scan.serialNumber,
        issueDate: action.scan.issueDate,
        expiryDate: action.scan.expiryDate,
        prescriberId: action.scan.prescriberId,
        prescriber: action.scan.prescriberName,
        prescriberPin: '',
        prescriberGmcNumber: action.scan.prescriberGmcNumber,
        prescriberGphcNumber: action.scan.prescriberGphcNumber,
        items: action.scan.items,
      })));
    case 'SET_ORDER_BACKEND_ID':
      return mapOrder(state, action.orderId, o => ({ ...o, backendId: action.backendId }));
    case 'SET_ORDER_DRAFT_ID':
      return mapOrder(state, action.orderId, o => ({ ...o, draftId: action.draftId }));
    case 'SYNC_ORDER_PATIENT_PRICES': {
      const prices = new Map(action.items.map(item => [item.productId, item.patientPrice]));
      return {
        ...mapOrder(state, action.orderId, order => ({
          ...order,
          prescriptions: order.prescriptions.map(rx => ({
            ...rx,
            items: rx.items.map(item => prices.has(item.productId) ? { ...item, retail: prices.get(item.productId)! } : item),
          })),
        })),
        catalogue: state.catalogue.map(product => prices.has(product.id) ? { ...product, retail: prices.get(product.id)! } : product),
      };
    }
    case 'CONFIRM_CURALEAF_SUBMISSION':
      return mapOrder(state, action.orderId, o => mapRx(o, action.rxId, r => ({
        ...r,
        placed: true,
        placedAt: new Date(),
        poRef: action.customerReference,
        status: 'awaiting-approval',
      })));
    case 'ADD_ITEM_TO_RX':
      return mapOrder(state, action.orderId, o => mapRx(o, action.rxId, r => ({ ...r, items: [...r.items, action.item] })));
    case 'REMOVE_ITEM_FROM_RX':
      return mapOrder(state, action.orderId, o => mapRx(o, action.rxId, r => ({
        ...r, items: r.items.filter(i => i.productId !== action.productId),
      })));
    case 'UPDATE_ITEM_QTY':
      return mapOrder(state, action.orderId, o => mapRx(o, action.rxId, r => ({
        ...r, items: r.items.map(i => i.productId === action.productId ? { ...i, qty: Math.max(1, action.qty) } : i),
      })));
    case 'UPDATE_ITEM_UNITS':
      return mapOrder(state, action.orderId, o => mapRx(o, action.rxId, r => ({
        ...r, items: r.items.map(i => i.productId === action.productId ? { ...i, unitsNeededCount: Math.max(1, Math.floor(action.unitsNeededCount)) } : i),
      })));
    case 'REMOVE_RX':
      return mapOrder(state, action.orderId, o => ({
        ...o, prescriptions: o.prescriptions.filter(r => r.id !== action.rxId),
      }));
    case 'CLEAR_ORDER':
    {
      const removedOrder = state.orders.find(order => order.id === action.orderId);
      const orders = state.orders.filter(order => order.id !== action.orderId);
      const nextDraftId = nextDraftIdAfterDeletion(state.orders, action.orderId, removedOrder?.organisationId ?? state.currentOrganisationId);
      return {
        ...state,
        orders,
        activeOrderId: state.activeOrderId === action.orderId ? nextDraftId : state.activeOrderId,
      };
    }

    // ---- Payment ----
    case 'SEND_PAYMENT_LINK': {
      const order = findOrder(state, action.orderId);
      const patient = state.crm.find(candidate => candidate.id === order?.patientId && candidate.organisationId === order?.organisationId && canCreateOrderForPatient(candidate));
      const prescriptionReady = Boolean(patient && order?.prescriptions.length && order.prescriptions.every(rx => prescriptionIsPaymentReady(rx)));
      if (!order || !patient || !prescriptionReady) return state;
      const amount = orderRevenue(order);
      const nextState = mapOrder(state, action.orderId, o => ({
        ...o,
        payment: { ...o.payment, status: 'sent', route: 'worldpay', amount, ref: null, sentAt: new Date(), paidAt: null, manualTender: null, manualReference: null, manualNotes: null, manualRecordedBy: null },
      }));
      // Find another draft order (payment status 'none') to make active
      const nextDraft = nextState.orders.find(o => o.payment.status === 'none' && o.id !== action.orderId);
      nextState.activeOrderId = nextDraft ? nextDraft.id : null;
      return nextState;
    }
    case 'START_MANUAL_PAYMENT': {
      const order = findOrder(state, action.orderId);
      const patient = state.crm.find(candidate => candidate.id === order?.patientId && candidate.organisationId === order?.organisationId && canCreateOrderForPatient(candidate));
      const prescriptionReady = Boolean(patient && order?.prescriptions.length && order.prescriptions.every(rx => prescriptionIsPaymentReady(rx)));
      if (!order || !patient || !prescriptionReady) return state;
      const amount = orderRevenue(order);
      const nextState = mapOrder(state, action.orderId, o => ({
        ...o,
        payment: { ...o.payment, status: 'sent', route: 'pharmacy', amount, ref: null, sentAt: new Date(), paidAt: null, manualTender: null, manualReference: null, manualNotes: null, manualRecordedBy: null },
      }));
      const nextDraft = nextState.orders.find(o => o.payment.status === 'none' && o.id !== action.orderId);
      nextState.activeOrderId = nextDraft ? nextDraft.id : null;
      return nextState;
    }
    case 'CARRY_OVER_PAYMENT': {
      const order = findOrder(state, action.orderId);
      const source = findOrder(state, action.sourceOrderId);
      if (!order?.redoContext?.isPaidRedo || order.redoContext.originalOrderId !== source?.id || source.payment.status !== 'paid') return state;
      const amount = orderRevenue(order);
      const absorbedDifference = order.redoContext.priceResolution === 'absorb' ? Math.max(0, amount - source.payment.amount) : 0;
      const absorbedReduction = order.redoContext.priceResolution === 'absorb' ? Math.max(0, source.payment.amount - amount) : 0;
      if (Math.abs(amount - source.payment.amount) >= 0.005 && absorbedDifference <= 0 && absorbedReduction <= 0) return state;
      const nextState = {
        ...state,
        orders: state.orders.map(candidate => {
          if (candidate.id === order.id) return {
            ...candidate,
            payment: {
              ...source.payment,
              status: 'paid' as const,
              amount: order.redoContext?.priceResolution === 'absorb' ? source.payment.amount : amount,
              paidAt: source.payment.paidAt ?? new Date(),
            },
            pharmacyContribution: order.redoContext?.priceResolution === 'absorb' ? amount - source.payment.amount : 0,
          };
          if (candidate.id === source.id) return {
            ...candidate,
            redoneByOrderId: String(order.id),
            unresolvedReason: order.redoContext?.reason,
            redoEligible: false,
            ...(order.redoContext?.reason === 'expired' ? { lifecycleStatus: 'archived', isExpired: true } : {}),
          };
          return candidate;
        }),
      };
      const nextDraft = nextState.orders.find(candidate => candidate.payment.status === 'none' && candidate.id !== action.orderId);
      nextState.activeOrderId = nextDraft ? nextDraft.id : null;
      return nextState;
    }
    case 'SET_REDO_PRICE_RESOLUTION':
      return mapOrder(state, action.orderId, order => order.redoContext ? { ...order, redoContext: { ...order.redoContext, priceResolution: action.resolution } } : order);
    case 'START_ORDER_REFUND':
      return mapOrder(state, action.orderId, order => {
        if (order.payment.status !== 'paid' || order.refund) return order;
        const requestedAt = new Date().toISOString();
        return {
          ...order,
          refund: {
            id: `training-refund-${order.id}`,
            status: 'pending_confirmation',
            amountPence: Math.round(order.payment.amount * 100),
            method: order.payment.route === 'worldpay' ? 'worldpay_portal' : 'pharmacy_manual',
            paymentReference: order.payment.ref ?? `ORDER-${order.id}`,
            reason: action.reason,
            resolution: action.resolution,
            requestedAt,
            requestedBy: state.staffSession?.name ?? 'Pharmacy staff',
          },
        };
      });
    case 'CONFIRM_ORDER_REFUND':
      return mapOrder(state, action.orderId, order => order.refund?.status === 'pending_confirmation' ? {
        ...order,
        quoteReview: undefined,
        refund: { ...order.refund, status: 'completed', externalReference: action.externalReference, confirmedAt: new Date().toISOString(), confirmedBy: state.staffSession?.name ?? 'Pharmacy staff' },
      } : order);
    case 'SET_ORDER_REFUND':
      return mapOrder(state, action.orderId, order => ({ ...order, refund: action.refund }));
    case 'REQUEST_ORDER_CANCELLATION':
      return mapOrder(state, action.orderId, order => {
        const requestedAt = new Date().toISOString();
        const hasCuraleafOrder = orderRequiresCuraleafCancel(order);
        return {
          ...order,
          lifecycleStatus: hasCuraleafOrder ? order.lifecycleStatus : 'cancelled',
          payment: hasCuraleafOrder || order.payment.status === 'paid' ? order.payment : { ...order.payment, status: 'cancelled' },
          quoteReview: undefined,
          cancellation: {
            status: hasCuraleafOrder ? 'curaleaf_contact_required' : order.payment.status === 'paid' ? 'refund_required' : 'cancelled',
            reason: action.reason,
            note: action.note?.trim() || null,
            requestedAt,
            requestedBy: state.staffSession?.name ?? 'Pharmacy staff',
            paymentLinkStatus: order.payment.status === 'sent' ? 'cancelled_in_platform' : 'not_applicable',
            paymentReference: order.payment.ref,
          },
          curaleafCancellation: hasCuraleafOrder ? {
            status: 'contact_required',
            purchaseOrderId: order.prescriptions.find(prescription => prescription.poRef)?.poRef ?? null,
            prescriptionId: order.prescriptions.find(prescription => prescription.curaleafPrescriptionId)?.curaleafPrescriptionId ?? null,
            requestedAt,
            requestedBy: state.staffSession?.name ?? 'Pharmacy staff',
          } : order.curaleafCancellation,
        };
      });
    case 'RECORD_CURALEAF_CANCELLATION_CONTACT':
      return mapOrder(state, action.orderId, order => order.curaleafCancellation ? ({
        ...order,
        cancellation: order.cancellation ? { ...order.cancellation, status: 'awaiting_curaleaf_confirmation' } : order.cancellation,
        curaleafCancellation: {
          ...order.curaleafCancellation,
          status: 'awaiting_confirmation',
          contactReference: action.reference,
          contactNote: action.note?.trim() || null,
          contactedAt: new Date().toISOString(),
          contactedBy: state.staffSession?.name ?? 'Pharmacy staff',
        },
      }) : order);
    case 'CONFIRM_CURALEAF_CANCELLATION':
      return mapOrder(state, action.orderId, order => order.curaleafCancellation ? ({
        ...order,
        lifecycleStatus: 'cancelled',
        cancellation: order.cancellation ? { ...order.cancellation, status: order.payment.status === 'paid' ? 'refund_required' : 'cancelled' } : order.cancellation,
        curaleafCancellation: {
          ...order.curaleafCancellation,
          status: 'confirmed',
          confirmationReference: action.reference,
          confirmedAt: new Date().toISOString(),
          confirmedBy: state.staffSession?.name ?? 'Pharmacy staff',
        },
      }) : order);
    case 'SET_ORDER_CANCELLATION':
      return mapOrder(state, action.orderId, order => ({
        ...order,
        cancellation: action.cancellation,
        curaleafCancellation: action.curaleafCancellation ?? order.curaleafCancellation,
        lifecycleStatus: action.lifecycleStatus ?? order.lifecycleStatus,
        payment: action.paymentStatus ? { ...order.payment, status: action.paymentStatus } : order.payment,
      }));
    case 'SET_QUOTE_REVIEW':
      return mapOrder(state, action.orderId, order => ({
        ...order,
        quoteReview: action.quoteReview,
        refund: action.refund ?? order.refund,
        dispensingFee: action.dispensingFee ?? order.dispensingFee,
      }));
    case 'CONFIRM_PAYMENT':
      return mapOrder(state, action.orderId, o => ({
        ...o,
        payment: { ...o.payment, status: 'paid', paidAt: new Date() },
      }));
    case 'RECORD_MANUAL_PAYMENT':
      return mapOrder(state, action.orderId, o => o.payment.route !== 'pharmacy' ? o : ({
        ...o,
        payment: {
          ...o.payment,
          status: 'paid',
          paidAt: new Date(),
          manualTender: action.tender,
          manualReference: action.reference?.trim() || null,
          manualNotes: action.notes?.trim() || null,
          manualRecordedBy: state.staffSession?.name || 'Pharmacy staff',
        },
      }));

    // ---- Curaleaf submission simulation ----
    case 'PLACE_ORDER': {
      const order = findOrder(state, action.orderId);
      const patient = state.crm.find(candidate => candidate.id === order?.patientId && candidate.organisationId === order?.organisationId && canCreateOrderForPatient(candidate));
      const prescriptionReady = Boolean(patient && order?.prescriptions.length && order.prescriptions.every(rx => prescriptionIsPaymentReady(rx)));
      if (!order || order.payment.status !== 'paid' || !patient || !prescriptionReady) return state;
      return {
        ...mapOrder(state, action.orderId, o => ({
          ...o,
          prescriptions: o.prescriptions.map(r => {
            return {
              ...r,
              placed: true,
              placedAt: new Date(),
              // Supplier references are populated only from the Curaleaf response or
              // a later reconciliation. Never invent courier or invoice data.
              poRef: null,
              status: 'awaiting-approval' as const,
              invoiceRef: null,
              trackingNumber: null,
              carrier: null,
            };
          }),
        })),
      };
    }
    case 'RECORD_GOODS_RECEIPT': {
      const nextState = mapOrder(state, action.orderId, o => mapRx(o, action.rxId, r => {
        if (r.status !== 'dispatched' && r.status !== 'partially-received') return r;
        const totals = new Map((r.receivedItems ?? []).map(line => [line.productId, line.quantityReceived]));
        action.lines.forEach(line => {
          const shipped = r.fulfilmentLines?.find(item => item.productId === line.productId)?.shipped ?? 0;
          const ordered = r.items.find(item => item.productId === line.productId)?.qty ?? shipped;
          const cap = shipped > 0 ? shipped : ordered;
          const safeQuantity = Math.max(0, Math.min(cap, Math.floor(line.quantityReceived)));
          totals.set(line.productId, Math.max(totals.get(line.productId) ?? 0, safeQuantity));
        });
        const receivedItems = r.items.map(item => ({
          productId: item.productId,
          quantityReceived: totals.get(item.productId) ?? 0,
        }));
        const remainingOpen = (r.fulfilmentLines ?? []).some(line => line.remaining > 0)
          || r.items.some(item => (totals.get(item.productId) ?? 0) < item.qty);
        const complete = !remainingOpen && r.items.length > 0 && r.items.every(item =>
          (totals.get(item.productId) ?? 0) >= item.qty
        );
        return {
          ...r,
          status: complete ? 'received' : 'partially-received',
          receivedItems,
          fulfilmentLines: r.fulfilmentLines?.map(line => ({
            ...line,
            received: totals.get(line.productId) ?? line.received,
          })),
          goodsInAt: new Date(),
          goodsInBy: state.staffSession?.name ?? 'Pharmacy staff',
          goodsInNote: action.note?.trim() || null,
        };
      }));
      // Toast is raised once by the Orders handler that dispatches this action.
      return nextState;
    }
    case 'MARK_READY_FOR_COLLECTION': {
      const current = findOrder(state, action.orderId)?.prescriptions.find(rx => rx.id === action.rxId);
      if (!current || (current.status !== 'received' && current.status !== 'partially-received')) return state;
      const remainingOpen = (current.fulfilmentLines ?? []).some(line => line.remaining > 0 || line.received < line.ordered);
      const nextState = mapOrder(state, action.orderId, o => mapRx(o, action.rxId, r => ({
        ...r,
        status: remainingOpen ? 'partially-received' : 'ready',
        readyAt: new Date(),
        shipmentStates: r.shipmentId || r.shipmentIds?.[0]
          ? { ...(r.shipmentStates ?? {}), [(r.shipmentId || r.shipmentIds?.[0]) as string]: 'ready_for_collection' }
          : r.shipmentStates,
      })));
      // Toast is raised once by the Orders handler that dispatches this action.
      return nextState;
    }
    case 'HANDOVER_TO_PATIENT': {
      const nextState = mapOrder(state, action.orderId, o => mapRx(o, action.rxId, r => ({
        ...r,
        status: 'collected',
      })));
      // Toast is raised once by the Orders handler that dispatches this action.
      return nextState;
    }
    case 'HANDOUT_ORDER': {
      const order = state.orders.find(candidate => candidate.id === action.orderId);
      if (!order || !order.prescriptions.length) return state;
      // Packs on the dispensary shelf are collectable stock, not outstanding supply, so a
      // full handout is only blocked while the supplier or goods-in still owes packs.
      const supplyIncomplete = orderSupplyIncomplete(order);
      const readyForHandout = order.prescriptions.some(prescription =>
        ['ready', 'partially-received', 'received'].includes(prescription.status)
        && (prescription.fulfilmentLines ?? []).some(line => line.received > line.collected),
      );
      if (!readyForHandout) return state;
      if (!action.partial && supplyIncomplete) return state;
      return mapOrder(state, action.orderId, currentOrder => ({
        ...currentOrder,
        handoutAt: new Date(),
        prescriptions: currentOrder.prescriptions.map(prescription => {
          const nextLines = prescription.fulfilmentLines?.map(line => ({
            ...line,
            collected: Math.max(line.collected, line.received),
          }));
          const rxRemainingOpen = (nextLines ?? []).some(line => line.remaining > 0 || line.collected < line.ordered);
          const nextShipmentStates = prescription.shipmentStates
            ? Object.fromEntries(Object.entries(prescription.shipmentStates).map(([shipmentId, shipmentState]) => {
              if (action.shipmentId && shipmentId !== action.shipmentId) return [shipmentId, shipmentState];
              if (shipmentState === 'ready_for_collection' || shipmentState === 'received' || shipmentState === 'partially_received') {
                return [shipmentId, 'collected'];
              }
              return [shipmentId, shipmentState];
            }))
            : prescription.shipmentStates;
          return {
            ...prescription,
            fulfilmentLines: nextLines,
            status: rxRemainingOpen ? 'partially-received' : 'collected',
            shipmentStates: nextShipmentStates,
          };
        }),
      }));
    }

    case 'ADD_TOAST': {
      const id = Date.now().toString() + Math.random();
      const type = action.toastType || 'info';
      const dedupeKey = action.dedupeKey ?? `${type}:${action.message}`;
      // One gesture must never stack duplicate toasts; errors still replace their predecessor.
      const withoutDuplicate = state.toasts.filter(toast => toast.dedupeKey !== dedupeKey);
      const newToast = { id, message: action.message, type, dedupeKey };
      // Keep the visible stack readable.
      return { ...state, toasts: [...withoutDuplicate, newToast].slice(-MAX_VISIBLE_TOASTS) };
    }

    case 'REMOVE_TOAST': {
      return { ...state, toasts: state.toasts.filter(t => t.id !== action.id) };
    }

    default:
      return state;
  }
}

/* ═══════════════════════════════════════════════════════════
   Context
   ═══════════════════════════════════════════════════════════ */

interface AppContextType {
  state: AppState;
  dispatch: React.Dispatch<Action>;
}

const AppContext = createContext<AppContextType | null>(null);

export function AppProvider({ children }: { children: ReactNode }) {
  const [state, dispatch] = useReducer(reducer, initialState);
  const currentOrganisation = state.organisations.find(organisation => organisation.id === state.currentOrganisationId);
  const livePharmacyWorkspace = resolvePharmacyWorkspaceMode(currentOrganisation) === 'live';

  useEffect(() => {
    if (!isLocalPortalPreview) return;
    if (state.staffSession) sessionStorage.setItem('hhh_staff_session', JSON.stringify(state.staffSession));
    else sessionStorage.removeItem('hhh_staff_session');
  }, [state.staffSession]);

  useEffect(() => {
    const useLocalSandbox = isLocalPortalPreview && isApiConfigured;
    const useAuthenticatedPortal = !isLocalPortalPreview
      && isApiConfigured
      && Boolean(state.staffSession)
      && Boolean(currentOrganisation);
    if (!useLocalSandbox && !useAuthenticatedPortal) return;
    let cancelled = false;
    dispatch({ type: 'SET_CATALOGUE_LOADING' });
    const request = useLocalSandbox
      ? getDevCuraleafCatalogue()
      : getCuraleafCatalogue(state.currentOrganisationId);
    request.then(catalogue => {
      if (!cancelled) dispatch({ type: 'SET_CATALOGUE', catalogue: mapCuraleafCatalogue(catalogue), updatedAt: catalogue.fetchedAt });
    }).catch(error => {
      if (!cancelled) dispatch({ type: 'SET_CATALOGUE_ERROR', message: error instanceof Error ? error.message : 'Curaleaf catalogue unavailable.' });
    });
    return () => { cancelled = true; };
  }, [state.currentOrganisationId, state.staffSession]);

  useEffect(() => {
    if (isLocalPortalPreview || !isApiConfigured || !state.staffSession || !livePharmacyWorkspace || state.catalogueSource !== 'curaleaf') return;
    let cancelled = false;
    getCuraleafConnectionStatus().then(status => {
      if (cancelled) return;
      dispatch({
        type: 'UPDATE_PLATFORM_INTEGRATION',
        integrationId: 'curaleaf',
        status: status.connected ? 'connected' : status.configured ? 'attention' : 'pending',
        description: status.message || (status.connected ? 'Curaleaf connection verified for this pharmacy.' : 'Curaleaf connection requires attention.'),
      });
    }).catch(error => console.warn('Curaleaf status check unavailable:', error));
    return () => { cancelled = true; };
  }, [state.catalogueSource, state.staffSession, livePharmacyWorkspace]);

  useEffect(() => {
    if (isLocalPortalPreview || !isApiConfigured || !state.staffSession || !state.currentOrganisationId || !livePharmacyWorkspace) return;
    if (currentOrganisation?.worldpay.lastSyncedAt) return;
    let cancelled = false;
    const organisationId = state.currentOrganisationId;
    getWorldpayConnectionStatus(organisationId).then(status => {
      if (cancelled) return;
      dispatch({
        type: 'UPDATE_WORLDPAY',
        organisationId,
        updates: {
          status: status.connected ? 'connected' : status.configured ? 'onboarding' : 'not-connected',
          environment: status.environment === 'live' ? 'live' : 'sandbox',
          merchantId: status.maskedIdentifier ?? null,
          lastSyncedAt: status.updatedAt ?? new Date().toISOString(),
        },
      });
    }).catch(error => {
      console.warn('Worldpay status check unavailable:', error);
      if (cancelled) return;
      dispatch({
        type: 'UPDATE_WORLDPAY',
        organisationId,
        updates: {
          status: 'not-connected',
          lastSyncedAt: new Date().toISOString(),
        },
      });
    });
    return () => { cancelled = true; };
  }, [currentOrganisation?.worldpay.lastSyncedAt, livePharmacyWorkspace, state.currentOrganisationId, state.staffSession]);

  useEffect(() => {
    if (isLocalPortalPreview || !isApiConfigured || !state.staffSession || !state.currentOrganisationId || !livePharmacyWorkspace) return;
    let cancelled = false;
    const organisationId = state.currentOrganisationId;
    getPortalPatientDirectory(organisationId).then(directory => {
      if (cancelled) return;
      dispatch({
        type: 'SYNC_PATIENT_DIRECTORY',
        organisationId,
        patients: directory.patients.map(mapPortalPatientRecord),
        enquiries: directory.enquiries.map(record => mapPortalEnquiryRecord(organisationId, record)),
      });
    }).catch(error => console.warn('Patient directory sync unavailable:', error));
    return () => { cancelled = true; };
  }, [livePharmacyWorkspace, state.currentOrganisationId, state.staffSession]);

  useEffect(() => {
    if (isLocalPortalPreview || !isApiConfigured || !state.staffSession || !state.currentOrganisationId || !livePharmacyWorkspace) return;
    let cancelled = false;
    let inFlight = false;
    const organisationId = state.currentOrganisationId;
    const syncOrders = async () => {
      if (cancelled || inFlight) return;
      inFlight = true;
      try {
        const [records, draftRecords] = await Promise.all([getPortalOrders(organisationId), getOrderDrafts(organisationId)]);
        if (cancelled) return;
        const persistedOrders = records
          .slice()
          .sort((left, right) => left.createdAt.localeCompare(right.createdAt))
          .map((record, index, all) => mapPortalOrder(record, index, all, state.catalogue));
        const organisation = state.organisations.find(item => item.id === organisationId);
        const defaultPaymentRoute = preferredDraftPaymentRoute(Boolean(organisation?.worldpay.enabled), organisation?.worldpay.status ?? 'not-connected');
        const orderedDraftRecords = draftRecords.slice().sort((left, right) => left.createdAt.localeCompare(right.createdAt));
        const mappedDrafts = orderedDraftRecords.map((record, index) => mapPortalDraft(record, index, defaultPaymentRoute));
        const preferredIndex = preferredDraftIndex(orderedDraftRecords);
        const orders = [...persistedOrders, ...mappedDrafts];
        dispatch({
          type: 'SYNC_PORTAL_ORDERS',
          organisationId,
          orders,
          preferredActiveOrderId: preferredIndex >= 0 ? mappedDrafts[preferredIndex]?.id : undefined,
        });
      } catch (error) {
        if (!cancelled) console.warn('Order history sync unavailable:', error);
      } finally {
        inFlight = false;
      }
    };
    const syncVisibleOrders = () => {
      if (document.visibilityState === 'visible') void syncOrders();
    };
    void syncOrders();
    const interval = window.setInterval(() => void syncOrders(), PORTAL_ORDER_SYNC_INTERVAL_MS);
    window.addEventListener('focus', syncVisibleOrders);
    document.addEventListener('visibilitychange', syncVisibleOrders);
    return () => {
      cancelled = true;
      window.clearInterval(interval);
      window.removeEventListener('focus', syncVisibleOrders);
      document.removeEventListener('visibilitychange', syncVisibleOrders);
    };
  }, [livePharmacyWorkspace, state.currentOrganisationId, state.organisations, state.staffSession]);

  return (
    <AppContext.Provider value={{ state, dispatch }}>
      {children}
    </AppContext.Provider>
  );
}

export function useApp() {
  const ctx = useContext(AppContext);
  if (!ctx) throw new Error('useApp must be used within AppProvider');
  return ctx;
}
