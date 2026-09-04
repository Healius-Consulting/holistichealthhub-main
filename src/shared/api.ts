import { shouldDispatchSessionEnded } from './sessionEnded';
import type {
  CuraleafConnectionStatus,
  CuraleafActivationInput,
  CreateOrganisationInput,
  CreatedOrganisation,
  EligibilitySubmissionInput,
  EligibilitySubmissionReceipt,
  PharmacyStaffAccount,
  PharmacyStaffInvitation,
  CreatePharmacyStaffInput,
  PlatformAdminAccount,
  PlatformAdminInvitation,
  StaffInvitationResend,
  CreatePlatformAdminInput,
  PortalOrganisation,
  PublicPharmacy,
  StaffAccessibilityPreferences,
  PortalSession,
  UpdateOrganisationInput,
  UpdatePharmacyProfileInput,
  PaymentSettings,
  CuraleafDevCatalogue,
  CuraleafCatalogue,
  CuraleafQuote,
  CuraleafQuoteRequestItem,
  PortalPatientDirectoryRecord,
  PortalOrderInput,
  PortalOrderRecord,
  ExpiryCheckState,
  PrescriptionSerialAvailability,
  PrescriptionUploadRequest,
  PrescriptionUploadTarget,
  CuraleafClinicScan,
  WorldpayConnectionInput,
  WorldpayConnectionStatus,
  AdminReferralFinanceReport,
  PatientRegisterExportResult,
  GoLiveReadiness,
  SetupTaskId,
  AuthenticatedSession,
  PharmacyOverview,
  PharmacyPrescriptionFinanceReport,
  PostcodeSearchReceipt,
  ReferralTokenResolution,
  V2EligibilityQueueItem,
  V2IntakeInput,
  V2IntakeReceipt,
} from './contracts';

const configuredApiUrl = import.meta.env.VITE_API_BASE_URL as string | undefined;
const API_BASE_URL = configuredApiUrl?.trim().startsWith('/')
  ? configuredApiUrl.replace(/\/$/, '')
  : import.meta.env.DEV && configuredApiUrl?.trim()
    ? configuredApiUrl.replace(/\/$/, '')
    : '';

function apiBaseUrl() {
  // The portal root login is a neutral entry point. Its auth requests are
  // explicitly routed server-side to the role-derived surface.
  if (typeof window !== 'undefined' && window.location.pathname === '/login') return '';
  return API_BASE_URL;
}

export const isApiConfigured = true;

type ApiSecurityTokenProvider = () => Promise<Record<string, string>>;
let securityTokenProvider: ApiSecurityTokenProvider | null = null;
let csrfToken: string | null = null;
const GET_CACHE_TTL_MS = 10_000;
const responseCache = new Map<string, { expiresAt: number; value: unknown }>();
const inFlightGets = new Map<string, { generation: number; request: Promise<unknown> }>();
let cacheGeneration = 0;

function invalidateResponseCache() {
  cacheGeneration += 1;
  responseCache.clear();
  inFlightGets.clear();
}

export function setApiSecurityTokenProvider(provider: ApiSecurityTokenProvider | null) {
  securityTokenProvider = provider;
  invalidateResponseCache();
}

export function setApiCsrfToken(token: string | null) {
  csrfToken = token;
  invalidateResponseCache();
}

export class ApiRequestError extends Error {
  readonly status: number;
  readonly code: string;

  constructor(status: number, code: string, message: string) {
    super(message);
    this.status = status;
    this.code = code;
    this.name = 'ApiRequestError';
  }
}

async function performApiRequest<T>(path: string, init?: RequestInit): Promise<T> {
  const securityHeaders = securityTokenProvider ? await securityTokenProvider() : {};
  const method = (init?.method || 'GET').toUpperCase();
  const response = await fetch(`${apiBaseUrl()}${path}`, {
    ...init,
    credentials: 'include',
    headers: { 'Content-Type': 'application/json', ...securityHeaders, ...(!['GET', 'HEAD', 'OPTIONS'].includes(method) && csrfToken ? { 'X-CSRF-Token': csrfToken } : {}), ...init?.headers },
  });
  if (!response.ok) {
    const body = await response.json().catch(() => null) as { code?: string; message?: string } | null;
    const retryAfter = response.headers.get('retry-after');
    const rateMessage = response.status === 429
      ? `Too many requests. Try again${retryAfter ? ` in ${retryAfter} seconds` : ' shortly'}.`
      : null;
    const code = body?.code ?? 'REQUEST_FAILED';
    if (shouldDispatchSessionEnded(response.status, code, typeof window === 'undefined' ? '' : window.location.pathname)) {
      window.dispatchEvent(new CustomEvent('hhh:session-ended', { detail: { code } }));
    }
    throw new ApiRequestError(response.status, code, body?.message || rateMessage || `Request failed with status ${response.status}.`);
  }
  if (response.status === 204) return undefined as T;
  return response.json() as Promise<T>;
}

type ApiRequestInit = RequestInit & { skipGetCache?: boolean };

async function apiRequest<T>(path: string, init?: ApiRequestInit): Promise<T> {
  const { skipGetCache, ...fetchInit } = init ?? {};
  const method = (fetchInit.method || 'GET').toUpperCase();
  if (method !== 'GET' || skipGetCache) {
    if (method !== 'GET') invalidateResponseCache();
    return performApiRequest<T>(path, fetchInit);
  }

  const cached = responseCache.get(path);
  if (cached && cached.expiresAt > Date.now()) return cached.value as T;
  if (cached) responseCache.delete(path);

  const generation = cacheGeneration;
  const existing = inFlightGets.get(path);
  if (existing?.generation === generation) return existing.request as Promise<T>;

  const request = performApiRequest<T>(path, fetchInit)
    .then(value => {
      if (cacheGeneration === generation) {
        responseCache.set(path, { value, expiresAt: Date.now() + GET_CACHE_TTL_MS });
      }
      return value;
    })
    .finally(() => {
      if (inFlightGets.get(path)?.request === request) inFlightGets.delete(path);
    });
  inFlightGets.set(path, { generation, request });
  return request;
}

export function getPublicPharmacy(referralToken: string) {
  return apiRequest<PublicPharmacy>(`/v1/public/pharmacies/by-token/${encodeURIComponent(referralToken)}`);
}

export function searchPublicPharmacies(postcode: string) {
  return apiRequest<PostcodeSearchReceipt>('/v2/public/postcode-searches', { method: 'POST', body: JSON.stringify({ postcode }) });
}

export function resolvePublicReferralToken(referralToken: string) {
  return apiRequest<ReferralTokenResolution>('/v2/public/referral-tokens/resolve', { method: 'POST', body: JSON.stringify({ token: referralToken }) });
}

export function createV2Intake(input: V2IntakeInput) {
  return apiRequest<V2IntakeReceipt>('/v2/public/intakes', { method: 'POST', body: JSON.stringify(input) });
}

export function getAdminGeneralIntake() {
  return apiRequest<{ records: V2EligibilityQueueItem[]; nextCursor: string | null }>('/v2/portal/admin/intake/general');
}

export function getAdminPharmacyReferralIntake() {
  return apiRequest<{ records: V2EligibilityQueueItem[]; nextCursor: string | null }>('/v2/portal/admin/intake/pharmacy-referrals');
}

export function getAdminIntakeDetail(caseId: string) {
  return apiRequest<Record<string, unknown>>(`/v2/portal/admin/intake/${encodeURIComponent(caseId)}`);
}

export function getAssignmentCandidates(caseId: string, query = '') {
  return apiRequest<{ records: Array<Record<string, unknown>> }>(`/v2/portal/admin/intake/${encodeURIComponent(caseId)}/assignment-candidates?q=${encodeURIComponent(query)}`);
}

export function reassignIntake(caseId: string, input: { destinationOrganisationId: string; reasonCode: string; note: string | null; expectedVersion: number }) {
  return apiRequest<Record<string, unknown>>(`/v2/portal/admin/intake/${encodeURIComponent(caseId)}/reassign`, { method: 'POST', body: JSON.stringify(input) });
}

export function updateIntakeFollowUp(caseId: string, input: Record<string, unknown>) {
  return apiRequest<Record<string, unknown>>(`/v2/portal/admin/intake/${encodeURIComponent(caseId)}/follow-up`, { method: 'PATCH', body: JSON.stringify(input) });
}

export function decideV2ProgrammeOnboarding(caseId: string, input: { expectedVersion: number; decision: 'approved' | 'declined'; notes: string | null }) {
  return apiRequest<Record<string, unknown>>(`/v2/portal/admin/intake/${encodeURIComponent(caseId)}/programme-onboarding`, { method: 'POST', body: JSON.stringify(input) });
}

export function getDirectoryProfilesV2() {
  return apiRequest<{ records: Array<Record<string, unknown>> }>('/v2/portal/admin/directory-profiles');
}

export function saveDirectoryProfileV2(organisationId: string, input: Record<string, unknown>) {
  return apiRequest<Record<string, unknown>>(`/v2/portal/admin/directory-profiles/${encodeURIComponent(organisationId)}`, { method: 'PUT', body: JSON.stringify(input) });
}

export function changeDirectoryLifecycleV2(organisationId: string, action: 'submit-review' | 'publish' | 'pause' | 'unpublish') {
  return apiRequest<Record<string, unknown>>(`/v2/portal/admin/directory-profiles/${encodeURIComponent(organisationId)}/${action}`, { method: 'POST', body: JSON.stringify({}) });
}

export function changeDirectoryQrV2(organisationId: string, action: 'activate' | 'pause') {
  return apiRequest<Record<string, unknown>>(`/v2/portal/admin/directory-profiles/${encodeURIComponent(organisationId)}/qr/${action}`, { method: 'POST', body: JSON.stringify({}) });
}

export async function downloadDirectoryQrPackV2(organisationId: string) {
  const securityHeaders = securityTokenProvider ? await securityTokenProvider() : {};
  const response = await fetch(`${apiBaseUrl()}/v2/portal/admin/directory-profiles/${encodeURIComponent(organisationId)}/qr-pack`, {
    credentials: 'include', headers: { ...securityHeaders, ...(csrfToken ? { 'X-CSRF-Token': csrfToken } : {}) },
  });
  if (!response.ok) {
    const body = await response.json().catch(() => null) as { code?: string; message?: string } | null;
    throw new ApiRequestError(response.status, body?.code ?? 'REQUEST_FAILED', body?.message ?? 'The content pack could not be downloaded.');
  }
  return response.blob();
}

export async function getAuthCsrf() {
  const result = await performApiRequest<{ csrfToken: string }>('/v1/auth/csrf');
  setApiCsrfToken(result.csrfToken);
  return result.csrfToken;
}

export async function createAuthenticatedSession(idToken: string) {
  if (!csrfToken) await getAuthCsrf();
  const session = await performApiRequest<AuthenticatedSession>('/v1/auth/session', { method: 'POST', body: JSON.stringify({ idToken }) });
  setApiCsrfToken(session.csrfToken);
  return session;
}

export async function getAuthenticatedSession() {
  const session = await performApiRequest<AuthenticatedSession>('/v1/auth/session');
  setApiCsrfToken(session.csrfToken);
  return session;
}

export async function continueAuthenticatedSession() {
  const session = await performApiRequest<AuthenticatedSession>('/v1/auth/activity', { method: 'POST', body: JSON.stringify({}) });
  setApiCsrfToken(session.csrfToken);
  return session;
}

export async function deleteAuthenticatedSession() {
  await performApiRequest<void>('/v1/auth/session', { method: 'DELETE' });
  setApiCsrfToken(null);
}

/**
 * Rewrite a patient's recorded conditions.
 *
 * Any pharmacy staff member may do this: it is transcription from the clinic
 * letter, not a clinical decision reserved to a role. The server rewrites both
 * the eligibility submission and the patient's own rows so the Portal and the
 * Admin register show the same list.
 */
export function updatePatientConditions(patientId: string, input: { conditionCodes: string[]; primaryConditionCode: string }) {
  return apiRequest<{
    patientId: string;
    conditions: Array<{ conditionCode: string; primary: boolean }>;
    primaryConditionCode: string;
    changed: boolean;
  }>(`/v1/portal/patients/${encodeURIComponent(patientId)}/conditions`, {
    method: 'PATCH',
    body: JSON.stringify(input),
  });
}

/** The admin twin of {@link updatePatientConditions}; the register is cross-tenant. */
export function updateAdminPatientConditions(patientId: string, input: { organisationId: string; conditionCodes: string[]; primaryConditionCode: string }) {
  return apiRequest<{
    patientId: string;
    conditions: Array<{ conditionCode: string; primary: boolean }>;
    primaryConditionCode: string;
    changed: boolean;
  }>(`/v1/portal/admin/patients/${encodeURIComponent(patientId)}/conditions`, {
    method: 'PATCH',
    body: JSON.stringify(input),
  });
}

export function getPharmacyOverview() {
  return apiRequest<PharmacyOverview>('/v1/portal/overview');
}

export function createEligibilitySubmission(input: EligibilitySubmissionInput) {
  return apiRequest<EligibilitySubmissionReceipt>('/v1/public/eligibility-submissions', {
    method: 'POST', body: JSON.stringify(input),
  });
}

export function completeReferralRecordsCheck(submissionId: string, input: { organisationId: string; notes: string }) {
  return apiRequest<Record<string, unknown>>(`/v1/portal/admin/eligibility-submissions/${encodeURIComponent(submissionId)}/records-check`, {
    method: 'POST',
    body: JSON.stringify(input),
  });
}

export function recordReferralDecision(submissionId: string, input:
  | { organisationId: string; decision: 'completed'; notes?: string | null }
  | { organisationId: string; decision: 'declined'; notes?: string | null; pharmacyDecisionReason: string }
) {
  return apiRequest<Record<string, unknown>>(`/v1/portal/admin/eligibility-submissions/${encodeURIComponent(submissionId)}/referral-decision`, {
    method: 'POST',
    body: JSON.stringify(input),
  });
}

export function updateEligibilityPharmacyReason(submissionId: string, input: { organisationId: string; pharmacyDecisionReason: string | null }) {
  return apiRequest<Record<string, unknown>>(`/v1/portal/admin/eligibility-submissions/${encodeURIComponent(submissionId)}/pharmacy-reason`, {
    method: 'PATCH',
    body: JSON.stringify(input),
  });
}

export function queueReferralPatientEmail(submissionId: string, organisationId: string) {
  return apiRequest<{ status: 'queued'; outboxId: string }>(`/v1/portal/admin/eligibility-submissions/${encodeURIComponent(submissionId)}/email`, {
    method: 'POST',
    body: JSON.stringify({ organisationId }),
  });
}

export function getCuraleafConnectionStatus(organisationId?: string) {
  const query = organisationId ? `?organisationId=${encodeURIComponent(organisationId)}` : '';
  return apiRequest<CuraleafConnectionStatus>(`/v1/portal/integrations/curaleaf/status${query}`);
}

export function getDevCuraleafCatalogue() {
  return apiRequest<CuraleafDevCatalogue>('/v1/dev/curaleaf/catalog');
}

/**
 * The catalogue response is cacheable, which is what makes navigating between
 * screens cheap — but it also means a staff-triggered refresh can be answered
 * from the browser's disk cache and look like a button that does nothing. When
 * someone has explicitly asked for fresh data, `refreshToken` changes the URL so
 * every cache layer between here and Curaleaf is stepped around.
 */
export function getCuraleafCatalogue(organisationId: string, refreshToken?: number) {
  const query = `organisationId=${encodeURIComponent(organisationId)}`;
  const bust = refreshToken ? `&refreshedAt=${encodeURIComponent(String(refreshToken))}` : '';
  return apiRequest<CuraleafCatalogue>(`/v1/portal/integrations/curaleaf/catalog?${query}${bust}`);
}

export function getDevCuraleafQuote(items: CuraleafQuoteRequestItem[]) {
  return apiRequest<CuraleafQuote>('/v1/dev/curaleaf/quote', {
    method: 'POST',
    body: JSON.stringify({ items }),
  });
}

export function getCuraleafQuote(organisationId: string, items: CuraleafQuoteRequestItem[]) {
  return apiRequest<CuraleafQuote>('/v1/portal/integrations/curaleaf/quote', {
    method: 'POST',
    body: JSON.stringify({ organisationId, items }),
  });
}

export function getPortalPatientDirectory(organisationId: string) {
  return apiRequest<PortalPatientDirectoryRecord>(`/v1/portal/patient-directory?organisationId=${encodeURIComponent(organisationId)}`);
}

export function getPortalOrders(organisationId: string, options?: { patientId?: string; unresolvedOnly?: boolean }) {
  const params = new URLSearchParams({ organisationId });
  if (options?.patientId) params.set('patientId', options.patientId);
  if (options?.unresolvedOnly) params.set('unresolvedOnly', 'true');
  return apiRequest<PortalOrderRecord[]>(`/v1/portal/orders?${params.toString()}`);
}

export function recordPortalGoodsReceipt(shipmentId: string, input: {
  organisationId: string;
  orderId?: string;
  items: Array<{
    productId: string;
    expectedQuantity: number;
    receivedQuantity: number;
    batchNumber?: string | null;
    expiryDate?: string | null;
    issue?: 'short' | 'damaged' | 'incorrect' | 'none';
    notes?: string;
  }>;
}) {
  return apiRequest<Record<string, unknown>>(`/v1/portal/shipments/${encodeURIComponent(shipmentId)}/goods-receipts`, {
    method: 'POST',
    body: JSON.stringify(input),
  });
}

export function updatePortalShipmentStatus(shipmentId: string, input: {
  organisationId: string;
  orderId?: string;
  status: 'ready_for_collection' | 'collected' | 'exception';
}) {
  return apiRequest<Record<string, unknown> & { notification?: { status: 'queued'; outboxId: string; recipient: string } }>(
    `/v1/portal/shipments/${encodeURIComponent(shipmentId)}/status`,
    { method: 'PATCH', body: JSON.stringify(input) },
  );
}

export function handoutPortalOrder(orderId: string, input: { organisationId: string; prescriptionId?: string; partial?: boolean; shipmentId?: string }) {
  return apiRequest<{ order: PortalOrderRecord; idempotent: boolean }>(
    `/v1/portal/orders/${encodeURIComponent(orderId)}/handout`,
    { method: 'POST', body: JSON.stringify(input) },
  );
}

export function cancelAndArchivePortalOrder(orderId: string, input: { organisationId: string }) {
  return apiRequest<{ success: boolean; cancelledOrderId: string }>(
    `/v1/portal/orders/${encodeURIComponent(orderId)}/cancel-and-archive`,
    { method: 'POST', body: JSON.stringify(input) },
  );
}

export function getUnresolvedPortalOrders(organisationId: string, patientId: string) {
  return apiRequest<PortalOrderRecord[]>(
    `/v1/portal/patients/${encodeURIComponent(patientId)}/unresolved-orders?organisationId=${encodeURIComponent(organisationId)}`,
  );
}

export function evaluatePortalOrderExpiry(orderId: string, organisationId: string) {
  return apiRequest<ExpiryCheckState & {
    orderId: string;
    cycleStartedAt: string;
    cycleExpiresAt: string;
    isCycleExpired: boolean;
    unresolvedReason: 'expired' | 'rejected' | null;
    redoEligible: boolean;
    evaluatedAt: string;
  }>(`/v1/portal/orders/${encodeURIComponent(orderId)}/evaluate-28day-expiry?organisationId=${encodeURIComponent(organisationId)}`);
}

export function requestPortalOrderCancellation(orderId: string, input: {
  organisationId: string;
  reason: 'added_in_error' | 'patient_request' | 'other';
  note?: string;
}) {
  return apiRequest<PortalOrderRecord>(`/v1/portal/orders/${encodeURIComponent(orderId)}/cancellations`, {
    method: 'POST',
    body: JSON.stringify(input),
  });
}

export function recordPortalCuraleafCancellation(orderId: string, input: {
  organisationId: string;
  action: 'contacted' | 'confirmed';
  reference: string;
  note?: string;
}) {
  return apiRequest<PortalOrderRecord>(`/v1/portal/orders/${encodeURIComponent(orderId)}/curaleaf-cancellation`, {
    method: 'POST',
    body: JSON.stringify(input),
  });
}

export function createPortalOrderRefund(orderId: string, input: {
  organisationId: string;
  reason?: 'patient_cancelled';
  resolution?: 'cancel';
  scope: 'full' | 'partial';
  amountPence: number;
  includedMedicineIds?: string[];
  dispensingPercent?: 0 | 25 | 50 | 75 | 100;
  deliveryPercent?: 0 | 25 | 50 | 75 | 100;
}) {
  return apiRequest<import('./contracts').OrderRefundState>(`/v1/portal/orders/${encodeURIComponent(orderId)}/refunds/manual`, {
    method: 'POST',
    body: JSON.stringify(input),
  });
}

export function confirmPortalOrderRefund(orderId: string, refundId: string, input: { organisationId: string; externalReference: string }) {
  return apiRequest<import('./contracts').OrderRefundState>(`/v1/portal/orders/${encodeURIComponent(orderId)}/refunds/${encodeURIComponent(refundId)}/confirm`, {
    method: 'POST',
    body: JSON.stringify(input),
  });
}

export function createPortalOrder(input: PortalOrderInput) {
  return apiRequest<PortalOrderRecord>('/v1/portal/orders', {
    method: 'POST',
    body: JSON.stringify(input),
  });
}

export async function uploadPrescriptionFile(input: PrescriptionUploadRequest, file: File) {
  const target = await apiRequest<PrescriptionUploadTarget>('/v1/portal/prescription-files/upload-url', {
    method: 'POST',
    body: JSON.stringify(input),
  });
  const response = await fetch(target.uploadUrl, {
    method: 'PUT',
    headers: target.requiredHeaders,
    body: file,
  });
  if (!response.ok) throw new Error(`Prescription upload failed with status ${response.status}.`);
  await apiRequest(`/v1/portal/prescription-files/${encodeURIComponent(target.id)}/complete`, {
    method: 'POST',
    body: JSON.stringify({ organisationId: input.organisationId }),
  });
  return target;
}

export function recordPortalManualPayment(orderId: string, input: {
  organisationId: string;
  amountPence: number;
  tender: 'cash' | 'epos' | 'bank_transfer' | 'other';
  reference: string;
  notes?: string;
}) {
  return apiRequest<Record<string, unknown>>(`/v1/portal/orders/${encodeURIComponent(orderId)}/payments/manual`, {
    method: 'POST',
    body: JSON.stringify(input),
  });
}

export function createWorldpaySession(orderId: string, input: {
  organisationId: string;
}) {
  return apiRequest<{ paymentId: string; transactionReference: string; provider: Record<string, unknown>; linkExpiresAt: string; reused?: boolean }>(`/v1/portal/orders/${encodeURIComponent(orderId)}/payments/worldpay-session`, {
    method: 'POST',
    body: JSON.stringify(input),
  });
}

export function resendWorldpayPaymentLink(orderId: string, input: { organisationId: string }) {
  return apiRequest<{ paymentId: string; transactionReference: string; provider: Record<string, unknown>; linkExpiresAt: string }>(`/v1/portal/orders/${encodeURIComponent(orderId)}/payment-links/resend`, {
    method: 'POST',
    body: JSON.stringify(input),
  });
}

export type PublicPaymentStatusResponse = {
  status: 'paid' | 'pending' | 'failed' | 'cancelled';
  id?: string;
  orderId?: string;
  transactionReference?: string;
  amountPence?: number;
  currency?: string;
  createdAt?: string;
  updatedAt?: string;
  message?: string;
};

export function getPublicPaymentStatus(params: { ref?: string; receipt?: string; order?: string; success?: boolean }): Promise<PublicPaymentStatusResponse> {
  const query = new URLSearchParams();
  if (params.ref) query.set('ref', params.ref);
  if (params.receipt) query.set('receipt', params.receipt);
  if (params.order) query.set('order', params.order);
  if (params.success) query.set('success', 'true');
  return apiRequest<PublicPaymentStatusResponse>(`/v1/public/payments/status?${query.toString()}`, { skipGetCache: true });
}

export type PublicPaymentReceiptLine = {
  key: 'medicine' | 'dispensing' | 'pharmacyDelivery' | 'delivery';
  label: string;
  amountPence: number;
};

export type PublicPaymentReceiptResponse = {
  id: string;
  amountPence: number;
  currency: string;
  status: string;
  createdAt: string;
  updatedAt?: string | null;
  orderNumber?: string | null;
  refundedAmountPence?: number | null;
  partial?: boolean;
  breakdown?: PublicPaymentReceiptLine[];
};

export function getPublicPaymentReceipt(token: string) {
  return apiRequest<PublicPaymentReceiptResponse>(`/v1/public/receipts/${encodeURIComponent(token)}`, { skipGetCache: true });
}

export function attachPrescriptionRenewal(orderId: string, prescriptionId: string, input: { organisationId: string; renewedPrescription: Record<string, unknown> }) {
  return apiRequest(`/v1/portal/orders/${encodeURIComponent(orderId)}/prescriptions/${encodeURIComponent(prescriptionId)}/renewal`, { method: 'POST', body: JSON.stringify(input) });
}

export function placePrescriptionManually(orderId: string, prescriptionId: string, organisationId: string) {
  return apiRequest(`/v1/portal/orders/${encodeURIComponent(orderId)}/prescriptions/${encodeURIComponent(prescriptionId)}/place`, { method: 'POST', body: JSON.stringify({ organisationId }) });
}

export function scanCuraleafClinicPrescription(organisationId: string, fileId: string) {
  return apiRequest<CuraleafClinicScan>('/v1/portal/integrations/curaleaf/prescriptions/scan', {
    method: 'POST',
    body: JSON.stringify({ organisationId, fileId }),
  });
}

export function activateCuraleafPharmacy(input: CuraleafActivationInput) {
  return apiRequest<CuraleafConnectionStatus>('/v1/portal/integrations/curaleaf/credentials', {
    method: 'PUT',
    body: JSON.stringify(input),
  });
}

export function refreshCuraleafConnection(organisationId: string) {
  return apiRequest<CuraleafConnectionStatus>('/v1/portal/integrations/curaleaf/refresh', {
    method: 'POST',
    body: JSON.stringify({ organisationId }),
  });
}

export function approveCuraleafPharmacy(organisationId: string) {
  return apiRequest<CuraleafConnectionStatus & { setup?: import('./contracts').PharmacySetupStatus }>(
    `/v1/portal/admin/organisations/${encodeURIComponent(organisationId)}/approve-curaleaf`,
    { method: 'POST', body: JSON.stringify({}) },
  );
}

export function goLiveOrganisation(organisationId: string, input: { acknowledgedCuraleafTest?: boolean } = {}) {
  return apiRequest<GoLiveReadiness>(`/v1/portal/admin/organisations/${encodeURIComponent(organisationId)}/go-live`, { method: 'POST', body: JSON.stringify(input) });
}

export function getGoLiveReadiness(organisationId: string) {
  return apiRequest<GoLiveReadiness>(`/v1/portal/admin/organisations/${encodeURIComponent(organisationId)}/go-live-readiness`);
}

export function updateAdminPharmacySetupTask(
  organisationId: string,
  taskId: SetupTaskId,
  input: { completed: boolean; evidence?: string | null },
) {
  return apiRequest<import('./contracts').PharmacySetupStatus>(
    `/v1/portal/admin/organisations/${encodeURIComponent(organisationId)}/setup/${encodeURIComponent(taskId)}`,
    { method: 'PATCH', body: JSON.stringify(input) },
  );
}

export function revertLiveOrganisation(organisationId: string) {
  return apiRequest<GoLiveReadiness>(`/v1/portal/admin/organisations/${encodeURIComponent(organisationId)}/revert-live`, { method: 'POST', body: JSON.stringify({}) });
}

export function recordPharmacyGdprEvidenceReceived(organisationId: string) {
  return apiRequest<{ success: true; organisationId: string; companyId: string | null; gdprConfirmed: true; evidenceMethod: 'manual_receipt'; receivedAt: string }>(
    `/v1/portal/admin/organisations/${encodeURIComponent(organisationId)}/gdpr/record-received`,
    { method: 'POST', body: JSON.stringify({ received: true }) },
  );
}

export function recordCompanyGdprEvidenceReceived(companyId: string) {
  return apiRequest<{ success: true; companyId: string; gdprConfirmed: true; evidenceMethod: 'manual_receipt'; receivedAt: string; activatedOrganisationIds: string[] }>(
    `/v1/portal/admin/companies/${encodeURIComponent(companyId)}/gdpr/record-received`,
    { method: 'POST', body: JSON.stringify({ received: true }) },
  );
}

export function getOrderDrafts(organisationId: string) {
  return apiRequest<import('./contracts').OrderDraftRecord[]>(`/v1/portal/order-drafts?organisationId=${encodeURIComponent(organisationId)}`);
}

export function createOrderDraft(input: { organisationId: string; patientId?: string | null; payload?: Record<string, unknown> }) {
  return apiRequest<import('./contracts').OrderDraftRecord>('/v1/portal/order-drafts', { method: 'POST', body: JSON.stringify(input) });
}

export function updateOrderDraft(id: string, input: { organisationId: string; patientId?: string | null; payload?: Record<string, unknown> }) {
  return apiRequest<import('./contracts').OrderDraftRecord>(`/v1/portal/order-drafts/${encodeURIComponent(id)}`, { method: 'PATCH', body: JSON.stringify(input) });
}

export function deleteOrderDraft(id: string, organisationId: string) {
  return apiRequest<void>(`/v1/portal/order-drafts/${encodeURIComponent(id)}?organisationId=${encodeURIComponent(organisationId)}`, { method: 'DELETE' });
}

export function deletePrescriptionFile(id: string, organisationId: string) {
  return apiRequest<void>(`/v1/portal/prescription-files/${encodeURIComponent(id)}?organisationId=${encodeURIComponent(organisationId)}`, { method: 'DELETE' });
}

export function getPrescriptionFileDownloadUrl(id: string, organisationId: string) {
  return apiRequest<{ downloadUrl: string; expiresAt: string }>(
    `/v1/portal/prescription-files/${encodeURIComponent(id)}/download-url?organisationId=${encodeURIComponent(organisationId)}`,
    { skipGetCache: true },
  );
}

export function checkPrescriptionSerialAvailability(input: {
  organisationId: string;
  serialNumber?: string;
  issueDate?: string;
  sourceOrderId?: string | null;
  sourceSerial?: string | null;
  patientId?: string | null;
  clinicScanId?: string | null;
  curaleafPrescriptionId?: string | null;
}) {
  return apiRequest<PrescriptionSerialAvailability>('/v1/portal/prescription-serials/availability', {
    method: 'POST',
    body: JSON.stringify(input),
  });
}

export function getPrescriberDirectory(organisationId: string, query = '') {
  const search = new URLSearchParams({ organisationId });
  if (query.trim()) search.set('query', query.trim());
  return apiRequest<import('./contracts').PrescriberDirectoryRecord[]>(`/v1/portal/prescribers?${search}`);
}

export function createPrescriberDirectoryRecord(input: Omit<import('./contracts').PrescriberDirectoryRecord, 'id' | 'active' | 'curaleafIds' | 'createdAt' | 'updatedAt'> & { organisationId: string }) {
  return apiRequest<import('./contracts').PrescriberDirectoryRecord>('/v1/portal/prescribers', { method: 'POST', body: JSON.stringify(input) });
}

export function resolvePortalQuoteReview(orderId: string, input: {
  organisationId: string;
  action: 'absorb' | 'refresh';
}) {
  return apiRequest<{ action: string; order: import('./contracts').PortalOrderRecord }>(
    `/v1/portal/orders/${encodeURIComponent(orderId)}/quote-review/resolve`,
    { method: 'POST', body: JSON.stringify(input) },
  );
}

export function connectWorldpayPharmacy(input: WorldpayConnectionInput) {
  return apiRequest<WorldpayConnectionStatus>('/v1/portal/integrations/worldpay/credentials', {
    method: 'PUT',
    body: JSON.stringify(input),
  });
}

export function removeWorldpayConnection(organisationId: string) {
  return apiRequest<WorldpayConnectionStatus>(`/v1/portal/integrations/worldpay/credentials?organisationId=${encodeURIComponent(organisationId)}`, {
    method: 'DELETE',
    body: JSON.stringify({ organisationId }),
  });
}

export function getWorldpayConnectionStatus(organisationId: string) {
  return apiRequest<WorldpayConnectionStatus>(`/v1/portal/integrations/worldpay/status?organisationId=${encodeURIComponent(organisationId)}`);
}

export function refreshWorldpayConnection(organisationId: string) {
  return apiRequest<WorldpayConnectionStatus>('/v1/portal/integrations/worldpay/refresh', {
    method: 'POST',
    body: JSON.stringify({ organisationId }),
  });
}

export function createOrganisation(input: CreateOrganisationInput) {
  return apiRequest<CreatedOrganisation>('/v1/portal/admin/organisations', {
    method: 'POST',
    body: JSON.stringify(input),
  });
}

export function getAdminOrganisations() {
  return apiRequest<PortalOrganisation[]>('/v1/portal/admin/organisations');
}

export function getReferralLink(organisationId?: string) {
  const query = organisationId ? `?organisationId=${encodeURIComponent(organisationId)}` : '';
  return apiRequest<{ url: string }>(`/v1/portal/referral-link${query}`);
}

export function getAdminReferralFinance(filters: { from?: string; to?: string; organisationId?: string } = {}) {
  const query = new URLSearchParams();
  if (filters.from) query.set('from', filters.from);
  if (filters.to) query.set('to', filters.to);
  if (filters.organisationId) query.set('organisationId', filters.organisationId);
  const suffix = query.size ? `?${query.toString()}` : '';
  return apiRequest<AdminReferralFinanceReport>(`/v1/portal/admin/finance/referrals${suffix}`);
}

export function getPharmacyPrescriptionFinance(filters: { from?: string; to?: string } = {}) {
  const query = new URLSearchParams();
  if (filters.from) query.set('from', filters.from);
  if (filters.to) query.set('to', filters.to);
  const suffix = query.size ? `?${query.toString()}` : '';
  return apiRequest<PharmacyPrescriptionFinanceReport>(`/v1/portal/finance/prescriptions${suffix}`);
}

export function recordPatientRegisterExport(input: { query: string; organisationId: string; status: string; from: string | null; to: string | null; expectedScopeHash: string }) {
  return apiRequest<PatientRegisterExportResult>('/v1/portal/admin/patient-exports', {
    method: 'POST',
    body: JSON.stringify(input),
  });
}

export function getAdminPatientRegister(input: { query: string; organisationId: string; status: string; from: string | null; to: string | null }) {
  const query = new URLSearchParams({ query: input.query, organisationId: input.organisationId, status: input.status });
  if (input.from) query.set('from', input.from);
  if (input.to) query.set('to', input.to);
  return apiRequest<PatientRegisterExportResult>(`/v1/portal/admin/patient-register?${query.toString()}`);
}

export function updateOrganisation(organisationId: string, input: UpdateOrganisationInput) {
  return apiRequest<PortalOrganisation>(`/v1/portal/admin/organisations/${encodeURIComponent(organisationId)}`, {
    method: 'PATCH',
    body: JSON.stringify(input),
  });
}

export function updatePharmacyProfile(input: UpdatePharmacyProfileInput) {
  return apiRequest<PortalOrganisation>('/v1/portal/organisation/profile', {
    method: 'PATCH',
    body: JSON.stringify(input),
  });
}

export async function uploadOrganisationLogo(organisationId: string, file: File) {
  const target = await apiRequest<import('./contracts').OrganisationLogoUploadTarget>(`/v1/portal/admin/organisations/${encodeURIComponent(organisationId)}/logo/upload-url`, {
    method: 'POST',
    body: JSON.stringify({ filename: file.name, contentType: file.type, sizeBytes: file.size }),
  });
  const upload = await fetch(target.uploadUrl, { method: 'PUT', headers: target.requiredHeaders, body: file });
  if (!upload.ok) throw new Error(`Logo upload failed with status ${upload.status}.`);
  return apiRequest<PortalOrganisation>(`/v1/portal/admin/organisations/${encodeURIComponent(organisationId)}/logo/complete`, {
    method: 'POST',
    body: JSON.stringify({ storagePath: target.storagePath }),
  });
}

export function removeOrganisationLogo(organisationId: string) {
  return apiRequest<PortalOrganisation>(`/v1/portal/admin/organisations/${encodeURIComponent(organisationId)}/logo`, { method: 'DELETE' });
}

export function getPharmacyStaff(organisationId: string) {
  return apiRequest<PharmacyStaffAccount[]>(`/v1/portal/admin/staff?organisationId=${encodeURIComponent(organisationId)}`);
}

export function createPharmacyStaffInvitation(input: CreatePharmacyStaffInput) {
  return apiRequest<PharmacyStaffInvitation>('/v1/portal/admin/staff/invitations', {
    method: 'POST',
    body: JSON.stringify({ ...input, role: 'pharmacy_staff' }),
  });
}

export function resendPharmacyStaffInvitation(uid: string) {
  return apiRequest<StaffInvitationResend>(`/v1/portal/admin/staff/${encodeURIComponent(uid)}/invitation-resend`, {
    method: 'POST',
  });
}

export function removePharmacyStaff(uid: string) {
  return apiRequest<void>(`/v1/portal/admin/staff/${encodeURIComponent(uid)}`, { method: 'DELETE' });
}

export function assignPharmacyOwner(uid: string) {
  return apiRequest<PharmacyStaffAccount[]>(`/v1/portal/admin/staff/${encodeURIComponent(uid)}/owner`, {
    method: 'POST',
  });
}

export function getPlatformAdmins() {
  return apiRequest<PlatformAdminAccount[]>('/v1/portal/admin/platform-admins');
}

export function createPlatformAdminInvitation(input: CreatePlatformAdminInput) {
  return apiRequest<PlatformAdminInvitation>('/v1/portal/admin/platform-admins/invitations', {
    method: 'POST',
    body: JSON.stringify(input),
  });
}

export function resendPlatformAdminInvitation(uid: string) {
  return apiRequest<StaffInvitationResend>(`/v1/portal/admin/platform-admins/${encodeURIComponent(uid)}/invitation-resend`, {
    method: 'POST',
  });
}

export function removePlatformAdmin(uid: string) {
  return apiRequest<void>(`/v1/portal/admin/platform-admins/${encodeURIComponent(uid)}`, { method: 'DELETE' });
}

export function resetPharmacyStaffMfa(uid: string, input: { verifiedIdentity: true; reason: string }) {
  return apiRequest<{ uid: string; resetQueued: boolean }>(`/v1/portal/admin/staff/${encodeURIComponent(uid)}/mfa-reset`, {
    method: 'POST',
    body: JSON.stringify(input),
  });
}

export async function requestStaffPasswordReset(email: string) {
  if (!csrfToken) await getAuthCsrf();
  return performApiRequest<{ accepted: true }>('/v1/auth/password-reset', {
    method: 'POST',
    body: JSON.stringify({ email: email.trim().toLowerCase() }),
  });
}

export async function notifyStaffMfaEnrolled(idToken: string) {
  if (!csrfToken) await getAuthCsrf();
  return performApiRequest<{ queued: true }>('/v1/auth/mfa-enrolled', {
    method: 'POST',
    body: JSON.stringify({}),
    headers: { Authorization: `Bearer ${idToken}` },
  });
}

export function getStaffAccessibilityPreferences() {
  return apiRequest<StaffAccessibilityPreferences>('/v1/portal/preferences');
}

export function getPortalSession() {
  return apiRequest<PortalSession>('/v1/portal/session');
}

export function updateStaffAccessibilityPreferences(preferences: StaffAccessibilityPreferences) {
  return apiRequest<StaffAccessibilityPreferences>('/v1/portal/preferences', {
    method: 'PATCH',
    body: JSON.stringify(preferences),
  });
}

export function updatePaymentSettings(
  organisationId: string,
  settings: { defaultPaymentRoute?: 'manual' | 'worldpay'; pharmacyDeliveryEnabled?: boolean } | 'manual' | 'worldpay',
) {
  return apiRequest<PaymentSettings>('/v1/portal/payment-settings', {
    method: 'PUT',
    body: JSON.stringify({
      organisationId,
      ...(typeof settings === 'string' ? { defaultPaymentRoute: settings } : settings),
    }),
  });
}
