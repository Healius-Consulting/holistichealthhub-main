export interface PublicPharmacy {
  id: string;
  name: string;
  tradingName: string;
  logoText: string;
  logoUrl?: string | null;
  gphcNumber: string;
  superintendent: string;
  address: string;
  primaryColour: string;
}

export interface EligibilitySubmissionInput {
  referralToken: string;
  firstName: string;
  surname: string;
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
}

export type EligibilitySubmissionRecord = Omit<EligibilitySubmissionInput, 'referralToken'> & {
  id: string;
  organisationId: string;
  pharmacyName: string;
  trainingSubmission?: boolean;
  status: 'New' | 'Under HHH review' | 'Approved' | 'Declined' | 'Rejected';
  reviewedAt: string | null;
  reviewerDisplay: string | null;
  pharmacyDecisionReason: string | null;
  pharmacyDecisionReasonNeedsReview: boolean;
  /** HHH-admin response only. Never returned to pharmacy staff. */
  reviewedBy?: string | null;
  /** HHH-admin response only. Never returned to pharmacy staff. */
  decisionNote?: string | null;
  recordsCheck: {
    status: 'pending' | 'completed';
    notes?: string | null;
    completedAt: string | null;
    completedBy?: string | null;
  };
  referral: {
    status: 'pending' | 'completed' | 'declined';
    notes?: string | null;
    completedAt: string | null;
    completedBy?: string | null;
  };
  emailDelivery: {
    status: 'not_sent' | 'queued' | 'sent' | 'failed';
    queuedAt: string | null;
    sentAt: string | null;
    failedAt: string | null;
  };
  patientId: string | null;
  submittedAt: string;
};

export interface EligibilitySubmissionReceipt {
  id: string;
  organisationId: string;
  pharmacyName: string;
  submittedAt: string;
}

export interface PublicDirectoryResult {
  id: string;
  /** Pharmacy name. Falls back to tradingName when the search API omits it. */
  name?: string;
  tradingName: string;
  gphcNumber: string;
  addressSummary: string;
  publicPhone?: string | null;
  website?: string | null;
  approximateMiles: number;
  deliveryCapability: 'none' | 'nationwide' | 'postcode_areas' | 'radius_miles';
  collectionAvailable: boolean;
  deliverySummary: string | null;
  intakeAvailability: 'available' | 'limited';
  /** Server-projected position on the approximate map. Never coordinates. */
  mapPosition: { xPercent: number; yPercent: number };
}

export function publicDirectoryPharmacyName(result: Pick<PublicDirectoryResult, 'name' | 'tradingName'>) {
  return result.name?.trim() || result.tradingName;
}

export const PUBLIC_DIRECTORY_MAP_RADIUS_MILES = 100;
export const PUBLIC_DIRECTORY_MAP_RADIUS_PERCENT = 42;

export interface PostcodeSearchReceipt {
  searchId: string;
  expiresAt: string;
  status: 'matched' | 'no_match' | 'not_found' | 'provider_unavailable';
  postcode: string;
  mapOrigin: { xPercent: number; yPercent: number };
  mapRadiusMiles?: number;
  results: PublicDirectoryResult[];
}

export interface ReferralTokenResolution {
  type: 'legacy_pharmacy_qr' | 'future_pharmacy_qr';
  intakeVersion: 'v1' | 'v2';
  pharmacy: PublicPharmacy;
}

export interface V2IntakeAnswers {
  firstName: string;
  surname: string;
  dob: string;
  mobile: string;
  email: string;
  postcode: string;
  conditions: string[];
  primaryCondition: string;
  tried2: boolean;
  psychExclusion: boolean;
  consentReferral: true;
  consentShare: true;
  marketing: boolean;
  heardAbout: string;
  consentVersion: 'general-public-v2.0' | 'pharmacy-qr-v2.0' | 'general-public-v2.1' | 'pharmacy-qr-v2.1';
  idempotencyKey: string;
}

export type V2IntakeInput = V2IntakeAnswers & (
  | { type: 'general_hhh_website'; searchId: string; selectedDirectoryProfileId: string | null }
  | { type: 'future_pharmacy_qr'; referralToken: string }
);

export interface V2IntakeReceipt {
  caseReference: string;
  submittedAt: string;
  assignmentStatus: 'awaiting_hhh_allocation' | 'provisional';
  provisionalPharmacyName: string | null;
  warning: 'SELECTED_PHARMACY_UNAVAILABLE' | null;
}

export interface V2EligibilityQueueItem {
  id: string;
  caseReference: string;
  patientDisplayName: string;
  submittedAt: string;
  displayStatus: string;
  assignmentStatus: string;
  pharmacyReviewStatus: string;
  outcomeStatus: string;
  version: number;
  legacy: boolean;
  sourceType?: string;
  sourceOrganisationId?: string | null;
  assignedOrganisationId?: string | null;
  firstName?: string;
  surname?: string;
  mobile?: string;
  email?: string;
  postcode?: string;
  followUpStatus?: string;
  nextFollowUpAt?: string | null;
  locationPreferenceOrganisationId?: string | null;
  locationPreferenceDistanceMetres?: number | null;
  pharmacyActivated?: boolean;
  destinationLocked?: boolean;
}

export interface CuraleafValidationCheck {
  id: string;
  label: string;
  passed: boolean;
  detail: string;
}

export interface CuraleafValidationReport {
  passed: boolean;
  checkedAt: string;
  observedCustomerId: string | null;
  productSampleCount: number;
  checks: CuraleafValidationCheck[];
  message: string;
}

export interface CuraleafConnectionStatus {
  configured: boolean;
  connected: boolean;
  writeConfigured?: boolean;
  approved?: boolean;
  status?: 'not_configured' | 'credential_update_required' | 'validated' | 'connected' | 'attention';
  environment: 'test' | 'production';
  /** When the credential last succeeded against Curaleaf. Null means never confirmed. */
  checkedAt: string | null;
  message?: string;
  activated?: boolean;
  maskedIdentifier?: string;
  /** Curaleaf's non-secret customer/account identifier for the authorised pharmacy. */
  customerId?: string;
  validation?: CuraleafValidationReport;
  sampleAvailable?: boolean;
}

export interface CuraleafFormula {
  formulaForm: string;
  id: string;
  printedName: string;
  state: string;
  unit: string;
}

export interface CuraleafProduct {
  customerId: string;
  formulaId: string;
  formulaName: string;
  formulaUnit: string;
  id: string;
  patientPackPrice: string;
  quantity: number;
  state: string;
  wholesalePackPrice?: string;
  quoteBankInStock?: boolean;
  quoteBankStockStatus?: 'in_stock' | 'low_stock' | 'out_of_stock';
  quoteBankQuotedAt?: string;
}

export interface CuraleafCatalogue {
  environment: 'test' | 'production';
  fetchedAt: string;
  formulas: CuraleafFormula[];
  products: CuraleafProduct[];
  formulaTotal: number;
  productTotal: number;
  quoteBankUpdatedAt?: string | null;
  quoteBankPackCount?: number;
}

export type CuraleafDevCatalogue = CuraleafCatalogue;

export interface CuraleafQuoteItem {
  packId: string;
  quantity: number;
  inStock: boolean;
  stockStatus?: 'in_stock' | 'low_stock' | 'out_of_stock';
  wholesalePackPrice: string;
  patientPackPrice: string;
}

export interface CuraleafQuote {
  shippingPrice: string;
  taxRate: string;
  items: CuraleafQuoteItem[];
}

export interface CuraleafPricingSnapshot extends CuraleafQuote {
  quotedAt: string;
  environment: 'test' | 'production';
  productTotalPence: number;
  wholesaleProductPence: number;
  shippingPence: number;
}

export interface CuraleafQuoteRequestItem {
  packId: string;
  quantity: number;
}

export interface CuraleafPurchaseOrderItem {
  id: string;
  purchaseOrderId: string;
  productId: string;
  formulaId: string;
  packSize: number;
  packsOrderedCount: number;
  packsAllocatedCount: number;
  packsReturnedCount: number;
  unit: string;
}

export interface CuraleafShippingAddress {
  line1?: string;
  line2?: string;
  city?: string;
  county?: string;
  postcode?: string;
  country?: string;
  name?: string;
}

export interface CuraleafPurchaseOrder {
  id: string;
  state: string;
  courier: string;
  customerReference: string | null;
  issuedDate: string;
  createdAt: string;
  shippingAddress?: Array<CuraleafShippingAddress | string>;
  items: CuraleafPurchaseOrderItem[];
}

export interface CuraleafShipmentItem {
  id: string;
  shipmentId: string;
  purchaseOrderItemId: string;
  batchNumber: string;
  batchExpiryDate: string;
  packCount: number;
  packsReturnedCount: number;
  packPrice: string;
  productId: string;
  productPackSize: number;
  sku: string;
  unit: string;
  formulaId: string;
}

export interface CuraleafShipment {
  id: string;
  purchaseOrderId: string;
  purchaseOrderCustomerReference: string | null;
  purchaseOrderIssuedDate: string | null;
  shipmentCharge: string;
  taxRate: string;
  createdAt: string;
  shippingAddress?: Array<CuraleafShippingAddress | string>;
  items: CuraleafShipmentItem[];
}

export interface CuraleafPrescriber {
  id: string;
  name: string;
  initials: string;
  pin: string;
  gmcNumber: number | null;
  gphcNumber: string | null;
  state: string;
}

export interface CuraleafPrescriptionItem {
  id: string;
  prescriptionId: string;
  formulaId: string;
  formulaName: string;
  unit: string;
  unitsAssignedCount: number;
  unitsNeededCount: number;
}

export interface ExpiryCheckState {
  isPaid: boolean;
  isDispatched: boolean;
  isArrivedAtPharmacy: boolean;
  recommendation: 'cancel_and_redo' | 'awaiting_delivery_redo' | 'ready_to_collect_redo';
}

export interface RedoOrderContext {
  originalOrderId: string;
  isPaidRedo: boolean;
  prefilledLineItems: Array<{ packId: string; quantity: number }>;
  originalTotalPence: number;
  priceDifferencePence: number;
  requireCuraleafAuth: true;
}

export interface CuraleafPrescription {
  id: string;
  serialNumber?: string;
  issueDate: string;
  expiryDate: string;
  prescriberId: string;
  prescriberName: string;
  state: string;
  items: CuraleafPrescriptionItem[];
}

export interface CuraleafActivity {
  environment: 'test' | 'production';
  fetchedAt: string;
  prescribers: CuraleafPrescriber[];
  prescriptions: CuraleafPrescription[];
  purchaseOrders: CuraleafPurchaseOrder[];
  shipments: CuraleafShipment[];
  prescriberTotal: number;
  prescriptionTotal: number;
  purchaseOrderTotal: number;
  shipmentTotal: number;
}

export type RedoPriceResolution = 'absorb';

export function activeRedoPriceResolution(value: unknown): RedoPriceResolution | undefined {
  return value === 'absorb' ? value : undefined;
}

export type CuraleafQuoteCheckPhase = 'PRE_PAYMENT' | 'POST_PAYMENT' | 'FINAL_PLACEMENT' | 'REPLACEMENT';

export interface CuraleafQuoteCheckSummary {
  id: string;
  phase: CuraleafQuoteCheckPhase;
  status: 'MATCHED' | 'CHANGED' | 'OUT_OF_STOCK' | 'RECONCILIATION_REQUIRED' | 'ABSORBED' | 'CANCELLED';
  checkedAt: string;
  basketFingerprint: string;
  comparedWithQuoteCheckId?: string | null;
  patientTotalPence: number;
  wholesaleTotalPence: number;
  shippingPence: number;
  patientDeltaPence?: number;
  wholesaleDeltaPence?: number;
  stockAvailable: boolean;
}

export interface CuraleafPlacementSummary {
  route: 'CLINIC_BARCODE' | 'MANUAL_PRESCRIPTION';
  stage:
    | 'DRAFT'
    | 'SCANNING_CLINIC_PRESCRIPTION'
    | 'AWAITING_PAYMENT'
    | 'CHECKING_PRESCRIBER'
    | 'AWAITING_PRESCRIBER_VERIFICATION'
    | 'CREATING_PRESCRIPTION'
    | 'UPLOADING_PRESCRIPTION_IMAGE'
    | 'AWAITING_PRESCRIPTION_ACTIVATION'
    | 'UPLOAD_CORRECTION_REQUIRED'
    | 'CREATING_PURCHASE_ORDER'
    | 'PLACED'
    | 'CORRECTION_REQUIRED'
    | 'TERMINAL';
  prescriberState?: 'UNVERIFIED' | 'VERIFIED' | 'ARCHIVED' | null;
  prescriptionState?: 'ACTIVE' | 'FULFILLED' | 'EXPIRED' | 'CANCELLED' | 'PENDING' | null;
  nextCheckAt?: string | null;
  attentionReason?: 'prescriber_verification' | 'prescription_activation' | 'image_reupload' | 'provider_correction' | 'reconciliation' | null;
  supportReference?: string | null;
  waitingSince?: string | null;
  slaDueAt?: string | null;
  slaAlert?: boolean;
  slaPolicy?: 'three_hours' | 'next_working_day_noon' | null;
  updatedAt: string;
}

export interface PaymentAllocationSummary {
  id: string;
  paymentId: string;
  amountPence: number;
  status: 'ACTIVE' | 'TRANSFER_PENDING' | 'TRANSFERRED' | 'REFUNDED' | 'RELEASED' | 'RECONCILIATION_REQUIRED';
  sourceOrderId?: string | null;
  replacementOrderId?: string | null;
  updatedAt: string;
}

export interface OrderResolutionSummary {
  status: 'OPEN' | 'REPLACEMENT_PENDING' | 'REFUND_REQUIRED' | 'REFUND_VERIFYING' | 'RECONCILIATION_REQUIRED' | 'REPLACED' | 'REFUNDED' | 'SPLIT_RESOLVED';
  reason?: 'CANCELLED' | 'REPLACED' | 'REFUNDED' | 'SPLIT_RESOLVED' | null;
  resolvedAt?: string | null;
  archivedAt?: string | null;
}

export interface PortalOrderInput {
  draftId?: string;
  organisationId: string;
  paymentRoute?: 'manual' | 'worldpay';
  patientId: string;
  medicineTotalPence?: number;
  dispensingFeePence: number;
  pharmacyDeliveryPence: number;
  totalPence?: number;
  quoteSnapshot?: Record<string, unknown>;
  pricingQuote?: CuraleafQuote;
  /** Client-captured display metadata; the backend remains authoritative for the payment-gate quote check. */
  prePaymentQuote?: {
    checkedAt: string;
    basketFingerprint: string;
    quote: CuraleafQuote;
  };
  lineItems: Array<{
    productId?: string;
    packId: string;
    formulaId?: string;
    name?: string;
    quantity: number;
    unitPricePence?: number;
    localPrescriptionId?: string;
    wholesalePackPricePence?: number;
  }>;
  prescriptions: Array<{
    /** Client-only correlation key used while the prescription is still being persisted. */
    clientKey?: string;
    /** Canonical HHH prescription UUID after persistence. */
    hhhPrescriptionId?: string;
    /** Legacy client key. New callers must use clientKey. */
    id?: string;
    fileId: string;
    clinicScanId?: string;
    curaleafPrescriptionId?: string;
    serialNumber: string;
    issueDate: string;
    expiryDate?: string;

    patient: {
      name: string;
      dob: string;
    };
    prescriber: {
      id?: string;
      pin: string;
      gmcNumber: number | null;
      gphcNumber: string | null;
      name: string;
      initials: string;
    };
    items: Array<{
      formulaId: string;
      unitsNeededCount: number;
      packId: string;
      quantity: number;
    }>;
  }>;
  currency: 'GBP';
  redoContext?: {
    originalOrderId: string | number;
    isPaidRedo: boolean;
    originalTotalPence?: number;
    priceDifferencePence?: number;
    requireCuraleafAuth?: true;
    priceResolution?: RedoPriceResolution;
  };
}

export interface PortalPatientDirectoryRecord {
  patients: PortalPatientRecord[];
  enquiries: PortalPendingEnquiryRecord[];
  counts: {
    patients: number;
    pendingEnquiries: number;
    referred: number;
    active: number;
  };
}

export interface PortalPendingEnquiryRecord {
  id: string;
  submittedAt: string;
  caseReference: string;
  displayStatus: 'New enquiry' | 'Under HHH review';
  sourceType: 'general_hhh_website' | 'future_pharmacy_qr' | 'legacy_pharmacy_qr';
  firstName: string;
  surname: string;
  dob: string;
  email: string;
  mobile: string;
  postcode: string;
  conditions: string[];
  primaryCondition: string | null;
  triedTwoTreatments?: boolean | null;
  psychiatricExclusion?: boolean | null;
  heardAbout?: string | null;
}

export interface PortalPatientRecord {
  id: string;
  organisationId: string;
  firstName: string;
  surname: string;
  dob: string;
  email: string;
  mobile: string;
  address: string;
  postcode: string;
  status: 'referred' | 'active' | 'inactive';
  conditions?: string[];
  primaryCondition?: string | null;
  referralSource?: string | null;
  marketingConsent?: boolean | null;
  triedTwoTreatments?: boolean | null;
  psychiatricExclusion?: boolean | null;
  heardAbout?: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface PatientRegisterExportRow {
  id: string;
  name: string;
  email: string;
  mobile: string;
  dob: string;
  organisationId: string;
  pharmacyName: string;
  gphcNumber: string;
  stage: string;
  date: string | null;
}

export interface PatientRegisterExportResult {
  rows: PatientRegisterExportRow[];
  resultCount: number;
  generatedAt: string;
  recordScopeHash: string;
}

export interface PortalCuraleafOrderState {
  status: 'prescription_processing' | 'prescription_pending' | 'prescription_mismatch' | 'prescription_closed' | 'reconciliation_required' | 'quote_review_required' | 'purchase_order_submitted';
  prescriptionState?: 'ACTIVE' | 'FULFILLED' | 'EXPIRED' | 'CANCELLED' | 'PENDING';
  prescriptionId?: string;
  prescriberId?: string;
  prescriberName?: string;
  customerReference: string;
  purchaseOrderId?: string | null;
  purchaseOrderState?: 'CREATED' | 'PROCESSING' | 'FULLY_ALLOCATED' | 'CANCELLED' | null;
  courier?: string;
  shippingAddress?: Array<{ line1?: string; line2?: string; city?: string; county?: string; postcode?: string; country?: string; name?: string } | string>;
  issuedDate?: string | null;
  createdAt?: string | null;
  shipmentIds?: string[];
  shipments?: CuraleafShipment[];
  shipmentStates?: Record<string, string>;
  dispatchStatus?: 'not_dispatched' | 'partial' | 'complete';
  quantityMismatch?: boolean;
  lines?: FulfilmentLineRecord[];
  requestedItems?: Array<{ packId: string; quantity: number }>;
  placementRequest?: {
    endpoint: string;
    disposition: 'sent' | 'existing_not_replayed';
    items?: Array<{ productId: string; count: number }> | null;
    prescriptionIds?: string[] | null;
  } | null;
  supplierItems?: Array<{ productId: string | null; packsOrderedCount: number; packsAllocatedCount: number; packsReturnedCount: number }>;
  quote?: CuraleafQuote;
}

export interface PortalOrderRecord {
  id: string;
  orderNumber?: string;
  organisationId: string;
  patientId: string;
  lineItems: Array<{
    productId: string;
    formulaId: string;
    packId: string;
    name: string;
    quantity: number;
    unitPricePence: number;
    wholesalePackPricePence?: number;
  }>;
  prescriptions?: PortalOrderInput['prescriptions'];
  prescriptionFlow?: Record<string, PrescriptionFlowRecord>;
  medicineTotalPence?: number;
  dispensingFeePence: number;
  pharmacyDeliveryPence: number;
  deliveryPence?: number;
  totalPence: number;
  quotedTotalPence?: number;
  pharmacyContributionPence?: number;
  currency: 'GBP';
  paymentRoute: 'manual' | 'worldpay';
  paymentStatus: string;
  fulfilmentStatus: string;
  autoPlacementEnabled?: boolean;
  paidAt?: string;
  manualTender?: string;
  manualReference?: string;
  refund?: OrderRefundState;
  cancellation?: OrderCancellationState;
  curaleafCancellation?: CuraleafCancellationState;
  curaleafApprovedAt?: string;
  auditEvents?: Array<{ type: string; label: string; detail: string; occurredAt: string; reference?: string | null }>;
  status?: 'open' | 'archived' | 'rejected' | string;
  isExpired?: boolean;
  archivedAt?: string;
  archivedReason?: string;
  cycleStartedAt?: string;
  cycleExpiresAt?: string;
  unresolvedReason?: 'expired' | 'rejected' | 'cancelled' | null;
  redoEligible?: boolean;
  redoneByOrderId?: string | null;
  redoOfOrderId?: string | null;
  redoContext?: {
    originalOrderId: string | number;
    isPaidRedo: boolean;
    originalTotalPence?: number;
    priceDifferencePence?: number;
    requireCuraleafAuth?: boolean;
    unresolvedReason?: 'expired' | 'rejected';
    recommendation?: ExpiryCheckState['recommendation'];
    rootOrderId?: string | number;
    replacementSequence?: number;
    priceResolution?: RedoPriceResolution;
  };
  serialReuse?: {
    until: string | null;
    filePresent: boolean;
  } | null;
  expiryCheck?: ExpiryCheckState;
  pricingQuote?: CuraleafPricingSnapshot;
  quoteReview?: {
    status: 'required' | 'approved' | 'recreate_required' | 'awaiting_top_up' | 'awaiting_refund';
    type: 'out_of_stock' | 'patient_price_changed' | 'supplier_cost_changed';
    fingerprint: string;
    latestQuote: CuraleafQuote;
    differences: Array<{ category: 'stock' | 'patient_price' | 'supplier_cost'; field: string; packId?: string; previous: string | boolean; latest: string | boolean }>;
    checkedAt: string;
    patientDeltaPence?: number;
    approvedAt?: string;
    approvalNote?: string;
    pharmacyContributionPence?: number;
    hostedPaymentUrl?: string;
    refundAmountPence?: number;
  };
  quoteChecks?: CuraleafQuoteCheckSummary[];
  activeQuoteCheck?: CuraleafQuoteCheckSummary | null;
  paymentAllocation?: PaymentAllocationSummary | null;
  resolution?: OrderResolutionSummary | null;
  curaleafPlacement?: CuraleafPlacementSummary | null;
  curaleaf?: PortalCuraleafOrderState;
  curaleafSubOrders?: Record<string, PortalCuraleafOrderState>;
  createdAt: string;
  updatedAt: string;
}

export type PrescriptionFlowState = 'DRAFT' | 'AWAITING_PAYMENT' | 'PAID' | 'PENDING_PLACEMENT' | 'HELD_PRICE' | 'HELD_STOCK' | 'PLACED' | 'PARTIALLY_RECEIVED' | 'RECEIVED' | 'HELD_FOR_RENEWAL' | 'READY_FOR_COLLECTION' | 'COLLECTED' | 'EXPIRED' | 'CANCELLED_PURCHASE_ORDER' | 'CANCELLED_REFUNDED';

export interface FulfilmentLineRecord {
  lineId: string;
  purchaseOrderItemId?: string | null;
  productId: string;
  ordered: number;
  requested: number;
  sent: number | null;
  supplierReportedOrdered: number;
  allocated: number;
  shipped: number;
  returned: number;
  cancelledRemainder?: number;
  remainingExpected?: number;
  remaining: number;
  received: number;
  collected: number;
  backordered: boolean;
  quantityMismatch: boolean;
}

export interface PrescriptionFlowRecord {
  id: string;
  state: PrescriptionFlowState;
  payable: boolean;
  expiryDate: string;
  purchaseOrderId?: string | null;
  placedAt?: string | null;
  latestShipmentAt?: string | null;
  /** When the dispensary verified arrival. Distinct from `latestShipmentAt`, which is
   *  when Curaleaf dispatched — only the pharmacy can say a pack actually landed. */
  goodsInAt?: string | null;
  shipmentIds: string[];
  shipmentStates?: Record<string, 'partially_dispatched_to_pharmacy' | 'dispatched_to_pharmacy' | 'partially_received' | 'received' | 'ready_for_collection' | 'collected' | 'exception' | string>;
  lines: FulfilmentLineRecord[];
  dispatchStatus?: 'not_dispatched' | 'partial' | 'complete';
  quantityMismatch?: boolean;
  renewal?: {
    state: 'none' | 'boundary_alerted' | 'expired_alerted' | 'attaching' | 'attached' | 'manual_resolution';
    boundaryAt?: string;
    renewedPrescriptionId?: string;
    updatedAt?: string;
  };
  collectedAt?: string | null;
  manualPlaceRequired?: boolean;
}

export interface OrderDraftRecord {
  id: string;
  organisationId: string;
  patientId: string | null;
  status: 'draft';
  pharmacyDeliveryEnabledAtCreation: boolean;
  payload: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
}

export interface PrescriptionSerialAvailability {
  allowed: boolean;
  reason: string;
  occupyingOrderId?: string | null;
}

export interface PrescriberDirectoryRecord {
  id: string;
  name: string;
  initials: string;
  pin: string;
  gmcNumber: number | null;
  gphcNumber: string | null;
  active: boolean;
  curaleafIds: Record<string, string>;
  createdAt: string;
  updatedAt: string;
}

export interface GoLiveReadiness {
  organisationId: string;
  companyId: string | null;
  testAccount?: boolean;
  allocationHolding?: boolean;
  intakeReady: boolean;
  ready: boolean;
  curaleafTestAcknowledgementRequired?: boolean;
  status: 'onboarding' | 'intake_live' | 'live' | 'paused';
  gates: {
    gdprEvidence: {
      passed: boolean;
      exempt?: boolean;
      evidenceUrl: string | null;
      method?: 'document_link' | 'manual_receipt' | null;
      receivedAt?: string | null;
    };
    curaleafLive: { passed: boolean; environment?: 'test' | 'production'; validatedAt: string | null; secretStored: boolean };
  };
  operational?: PharmacyOperationalStatus;
}

export interface PharmacyOperationalStatus {
  intake: { live: boolean; label: 'Live' | 'Off' };
  workspace: { mode: 'training' | 'live' | 'paused'; label: 'Training' | 'Live' | 'Paused' };
  staff: { activeCount: number; invitedCount: number; passed: boolean; label: string };
  curaleaf: { connected: boolean; production: boolean; label: 'Waiting' | 'Test' | 'Production' };
  payment: { route: 'manual' | 'worldpay'; worldpayConnected: boolean; passed: boolean; label: string };
  intakeCall: { completed: boolean; label: 'Not logged' | 'Logged'; evidence: string | null };
  walkthrough: { completed: boolean; label: 'Not started' | 'Complete'; evidence: string | null };
  charges: { saved: boolean; label: 'Saved' | 'Missing'; evidence: string | null };
  premises: { confirmed: boolean };
  websitePack: { published: boolean };
  goLiveReady: boolean;
  missingGates: string[];
}

export interface OrderRefundState {
  id: string;
  status: 'pending_confirmation' | 'verifying' | 'reconciliation_required' | 'completed';
  amountPence: number;
  method: 'worldpay_portal' | 'pharmacy_manual';
  paymentReference: string;
  transactionReference?: string | null;
  reason: 'patient_cancelled' | 'replacement_price_changed';
  resolution: 'cancel' | 'replace_new_payment';
  requestedAt: string;
  requestedBy?: string;
  confirmedAt?: string | null;
  confirmedBy?: string | null;
  externalReference?: string | null;
  verificationReference?: string | null;
  verificationMessage?: string | null;
  verifiedAt?: string | null;
}

export interface CuraleafCancellationState {
  status: 'contact_required' | 'awaiting_confirmation' | 'confirmed';
  purchaseOrderId?: string | null;
  prescriptionId?: string | null;
  supportCaseId?: string | null;
  requestedAt: string;
  requestedBy?: string | null;
  contactReference?: string | null;
  contactNote?: string | null;
  contactedAt?: string | null;
  contactedBy?: string | null;
  confirmedAt?: string | null;
  confirmedBy?: string | null;
  confirmationReference?: string | null;
}

export interface OrderCancellationState {
  status: 'curaleaf_contact_required' | 'awaiting_curaleaf_confirmation' | 'refund_required' | 'cancelled';
  reason: 'added_in_error' | 'patient_request' | 'other';
  note?: string | null;
  requestedAt: string;
  requestedBy?: string | null;
  paymentLinkStatus?: 'not_applicable' | 'cancelled_in_platform' | 'late_payment_refund_required';
  paymentReference?: string | null;
}

export interface PrescriptionUploadRequest {
  organisationId: string;
  filename: string;
  contentType: 'application/pdf' | 'image/jpeg' | 'image/png';
  sizeBytes: number;
}

export interface PrescriptionUploadTarget {
  id: string;
  uploadUrl: string;
  expiresAt: string;
  requiredHeaders: Record<string, string>;
}

export interface CuraleafManualPrescriptionInput {
  organisationId: string;
  orderId: string;
  subOrderId?: string;
  fileId: string;
  serialNumber: string;
  issueDate: string;
  prescriber: {
    pin: string;
    gmcNumber: number | null;
    gphcNumber: string | null;
    name: string;
    initials: string;
  };
  items: Array<{
    formulaId: string;
    unitsNeededCount: number;
    packId: string;
    quantity: number;
  }>;
}

export interface CuraleafSubmissionResult {
  status: 'prescription_processing' | 'prescription_pending' | 'prescription_mismatch' | 'prescription_closed' | 'reconciliation_required' | 'quote_review_required' | 'purchase_order_submitted';
  prescriptionState?: 'ACTIVE' | 'FULFILLED' | 'EXPIRED' | 'CANCELLED' | 'PENDING';
  prescriptionId?: string;
  prescriberId?: string;
  prescriberName?: string;
  customerReference: string;
  purchaseOrderId?: string | null;
  purchaseOrderState?: 'CREATED' | 'PROCESSING' | 'FULLY_ALLOCATED' | 'CANCELLED' | null;
  quote: CuraleafQuote;
}

export interface CuraleafClinicPrescriptionInput {
  organisationId: string;
  orderId: string;
  subOrderId?: string;
  fileId: string;
  serialNumber: string;
}

export interface CuraleafClinicScan {
  scanId: string;
  status: 'processing' | 'ready';
  prescriptionId?: string;
  prescription?: {
    id: string;
    serialNumber: string;
    state: 'ACTIVE' | 'FULFILLED' | 'EXPIRED' | 'CANCELLED' | 'PENDING';
    issueDate: string;
    expiryDate: string;
    prescriberId: string;
    prescriberName: string;
    patient: {
      name: string;
      dob: string;
    } | null;
    items: Array<{
      formulaId: string;
      formulaName: string;
      unit: string;
      unitsNeededCount: number;
      unitsAssignedCount: number;
    }>;
  };
  prescriber?: {
    id: string;
    name: string;
    initials: string;
    gmcNumber: number | null;
    gphcNumber: string | null;
  };
  matchedItems?: Array<{
    packId: string;
    formulaId: string;
    formulaName: string;
    unit: string;
    packSize: number;
    quantity: number;
    unitsNeededCount: number;
    patientPackPrice: string;
  }>;
}

export interface CuraleafActivationInput {
  organisationId: string;
  customerId: string;
  /** Single Curaleaf X-API-Key for this pharmacy. Stored as writeApiKey for existing secrets. */
  writeApiKey: string;
  /** Pin the estate when replacing test credentials with live ones. Omit to discover from the key. */
  environment?: 'TEST' | 'PRODUCTION';
  /** @deprecated Curaleaf issues one key; ignored if sent. */
  readApiKey?: string;
  /** @deprecated No longer required; ignored by the API if sent. */
  portalEmail?: string;
}

export type CuraleafSupportReason = 'prescription_exception' | 'purchase_order_cancellation' | 'quote_review' | 'supplier_exception';
export type CuraleafSupportStatus = 'open' | 'contacted' | 'resolved';

export interface CuraleafSupportCase {
  id: string;
  organisationId: string;
  orderId: string;
  reason: CuraleafSupportReason;
  status: CuraleafSupportStatus;
  note: string;
  prescriptionId: string | null;
  purchaseOrderId: string | null;
  openedBy: string;
  openedByRole: 'hhh_admin' | 'pharmacy_staff';
  openedAt: string;
  contactedAt?: string;
  resolvedAt?: string;
  updatedAt: string;
}

export interface WorldpayConnectionInput {
  organisationId: string;
  username: string;
  password: string;
  entityId: string;
}

export interface WorldpayConnectionStatus {
  configured: boolean;
  connected: boolean;
  status?: 'verification_required' | 'connected' | 'attention';
  environment?: 'try' | 'live';
  /** When Worldpay last answered a real call. Null means never confirmed. */
  checkedAt?: string | null;
  maskedIdentifier?: string;
  updatedAt?: string;
}

export interface CreateOrganisationInput {
  name: string;
  tradingName: string;
  gphcNumber: string;
  superintendent: string;
  companyNumber?: string;
  mainContactName?: string;
  mainContactPhone?: string;
  mainContactEmail?: string;
  address: string;
  primaryColour: string;
  logoText: string;
  websiteDomains: string[];
  status: 'onboarding';
}

export interface UpdateOrganisationInput {
  name?: string;
  tradingName?: string;
  gphcNumber?: string;
  superintendent?: string;
  companyNumber?: string;
  mainContactName?: string;
  mainContactPhone?: string;
  mainContactEmail?: string;
  address?: string;
  addressLine1?: string;
  addressLine2?: string;
  locality?: string;
  county?: string;
  postcode?: string;
  primaryColour?: string;
  logoText?: string;
  websiteDomains?: string[];
  status?: 'onboarding' | 'intake_live' | 'live' | 'paused';
  portalName?: string;
}

export interface UpdatePharmacyProfileInput {
  name?: string;
  tradingName?: string;
  gphcNumber?: string;
  superintendent?: string;
  addressLine1?: string;
  addressLine2?: string;
  locality?: string;
  county?: string;
  postcode?: string;
  mainContactName?: string;
  mainContactPhone?: string;
  mainContactEmail?: string;
}

export interface CreatedOrganisation extends CreateOrganisationInput {
  id: string;
  referralToken: string;
  createdAt: string;
  updatedAt: string;
}

export type SetupTaskId =
  | 'pharmacy_profile'
  | 'curaleaf_account'
  | 'payment_route'
  | 'pricing'
  | 'notifications'
  | 'intake_call'
  | 'operational_readiness';

export interface PharmacySetupTask {
  id: SetupTaskId;
  completed: boolean;
  completedAt: string | null;
  completedBy: string | null;
  evidence: string | null;
}

export interface PharmacySetupStatus {
  organisationId: string;
  completed: boolean;
  completedCount: number;
  requiredCount: number;
  tasks: PharmacySetupTask[];
  updatedAt: string;
  operational?: PharmacyOperationalStatus;
}

export interface UpdatePharmacySetupTaskInput {
  organisationId: string;
  completed: boolean;
  evidence?: string;
}

export interface StaffAccessibilityPreferences {
  theme: 'light' | 'dark';
  textScale: 'default' | 'large' | 'larger';
  reduceMotion: boolean;
  enhancedFocus: boolean;
  underlineLinks: boolean;
  overviewView?: 'today' | 'handover' | 'operations' | 'pipeline';
  workspaceTourCompleted?: boolean;
}

export interface AuthenticatedSession {
  uid: string;
  email: string;
  displayName: string;
  role: 'hhh_admin' | 'pharmacy_staff';
  organisationId: string | null;
  surface: 'pharmacy' | 'admin';
  idleExpiresAt: string;
  absoluteExpiresAt: string;
  csrfToken: string;
}

export interface PharmacyOverview {
  asOf: string;
  organisation: {
    id: string;
    tradingName: string;
    status: 'onboarding' | 'intake_live' | 'live' | 'paused';
    trainingMode: boolean;
    allocationHoldingMode: boolean;
  };
  enquiries: {
    pendingCount: number;
    latestSubmittedAt: string | null;
    state: 'none' | 'hhh_reviewing';
  };
  summary: {
    activePatients: number;
    awaitingPayment: number;
    supplierFulfilment: number;
    readyForCollection: number;
    urgentTotal: number;
  };
  /**
   * Settled cash this calendar month. Null when the costing inputs could not
   * be read: the block is then omitted rather than published with revenue
   * counted and cost treated as zero. Finance is the collected-order ledger;
   * these figures are not the same question.
   */
  finance: {
    period: 'this_month';
    timezone: 'Europe/London';
    periodStart: string;
    periodEnd: string;
    revenuePence: number;
    revenueOrderCount: number;
    grossProfitPence: number;
    /** False when some paid orders in the window have no wholesale cost yet. */
    grossProfitComplete: boolean;
    costedOrderCount: number;
    averageSpendPence: number;
    payingPatientCount: number;
    awaitingPaymentCount: number;
    awaitingPaymentValuePence: number;
  } | null;
  priorityItems: Array<{
    id: string;
    kind: 'payment' | 'supplier' | 'collection' | 'repeat' | 'cancellation';
    ageDays: number;
    maskedPatientLabel: string;
    orderReference: string;
    recordTarget: { kind: 'patient' | 'order'; id: string };
    summary: string;
    actionLabel: string;
  }>;
  recentSessions: Array<{
    orderId: string;
    maskedPatientLabel: string;
    occurredAt: string;
    prescriptionCount: number;
    status: string;
  }>;
  handover: {
    activePatients: number;
    activePaymentLinks: number;
    supplierOrdersInProgress: number;
    agedCollections: number;
  };
  integrations: Array<{
    integration: 'curaleaf' | 'worldpay';
    /** Fixed vocabulary. `connected` requires a real successful check behind `checkedAt`. */
    state: 'connected' | 'degraded' | 'unavailable' | 'not-configured';
    environment: 'test' | 'production' | null;
    /** When the last call to the vendor actually succeeded. Null means never. */
    checkedAt: string | null;
    /** Plain-language reason; absent on older API deployments. */
    detail?: string;
  }>;
}

export interface PharmacyPrescriptionFinanceReport {
  organisationId: string;
  currency: 'GBP';
  range: { from: string | null; to: string | null };
  periodCounts: { '30': number; '90': number; '365': number; all: number };
  totals: {
    prescriptionCount: number;
    paidPrescriptionCount: number;
    pendingCollectionCount: number;
    pendingPatientRevenuePence: number;
    pendingPrescriptionCount: number;
    refundedPrescriptionCount: number;
    refundedPatientPence: number;
    refundPendingCount: number;
    refundPendingPatientPence: number;
    patientRevenuePence: number;
    productRevenuePence: number;
    dispensingFeesPence: number;
    pharmacyDeliveryFeesPence: number;
    wholesaleKnownForCount: number;
    wholesalePendingForCount: number;
    /** Subset of costed rows priced from the shared quote bank rather than a paid quote. */
    wholesaleEstimatedForCount?: number;
    wholesaleProductPence: number;
    shippingPence: number;
    wholesalePence: number;
    productMarginPence: number;
    totalContributionPence: number;
  };
  rows: Array<{
    orderId: string;
    patientId: string;
    patientName: string;
    createdAt: string;
    updatedAt: string;
    recognisedAt: string | null;
    refundedAt: string | null;
    financialEventAt: string;
    paymentStatus: string;
    fulfilmentStatus: string;
    recognised: boolean;
    realised: boolean;
    pendingCollection: boolean;
    refunded: boolean;
    refundPending: boolean;
    productRevenuePence: number;
    dispensingFeePence: number;
    pharmacyDeliveryPence: number;
    patientRevenuePence: number;
    wholesaleProductPence: number | null;
    shippingPence: number | null;
    wholesalePence: number | null;
    productMarginPence: number | null;
    totalContributionPence: number | null;
    wholesaleComplete: boolean;
    /** How the wholesale figure was resolved; absent on older API deployments. */
    wholesaleCostBasis?: 'paid_quote' | 'paid_quote_totals' | 'quote_bank' | null;
    wholesaleEstimated?: boolean;
    shippingKnown?: boolean;
    lines: Array<{
      packId: string;
      name: string;
      quantity: number;
      unitPricePence: number;
      wholesaleUnitPence: number | null;
      productMarginPence: number | null;
    }>;
  }>;
}

export interface Company {
  id: string;
  legalName: string;
  companyNumber: string;
  registeredAddress: string;
  ownerContact: {
    name: string;
    email: string;
    phone: string;
  };
  superintendent: {
    name: string;
    gphcNumber: string;
  };
  gdprConfirmed: boolean;
  gdprDocUrl: string | null;
  gdprEvidenceMethod?: 'document_link' | 'manual_receipt' | null;
  gdprReceiptRecordedAt?: string | null;
  gdprReceiptRecordedBy?: string | null;
  gdprConfirmedAt: string | null;
  gdprConfirmedBy: string | null;
  gdprComplianceFlag?: boolean;
  branchesOwned: string[];
  notes?: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface CuraleafValidationRecord {
  environment: 'test' | 'production';
  validatedAt: string;
  actor: string;
  maskedKey: string;
  observedCustomerId: string | null;
}

export interface PlacementLineItem {
  id: string;
  prescriptionId: string;
  orderId: string;
  formulaId: string;
  formulaName: string;
  unit: string;
  unitsNeededCount: number;
  packId: string;
  quantity: number;
  fixedPatientPricePence: number;
  allocatedDispensingFeePence: number;
  lineMedicineRevenuePence: number;
  linkSendWholesalePence: number;
  latestWholesalePence: number;
  placementState: 'PENDING_PLACEMENT' | 'HELD_PRICE' | 'HELD_STOCK' | 'CANCELLATION_PENDING_REFUND' | 'PLACED' | 'HELD_FOR_RENEWAL' | 'CANCELLED_REFUNDED';
  rejectionReason?: string;
  holdEpisodeStartedAt?: string | null;
  notifiedAt48h?: string | null;
  boundaryScheduledAt?: string;
  refundId?: string | null;
  updatedAt: string;
}

export interface PrescriptionPlacement {
  id: string;
  prescriptionId: string;
  orderId: string;
  pharmacyId: string;
  lines: PlacementLineItem[];
  overallState: 'PENDING_PLACEMENT' | 'HELD_PRICE' | 'HELD_STOCK' | 'CANCELLATION_PENDING_REFUND' | 'PLACED' | 'HELD_FOR_RENEWAL' | 'CANCELLED_REFUNDED';
  purchaseOrderId?: string | null;
  placedAt?: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface RefundRecord {
  id: string;
  orderId: string;
  lineId: string;
  pharmacyId: string;
  amountPence: number;
  originalPaymentRef: string;
  paymentRoute: 'manual' | 'worldpay';
  cause: string;
  status: 'pending_confirmation' | 'completed';
  idempotencyKey: string;
  confirmedAt?: string | null;
  confirmedBy?: string | null;
  createdAt: string;
}

export interface SubstitutionProposal {
  id: string;
  lineId: string;
  originalPackId: string;
  substitutePackId: string;
  formulaId: string;
  formulaName: string;
  unitsTotal: number;
  quantity: number;
  wholesalePackPricePence: number;
  wholesaleTotalPence: number;
  rank: number;
}

export interface PortalOrganisation {
  id: string;
  orgId: string; // Parent Company ID
  name: string;
  tradingName: string;
  logoText: string;
  emailLogoUrl?: string | null;
  emailLogoStoragePath?: string | null;
  emailLogoWidth?: number | null;
  emailLogoHeight?: number | null;
  emailLogoUpdatedAt?: string | null;
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
  websiteDomains?: string[];
  primaryColour: string;
  status: 'onboarding' | 'intake_live' | 'live' | 'paused';
  referralToken?: string;
  portalName?: string;
  worldpayEnabled?: boolean;
  defaultPaymentRoute?: 'manual' | 'worldpay';
  pharmacyDeliveryEnabled?: boolean;
  autoPlacementEnabled?: boolean;
  curaleafTestValidation?: CuraleafValidationRecord | null;
  curaleafLiveValidation?: CuraleafValidationRecord | null;
  curaleafLiveSecretStoredAt?: string | null;
  testAccount?: boolean;
  gdprExempt?: boolean;
  workspaceClassification?: 'standard' | 'training' | 'allocation_holding';
  intakeEnabled?: boolean;
}

export const HOLISTIC_HEALTH_HUB_ALLOCATION_LABEL = 'Holistic Health Hub Allocation';

const PLATFORM_TEST_PHARMACY_IDS = new Set([
  '70913a3071c34a41952ed532927af58c', // Primary
  'f486a221223644a5b072f06de399ab0e', // Alternate
]);

/** Primary and Alternate — always-on platform Test pharmacies, not dummy Training. */
export function isPlatformTestPharmacy(organisation: {
  id?: string | null;
  name?: string | null;
  tradingName?: string | null;
  testAccount?: boolean;
  workspaceClassification?: string | null;
} | string | null | undefined) {
  const id = typeof organisation === 'string' ? organisation : organisation?.id;
  if (!id) return false;
  return PLATFORM_TEST_PHARMACY_IDS.has(id.replaceAll('-', '').toLowerCase());
}

/**
 * Same ID set as `isPlatformTestPharmacy`.
 * Use only to hide them from the public directory and HHH referral finance.
 */
export function isTrainingDirectoryPharmacy(organisation: {
  id: string;
  name?: string | null;
  tradingName?: string | null;
  testAccount?: boolean;
  workspaceClassification?: string | null;
}) {
  return isPlatformTestPharmacy(organisation);
}

export function workspaceClassificationLabel(classification?: string | null) {
  if (classification === 'allocation_holding') return HOLISTIC_HEALTH_HUB_ALLOCATION_LABEL;
  if (classification === 'training') return 'Test workspace';
  return 'Standard workspace';
}

export interface OrganisationLogoUploadTarget {
  uploadUrl: string;
  requiredHeaders: Record<string, string>;
  storagePath: string;
}

export interface PaymentSettings {
  organisationId: string;
  pharmacyId?: string;
  defaultPaymentRoute: 'manual' | 'worldpay';
  worldpayEnabled?: boolean;
  pharmacyDeliveryEnabled: boolean;
  updatedAt: string;
}

export interface AdminReferralFinanceRow {
  id: string;
  organisationId: string;
  pharmacyId?: string;
  pharmacyName: string;
  patientId: string;
  patientName?: string;
  patientEmail?: string;
  referralSubmissionId: string | null;
  kind: 'new_referral' | 'annual_patient';
  amountPence: number;
  currency: 'GBP';
  dueDate: string;
  occurredAt: string;
}

export interface AdminReferralFinanceReport {
  currency: 'GBP';
  range: { from: string | null; to: string | null };
  organisationId: string | null;
  pharmacyId?: string | null;
  totals: {
    eventCount: number;
    newReferralCount: number;
    annualPatientCount: number;
    amountPence: number;
  };
  byPharmacy: Array<{
    organisationId: string;
    pharmacyId?: string;
    pharmacyName: string;
    newReferralCount: number;
    annualPatientCount: number;
    amountPence: number;
  }>;
  rows: AdminReferralFinanceRow[];
}

export interface PortalSession {
  uid: string;
  email: string | null;
  role: 'hhh_admin' | 'pharmacy_staff';
  pharmacyId: string | null;
  organisationId: string | null;
  profile: Record<string, unknown> | null;
  organisation: PortalOrganisation | null;
  company?: Company | null;
}

export interface PharmacyStaffAccount {
  uid: string;
  email: string;
  displayName: string;
  role: 'pharmacy_staff';
  pharmacyId: string;
  organisationId?: string;
  contactRole: 'owner' | 'staff';
  status: 'invited' | 'active' | 'disabled';
  createdAt: string;
}

export interface CreatePharmacyStaffInput {
  pharmacyId: string;
  organisationId?: string;
  email: string;
  displayName: string;
}

export interface PharmacyStaffInvitation extends PharmacyStaffAccount {
  invitationQueued: boolean;
}

export interface StaffInvitationResend {
  uid: string;
  email: string;
  invitationQueued: boolean;
}

export interface PlatformAdminAccount {
  uid: string;
  email: string;
  displayName: string;
  role: 'hhh_admin';
  status: 'invited' | 'active' | 'disabled';
  createdAt: string;
}

export interface CreatePlatformAdminInput {
  email: string;
  displayName: string;
}

export interface PlatformAdminInvitation extends PlatformAdminAccount {
  invitationQueued: boolean;
}
