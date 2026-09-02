import { createHash, randomUUID } from 'node:crypto';
import cors from 'cors';
import express, { type NextFunction, type Request, type Response } from 'express';
import { ipKeyGenerator, rateLimit } from 'express-rate-limit';
import helmet from 'helmet';
import { z } from 'zod';
import { prescriptionDateWindowStatus } from './prescription-date.js';
import { CONDITION_IDS, normaliseConditionId, type ConditionId } from './conditions.js';
import type { DocumentReference } from 'firebase-admin/firestore';
import { audit } from './audit.js';
import { identity, requireRole, requireStaff, tenantFor } from './auth.js';
import { allowedOrigins, config, publicAppHostnames } from './config.js';
import { CuraleafRequestError, curaleafConnectionStatus, curaleafList, curaleafPlatformList, curaleafPlatformRequest, curaleafRequest, scanClinicPrescription, submitClinicPrescription, submitManualPrescription, uploadClinicPrescriptionImage, validateCuraleafCredentials } from './curaleaf.js';
import { fetchCuraleafAccountSnapshot } from './curaleaf-mirror.js';
import { appCheck, auth, firestore, storage } from './firebase.js';
import { HttpError, nowIso } from './http.js';
import { cached, invalidateCache } from './cache.js';
import { createRecord, getRecord, getTenantRecord, invalidateCollectionCache, listTenantRecords, listTenantRecordsByField, updateTenantRecord } from './repository.js';
import { readIntegrationSecret, writeIntegrationSecret } from './secrets.js';
import type { FulfilmentStatus, IntegrationName, PaymentStatus } from './types.js';
import { createHostedPaymentSession, parseWorldpayWebhookEvent, validateWorldpayCredentials, type WorldpayCredential } from './worldpay.js';
import { reconcileWorldpayPaymentDocument } from './worldpay-reconciliation.js';
import { activatePatientForOrder, completeReferral, recordCollectedDispense } from './patient-finance.js';
import { adminReferralFinance, pharmacyPrescriptionFinance } from './finance-reporting.js';
import { allocateDispensingFee, calculateExpiryBoundaryDate, calculatePrescriptionExpiry, recordPlacementLedgerEvent } from './placement-engine.js';
import { canMarkShipmentReady, prescriptionCollectionRollup, receivedLinesHaveBatchDetails, shipmentReceiptStatus } from './shipment-workflow.js';
import { enrichOrderRecord, evaluateOrderCycle } from './order-cycle.js';
import { refundAdapter } from './refund-adapter.js';
import { canPatientCreateOrder } from './patient-order-eligibility.js';
import type { Company, CuraleafValidationRecord, PrescriptionPlacement } from './types.js';
import { autoSubmitPaidPrescriptions, prepareManualPrescriptionsForOrder } from './curaleaf-reconciliation.js';
import { loadUploadedPrescriptionFile } from './prescription-file.js';
import { FLOW_CONFIG, validDispensingFeePence } from './flow-config.js';
import { deterministicSubOrderId, messageId, paymentLinkExpiryAt, prescriptionIsCurrent, settlePaidRedoTotals } from './order-flow.js';
import { queuePatientMessage } from './notification-outbox.js';
import { callCuraleafExtension } from './supplier-extension.js';
import { migrateMasterFlowV2 } from './flow-migration.js';
import { planOrderHandout, shipmentsReadyForHandout } from './order-handout.js';
import { eligibilityReviewProjection, negativeEligibilityStatus, pharmacyDecisionReasonSchema, pharmacyReasonAuditDetails } from './eligibility-view.js';
import { canAcceptPublicIntake, canAutoActivateIntake, goLiveGateState, isExplicitCuraleafTestAccount } from './go-live.js';
import { createStaffSession, issueCsrf, requestSurfaceHost, requireCsrf, revokeCurrentSession, revokeUserSessions, securityEvent, sessionPayload, touchCurrentSession } from './session-auth.js';
import { buildPharmacyOverview } from './pharmacy-overview.js';
import { randomToken } from './session-utils.js';
import { referralTokenSchema, secureOpaqueTokenSchema } from './tokens.js';
import { portalIntakeV2Router, publicIntakeV2Router } from './intake-v2.js';
import { orderAllowsManualCancellation, orderMoneyWasTaken } from './order-cancellation-policy.js';




const idSchema = z.string().min(1).max(128).regex(/^[A-Za-z0-9_-]+$/);
const organisationStatusSchema = z.enum(['onboarding', 'intake_live', 'live', 'paused']);
const tokenHash = (token: string) => createHash('sha256').update(token).digest('hex');
const timestamp = () => nowIso();
const MAX_PRESCRIPTION_FILE_BYTES = 16_000_000;
const PRESCRIPTION_CONTENT_TYPES = ['application/pdf', 'image/jpeg', 'image/png'] as const;
const EMAIL_LOGO_WIDTH = 640;
const EMAIL_LOGO_HEIGHT = 192;
const MAX_EMAIL_LOGO_BYTES = 2_000_000;
const EMAIL_LOGO_CONTENT_TYPE = 'image/png';
const firebaseAuthErrorCode = (error: unknown) => {
  if (!error || typeof error !== 'object') return null;
  const candidate = error as { code?: unknown; errorInfo?: { code?: unknown } };
  return typeof candidate.code === 'string' ? candidate.code : typeof candidate.errorInfo?.code === 'string' ? candidate.errorInfo.code : null;
};

const firstPartyPasswordResetLink = (firebaseLink: string, appOrigin: string) => {
  const source = new URL(firebaseLink);
  const destination = new URL('/reset-password', appOrigin);
  for (const key of ['oobCode', 'apiKey', 'lang']) {
    const value = source.searchParams.get(key);
    if (value) destination.searchParams.set(key, value);
  }
  return destination.toString();
};

async function withEmailLogoUrl<T extends Record<string, unknown>>(organisation: T) {
  const storagePath = typeof organisation.emailLogoStoragePath === 'string' ? organisation.emailLogoStoragePath : '';
  if (!storagePath) return { ...organisation, emailLogoUrl: null };
  try {
    const [emailLogoUrl] = await storage.bucket().file(storagePath).getSignedUrl({
      version: 'v4',
      action: 'read',
      expires: Date.now() + 60 * 60 * 1000,
    });
    return { ...organisation, emailLogoUrl };
  } catch {
    return { ...organisation, emailLogoUrl: null };
  }
}

const organisationDetailsSchema = z.object({
  name: z.string().trim().min(1).max(200),
  tradingName: z.string().trim().min(1).max(200),
  gphcNumber: z.string().trim().min(1).max(50),
  superintendent: z.string().trim().min(1).max(200),
  companyNumber: z.string().trim().max(50),
  mainContactName: z.string().trim().min(1).max(200),
  mainContactPhone: z.string().trim().max(50),
  mainContactEmail: z.email().max(254),
  address: z.string().trim().min(1).max(500),
  primaryColour: z.string().regex(/^#[0-9a-fA-F]{6}$/),
  logoText: z.string().trim().min(1).max(4),
  websiteDomains: z.array(z.string().trim().min(1).max(253)).max(20),
  status: organisationStatusSchema,
  platformFeeMonthly: z.number().nonnegative().max(100_000).nullable(),
  portalName: z.string().trim().min(1).max(200),
  worldpayEnabled: z.boolean(),
  defaultPaymentRoute: z.enum(['manual', 'worldpay']),
  autoPlacementEnabled: z.boolean().optional(),
});

const setupDefinitions = [
  { id: 'pharmacy_profile', title: 'Confirm pharmacy and registered premises', required: true },
  { id: 'curaleaf_account', title: 'Verify Curaleaf customer account', required: true },
  { id: 'payment_route', title: 'Choose and verify a payment route', required: true },
  { id: 'pricing', title: 'Confirm Curaleaf pricing and dispensing-charge policy', required: true },
  { id: 'notifications', title: 'Confirm notification sender and wording', required: true },
  { id: 'operational_readiness', title: 'Complete operational readiness walkthrough', required: true },
] as const;

const conditionIdSchema = z.enum(CONDITION_IDS);
const eligibilitySchema = z.object({
  referralToken: referralTokenSchema,
  firstName: z.string().trim().min(1).max(100),
  surname: z.string().trim().min(1).max(100),
  dob: z.iso.date(),
  mobile: z.string().trim().min(7).max(30),
  email: z.email().max(254),
  postcode: z.string().trim().min(2).max(16),
  conditions: z.array(conditionIdSchema).min(1).max(3).refine(values => new Set(values).size === values.length, 'Conditions must be unique.'),
  primaryCondition: conditionIdSchema,
  tried2: z.boolean(),
  psychExclusion: z.boolean(),
  consentReferral: z.literal(true),
  consentShare: z.literal(true),
  marketing: z.boolean().default(false),
  source: z.string().trim().max(100).default(''),
}).refine(input => input.conditions.includes(input.primaryCondition), {
  path: ['primaryCondition'],
  message: 'Primary condition must be one of the selected conditions.',
});

function conditionSet(record: Record<string, unknown>) {
  const conditions = Array.isArray(record.conditions)
    ? [...new Set(record.conditions.map(normaliseConditionId).filter((value): value is ConditionId => Boolean(value)))].slice(0, 3)
    : [];
  const legacy = normaliseConditionId(record.condition);
  if (conditions.length === 0 && legacy) conditions.push(legacy);
  const requestedPrimary = normaliseConditionId(record.primaryCondition);
  const primaryCondition = requestedPrimary && conditions.includes(requestedPrimary) ? requestedPrimary : conditions[0] ?? null;
  return { conditions, primaryCondition };
}

const preferenceThemeSchema = z
  .enum(['light', 'dark', 'clinical-light', 'clinical-dark', 'high-contrast', 'warm-low-glare'])
  .transform(theme => theme === 'dark' || theme === 'clinical-dark' || theme === 'high-contrast' ? 'dark' : 'light');

const preferencesSchema = z.object({
  theme: preferenceThemeSchema,
  textScale: z.enum(['default', 'large', 'larger']).default('default'),
  reduceMotion: z.boolean().default(false),
  enhancedFocus: z.boolean().default(false),
  underlineLinks: z.boolean().default(false),
  overviewView: z.enum(['today', 'handover', 'operations', 'pipeline']).default('today'),
  workspaceTourCompleted: z.boolean().optional(),
});

const financeRangeSchema = z.object({
  from: z.iso.date().optional(),
  to: z.iso.date().optional(),
}).refine(value => !value.from || !value.to || value.from <= value.to, {
  message: 'The finance date range is invalid.',
});

const limitResponse = { code: 'RATE_LIMITED', message: 'Too many requests. Wait briefly before trying again.' };
const publicReadLimit = rateLimit({ windowMs: 15 * 60 * 1000, limit: 60, standardHeaders: 'draft-8', legacyHeaders: false, message: limitResponse });
const keyedPublicLimit = (selector: (request: Request) => string, limit: number, windowMs: number) => rateLimit({
  windowMs,
  limit,
  keyGenerator: request => `${ipKeyGenerator(request.ip ?? 'unknown')}:${tokenHash(selector(request)).slice(0, 24)}`,
  standardHeaders: 'draft-8',
  legacyHeaders: false,
  message: limitResponse,
});
const sessionExchangeLimit = keyedPublicLimit(request => {
  try {
    const payload = String(request.body?.idToken ?? '').split('.')[1];
    const decoded = payload ? JSON.parse(Buffer.from(payload, 'base64url').toString()) as { sub?: unknown } : {};
    return typeof decoded.sub === 'string' ? decoded.sub : 'unknown-account';
  } catch { return 'invalid-account'; }
}, 10, 15 * 60 * 1000);
const eligibilitySubmissionLimit = keyedPublicLimit(request => String(request.body?.referralToken ?? 'unknown-referral'), 5, 60 * 60 * 1000);
const eligibilityResolutionLimit = keyedPublicLimit(request => String(request.params.token ?? 'unknown-referral'), 60, 15 * 60 * 1000);
const paymentReceiptLimit = keyedPublicLimit(request => String(request.params.token ?? 'unknown-receipt'), 60, 15 * 60 * 1000);
const webhookLimit = rateLimit({ windowMs: 15 * 60 * 1000, limit: 300, standardHeaders: 'draft-8', legacyHeaders: false, message: limitResponse });
const healthLimit = rateLimit({ windowMs: 60 * 1000, limit: 30, standardHeaders: 'draft-8', legacyHeaders: false, message: limitResponse });
const portalKey = (request: Request) => identity(request).uid;
// Staff ops console: allow denser admin/setup traffic (Curaleaf test/approve, multi-pharmacy setup reads).
const portalReadLimit = rateLimit({ windowMs: 15 * 60 * 1000, limit: 600, keyGenerator: portalKey, skip: request => request.method !== 'GET', standardHeaders: 'draft-8', legacyHeaders: false, message: limitResponse });
const portalWriteLimit = rateLimit({ windowMs: 15 * 60 * 1000, limit: 180, keyGenerator: portalKey, skip: request => ['GET', 'HEAD', 'OPTIONS'].includes(request.method), standardHeaders: 'draft-8', legacyHeaders: false, message: limitResponse });
const externalProviderLimit = rateLimit({
  windowMs: 60 * 1000,
  limit: 30,
  keyGenerator: portalKey,
  skip: request => ['GET', 'HEAD', 'OPTIONS'].includes(request.method),
  standardHeaders: 'draft-8',
  legacyHeaders: false,
  message: { ...limitResponse, message: 'Supplier or payment requests are temporarily rate limited. Wait a minute before retrying.' },
});

function localDevelopmentOnly(request: Request, response: Response, next: NextFunction) {
  const remoteAddress = request.socket.remoteAddress ?? '';
  const loopback = remoteAddress === '127.0.0.1' || remoteAddress === '::1' || remoteAddress === '::ffff:127.0.0.1';
  if (config.NODE_ENV !== 'development' || !loopback) return response.status(404).json({ code: 'NOT_FOUND', message: 'Not found.' });
  next();
}

function curaleafTestEnvironmentOnly(_request: Request, response: Response, next: NextFunction) {
  if (!config.CURALEAF_BASE_URL.includes('.dev')) {
    return response.status(404).json({ code: 'NOT_FOUND', message: 'Not found.' });
  }
  next();
}

async function platformCuraleafCatalogue() {
  return cached('curaleaf:catalog:platform', 5 * 60_000, async () => {
    // Sequential lists respect soft ~1 req/s Curaleaf spacing.
    const formulaPage = await curaleafPlatformList<Record<string, unknown>>('/v1/formulas/', 'formulas');
    const productPage = await curaleafPlatformList<Record<string, unknown>>('/v1/products/', 'products');
    return {
      environment: 'test' as const,
      fetchedAt: timestamp(),
      formulas: formulaPage.records,
      products: productPage.records,
      formulaTotal: formulaPage.totalRecordCount,
      productTotal: productPage.totalRecordCount,
    };
  });
}

const londonDay = new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/London', year: 'numeric', month: '2-digit', day: '2-digit' });

function millisecondsUntilNextLondonMidnight(now = Date.now()) {
  const currentDay = londonDay.format(new Date(now));
  let lower = now;
  let upper = now + 26 * 60 * 60 * 1_000;
  while (upper - lower > 1_000) {
    const middle = Math.floor((lower + upper) / 2);
    if (londonDay.format(new Date(middle)) === currentDay) lower = middle;
    else upper = middle;
  }
  return Math.max(60_000, upper - now);
}

async function tenantCuraleafCatalogue(organisationId: string) {
  return cached(`curaleaf:catalog:${organisationId}`, millisecondsUntilNextLondonMidnight(), async () => {
    const formulaPage = await curaleafList<Record<string, unknown>>(organisationId, '/v1/formulas/', 'formulas');
    const productPage = await curaleafList<Record<string, unknown>>(organisationId, '/v1/products/', 'products');
    return {
      environment: config.CURALEAF_BASE_URL.includes('.dev') ? 'test' as const : 'production' as const,
      fetchedAt: timestamp(),
      formulas: formulaPage.records,
      products: productPage.records,
      formulaTotal: formulaPage.totalRecordCount,
      productTotal: productPage.totalRecordCount,
    };
  });
}

async function requirePublicAppCheck(request: Request, _response: Response, next: NextFunction) {
  if (config.REQUIRE_APP_CHECK !== 'true') return next();
  try {
    const token = request.get('x-firebase-appcheck');
    if (!token) throw new Error('missing');
    await appCheck.verifyToken(token);
    next();
  } catch {
    void securityEvent(request, 'auth.app_check_denied');
    next(new HttpError(401, 'App attestation is required.', 'APP_CHECK_REQUIRED'));
  }
}

async function resolveReferralToken(rawToken: string) {
  const hash = tokenHash(rawToken);
  return cached(`referral:${hash}`, 60_000, async () => {
    const tokens = await firestore.collection('referralTokens').where('tokenHash', '==', hash).where('revokedAt', '==', null).limit(1).get();
    const token = tokens.docs[0]?.data();
    if (!token) throw new HttpError(404, 'Pharmacy link not found.', 'NOT_FOUND');
    const organisation = await getRecord('organisations', token.organisationId as string);
    if (!canAcceptPublicIntake(organisation)) throw new HttpError(404, 'Pharmacy link not found.', 'NOT_FOUND');
    if (!isExplicitCuraleafTestAccount(organisation) && organisation.status === 'intake_live' && !(await goLiveReadiness(String(token.organisationId))).intakeReady) {
      throw new HttpError(404, 'Pharmacy link not found.', 'NOT_FOUND');
    }
    return { token, organisation };
  });
}

async function setupStatus(organisationId: string) {
  return cached(`setup:${organisationId}`, 15_000, async () => {
    const records = await firestore.collection('setupTasks').where('organisationId', '==', organisationId).get();
    const byId = new Map(records.docs.map(document => [document.data().taskId as string, document.data()]));
    const tasks = setupDefinitions.map(definition => ({ ...definition, completed: byId.get(definition.id)?.completed === true, evidence: byId.get(definition.id)?.evidence ?? null, completedAt: byId.get(definition.id)?.completedAt ?? null, completedBy: byId.get(definition.id)?.completedBy ?? null }));
    const requiredCount = tasks.filter(task => task.required).length;
    const completedCount = tasks.filter(task => task.required && task.completed).length;
    const updatedAt = records.docs.map(document => String(document.data().updatedAt ?? '')).filter(Boolean).sort().at(-1) ?? timestamp();
    return { organisationId, completed: completedCount === requiredCount, completedCount, requiredCount, tasks, updatedAt };
  });
}

function validGdprEvidenceUrl(value: unknown) {
  return typeof value === 'string' && (value.startsWith('https://drive.google.com/') || value.startsWith('https://docs.google.com/'));
}

type GdprCompanyRecord = {
  gdprConfirmed?: unknown;
  gdprDocUrl?: unknown;
  gdprEvidenceMethod?: unknown;
  gdprReceiptRecordedAt?: unknown;
};

function gdprEvidenceRecorded(company: (GdprCompanyRecord | Record<string, unknown>) | null) {
  if (!company?.gdprConfirmed) return false;
  return validGdprEvidenceUrl(company.gdprDocUrl) || company.gdprEvidenceMethod === 'manual_receipt';
}

function gdprEvidenceMethod(company: (GdprCompanyRecord | Record<string, unknown>) | null): 'document_link' | 'manual_receipt' | null {
  if (!company?.gdprConfirmed) return null;
  if (company.gdprEvidenceMethod === 'manual_receipt') return 'manual_receipt';
  return validGdprEvidenceUrl(company.gdprDocUrl) ? 'document_link' : null;
}

async function companyForOrganisation(organisationId: string, organisation?: Record<string, unknown>): Promise<(Record<string, unknown> & { id: string }) | null> {
  const branch = organisation ?? await getRecord('organisations', organisationId);
  const declaredId = typeof branch.orgId === 'string' ? branch.orgId : '';
  if (declaredId) {
    const declared = await firestore.collection('companies').doc(declaredId).get();
    if (declared.exists) return { id: declared.id, ...declared.data()! };
  }
  const owner = await firestore.collection('companies').where('branchesOwned', 'array-contains', organisationId).limit(1).get();
  if (!owner.empty) return { id: owner.docs[0]!.id, ...owner.docs[0]!.data() };
  const companyNumber = typeof branch.companyNumber === 'string' ? branch.companyNumber.trim() : '';
  if (companyNumber) {
    const match = await firestore.collection('companies').where('companyNumber', '==', companyNumber).limit(1).get();
    if (!match.empty) return { id: match.docs[0]!.id, ...match.docs[0]!.data() };
  }
  return null;
}

async function autoActivateCompanyIntake(companyId: string, company: Record<string, unknown>, activatedBy: string, activatedAt: string) {
  const branchIds = new Set(
    Array.isArray(company.branchesOwned)
      ? company.branchesOwned.filter((value): value is string => typeof value === 'string' && idSchema.safeParse(value).success)
      : [],
  );
  const linked = await firestore.collection('organisations').where('companyId', '==', companyId).limit(500).get();
  linked.docs.forEach(document => branchIds.add(document.id));
  const documents = await Promise.all([...branchIds].map(id => firestore.collection('organisations').doc(id).get()));
  const eligible = documents.filter(document => document.exists && canAutoActivateIntake(document.data()!));
  if (!eligible.length) return [];
  const batch = firestore.batch();
  eligible.forEach(document => batch.set(document.ref, {
    status: 'intake_live',
    gdprComplianceFlag: false,
    pausedReason: null,
    pausedAt: null,
    intakeWentLiveAt: activatedAt,
    intakeWentLiveBy: activatedBy,
    intakeActivationSource: 'gdpr_evidence_recorded',
    updatedAt: activatedAt,
  }, { merge: true }));
  await batch.commit();
  eligible.forEach(document => invalidateCollectionCache('organisations', document.id));
  invalidateCache('admin:organisations', 'referral:');
  return eligible.map(document => document.id);
}

async function autoActivateOrganisationIntake(organisationId: string, organisation: Record<string, unknown>, activatedBy: string, activatedAt: string) {
  if (!canAutoActivateIntake(organisation)) return [];
  await firestore.collection('organisations').doc(organisationId).set({
    status: 'intake_live',
    gdprComplianceFlag: false,
    pausedReason: null,
    pausedAt: null,
    intakeWentLiveAt: activatedAt,
    intakeWentLiveBy: activatedBy,
    intakeActivationSource: 'gdpr_evidence_recorded',
    updatedAt: activatedAt,
  }, { merge: true });
  invalidateCollectionCache('organisations', organisationId);
  invalidateCache('admin:organisations', 'referral:');
  return [organisationId];
}

async function goLiveReadiness(organisationId: string) {
  const organisation = await getRecord('organisations', organisationId);
  const [company, connectionSnapshot] = await Promise.all([
    companyForOrganisation(organisationId, organisation),
    firestore.collection('integrationConnections').doc(`${organisationId}--curaleaf`).get(),
  ]);
  const gdprRecord = company ?? organisation;
  const companyGdprPassed = gdprEvidenceRecorded(gdprRecord);
  const gates = goLiveGateState(organisation, companyGdprPassed, connectionSnapshot.exists ? connectionSnapshot.data()! : null);
  const evidenceMethod = gdprEvidenceMethod(gdprRecord);
  return {
    organisationId,
    companyId: company?.id ?? null,
    testAccount: gates.testAccount,
    allocationHolding: gates.allocationHolding,
    intakeReady: gates.testAccount || gates.gdprPassed,
    ready: gates.gdprPassed && gates.curaleafPassed,
    status: organisationStatusSchema.catch('onboarding').parse(organisation.status),
    gates: {
      gdprEvidence: {
        passed: gates.gdprPassed,
        exempt: gates.gdprExempt,
        evidenceUrl: evidenceMethod === 'document_link' ? String(gdprRecord.gdprDocUrl) : null,
        method: evidenceMethod,
        receivedAt: evidenceMethod === 'manual_receipt' && typeof gdprRecord.gdprReceiptRecordedAt === 'string' ? gdprRecord.gdprReceiptRecordedAt : null,
      },
      curaleafLive: { passed: gates.curaleafPassed, environment: gates.curaleafEnvironment, validatedAt: gates.curaleafValidatedAt, secretStored: gates.secretStored },
    },
  };
}

export async function auditLiveOrganisationGates() {
  const snapshot = await firestore.collection('organisations').where('status', 'in', ['intake_live', 'live']).limit(500).get();
  const paused: string[] = [];
  for (const document of snapshot.docs) {
    const readiness = await goLiveReadiness(document.id);
    const remainsReady = readiness.status === 'intake_live' ? readiness.intakeReady : readiness.ready;
    if (remainsReady) continue;
    await document.ref.set({
      status: 'paused',
      gdprComplianceFlag: !readiness.gates.gdprEvidence.passed && !readiness.testAccount,
      pausedReason: readiness.status === 'intake_live' ? 'intake_gdpr_gate_audit_failed' : 'go_live_gate_audit_failed',
      pausedAt: timestamp(),
      updatedAt: timestamp(),
    }, { merge: true });
    invalidateCollectionCache('organisations', document.id);
    paused.push(document.id);
  }
  if (paused.length) invalidateCache('admin:organisations', 'referral:');
  return { checked: snapshot.size, paused };
}

async function requireSetupComplete(organisationId: string) {
  const readiness = await goLiveReadiness(organisationId);
  if (!readiness.ready || readiness.status !== 'live') {
    throw new HttpError(409, readiness.testAccount
      ? 'This TEST account is inactive. Confirm its explicit test exemption and validated TEST Curaleaf key.'
      : 'This pharmacy is not live. Record company GDPR evidence and validate the LIVE Curaleaf key.', 'PHARMACY_NOT_LIVE');
  }
}

function ensureFreshAuthentication(request: Request) {
  if (identity(request).token.auth_time * 1000 < Date.now() - 5 * 60 * 1000) throw new HttpError(401, 'Sign in again before changing integration credentials.', 'RECENT_LOGIN_REQUIRED');
}

function safeFilename(value: string) {
  return value.replace(/[^A-Za-z0-9._-]/g, '-').slice(0, 120) || 'prescription';
}

function maskedIdentifier(value: string) {
  const tail = value.slice(-4);
  return `${'•'.repeat(Math.min(8, Math.max(4, value.length - tail.length)))}${tail}`;
}

export function validPrescriptionSignature(contentType: typeof PRESCRIPTION_CONTENT_TYPES[number], bytes: Buffer) {
  if (contentType === 'application/pdf') return bytes.subarray(0, 5).equals(Buffer.from('%PDF-'));
  if (contentType === 'image/jpeg') return bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff;
  return bytes.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
}

async function startOperation(organisationId: string, orderId: string, kind: 'manual' | 'barcode', subOrderId?: string) {
  const id = createHash('sha256').update(`${organisationId}:${orderId}:${subOrderId ?? 'single'}:curaleaf`).digest('hex');
  const reference = `HHH-${orderId}${subOrderId ? `-${subOrderId}` : ''}`.slice(0, 100);
  const document = firestore.collection('integrationOperations').doc(id);
  try {
    await document.create({ id, schemaVersion: 1, organisationId, orderId, subOrderId: subOrderId ?? null, integration: 'curaleaf', kind, customerReference: reference, status: 'started', createdAt: timestamp(), updatedAt: timestamp() });
  } catch (error) {
    if ((error as { code?: number | string }).code === 6 || (error as { code?: number | string }).code === 'already-exists') throw new HttpError(409, 'This order already has a Curaleaf submission operation. Reconcile it instead of submitting again.', 'DUPLICATE_OPERATION');
    throw error;
  }
  return { id, reference, document };
}

export const app = express();
app.disable('x-powered-by');
app.set('trust proxy', 1);
app.use((request, response, next) => {
  const incoming = request.get('x-request-id');
  const requestId = incoming && /^[A-Za-z0-9_-]{8,80}$/.test(incoming) ? incoming : randomUUID();
  request.headers['x-request-id'] = requestId;
  response.setHeader('X-Request-Id', requestId);
  next();
});
// The Cloud Run load balancer preserves the portal namespace while Vercel
// rewrites it externally. Keep originalUrl for surface derivation and expose
// the canonical /v1 path to the route handlers in either deployment.
app.use((request, _response, next) => {
  const match = request.url.match(/^\/(?:pharmacy|admin)(\/v[12](?:\/|\?|$).*)/);
  if (match?.[1]) request.url = match[1];
  next();
});
app.use(helmet({ strictTransportSecurity: false }));
app.use(cors({ origin(origin, callback) { if (!origin || allowedOrigins.has(origin)) return callback(null, true); callback(new HttpError(403, 'Origin is not permitted.', 'ORIGIN_DENIED')); }, methods: ['GET', 'POST', 'PATCH', 'PUT', 'DELETE', 'OPTIONS'] }));
app.use(express.json({ limit: '256kb', verify(request, _response, buffer) { (request as Request).rawBody = Buffer.from(buffer); } }));
app.use(['/v1/auth', '/v1/portal', '/v1/public', '/v2/portal', '/v2/public'], (_request, response, next) => {
  response.setHeader('Cache-Control', 'no-store');
  response.setHeader('Pragma', 'no-cache');
  next();
});

app.get('/health', healthLimit, async (_request, response, next) => {
  try {
    await cached('health:firestore', 10_000, async () => {
      await firestore.collection('_health').limit(1).get();
      return true;
    });
    response.json({ status: 'ok', storage: 'firestore', region: 'europe-west2', checkedAt: timestamp() });
  } catch (error) { next(error); }
});

app.use(['/v1/public', '/v2/public'], (request, _response, next) => {
  const host = requestSurfaceHost(request);
  const localDevelopment = config.NODE_ENV !== 'production' && ['localhost', '127.0.0.1', '::1'].includes(host);
  if (!localDevelopment && !publicAppHostnames.has(host)) return next(new HttpError(404, 'Not found.', 'NOT_FOUND'));
  next();
});

app.use('/v2/public', publicIntakeV2Router);

app.get('/v1/dev/curaleaf/catalog', publicReadLimit, localDevelopmentOnly, async (_request, response, next) => {
  try {
    response.json(await platformCuraleafCatalogue());
  } catch (error) { next(error); }
});

app.post('/v1/dev/curaleaf/quote', publicReadLimit, localDevelopmentOnly, async (request, response, next) => {
  try {
    const input = z.object({ items: z.array(z.object({ packId: idSchema, quantity: z.number().int().positive().max(100) })).min(1).max(50) }).parse(request.body);
    const raw = await curaleafPlatformRequest('/v1/quotes/', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(input),
    });
    response.json(parsedCuraleafQuote(raw));
  } catch (error) { next(error); }
});

app.get('/v1/dev/curaleaf/activity', publicReadLimit, localDevelopmentOnly, async (_request, response, next) => {
  try {
    response.json(await cached('curaleaf:activity:platform', 30_000, async () => {
      const [prescriberPage, prescriptionPage, purchaseOrderPage, shipmentPage] = await Promise.all([
        curaleafPlatformList<Record<string, unknown>>('/v1/prescribers/', 'prescribers'),
        curaleafPlatformList<Record<string, unknown>>('/v1/prescriptions/', 'prescriptions'),
        curaleafPlatformList<Record<string, unknown>>('/v1/purchase-orders/', 'purchaseOrders'),
        curaleafPlatformList<Record<string, unknown>>('/v1/shipments/', 'shipments'),
      ]);
      return {
        environment: 'test',
        fetchedAt: timestamp(),
        prescribers: prescriberPage.records,
        prescriptions: prescriptionPage.records,
        purchaseOrders: purchaseOrderPage.records,
        shipments: shipmentPage.records,
        prescriberTotal: prescriberPage.totalRecordCount,
        prescriptionTotal: prescriptionPage.totalRecordCount,
        purchaseOrderTotal: purchaseOrderPage.totalRecordCount,
        shipmentTotal: shipmentPage.totalRecordCount,
      };
    }));
  } catch (error) { next(error); }
});

app.get('/v1/public/pharmacies/by-token/:token', eligibilityResolutionLimit, requirePublicAppCheck, async (request, response, next) => {
  try {
    const { organisation } = await resolveReferralToken(referralTokenSchema.parse(request.params.token));
    response.json({ id: organisation.id, name: organisation.name, tradingName: organisation.tradingName, logoText: organisation.logoText, gphcNumber: organisation.gphcNumber, superintendent: organisation.superintendent, address: organisation.address, primaryColour: organisation.primaryColour });
  } catch (error) { next(error); }
});

app.post('/v1/public/eligibility-submissions', eligibilitySubmissionLimit, requirePublicAppCheck, async (request, response, next) => {
  try {
    const input = eligibilitySchema.parse(request.body);
    const { token, organisation } = await resolveReferralToken(input.referralToken);
    const trainingSubmission = isExplicitCuraleafTestAccount(organisation);
    const submittedAt = timestamp();
    const submissionFields = {
      organisationId: organisation.id,
      referralTokenId: token.id,
      firstName: input.firstName,
      surname: input.surname,
      dob: input.dob,
      mobile: input.mobile,
      email: input.email.toLowerCase(),
      postcode: input.postcode.toUpperCase(),
      conditions: input.conditions,
      primaryCondition: input.primaryCondition,
      triedTwoTreatments: input.tried2,
      psychosisExclusion: input.psychExclusion,
      consentReferral: input.consentReferral,
      consentShare: input.consentShare,
      marketingConsent: input.marketing,
      source: input.source,
      trainingSubmission,
      consentCapturedAt: submittedAt,
      requestIp: request.ip,
      requestUserAgent: request.get('user-agent') ?? null,
    };
    const existing = (await listTenantRecords('eligibilitySubmissions', organisation.id, 500))
      .find(record => String(record.email).toLowerCase() === input.email.toLowerCase());
    const record = existing
      ? await updateTenantRecord('eligibilitySubmissions', String(existing.id), organisation.id, {
        ...submissionFields,
        duplicateSubmissionCount: Number(existing.duplicateSubmissionCount ?? 0) + 1,
        lastSubmittedAt: submittedAt,
      })
      : await createRecord('eligibilitySubmissions', {
      ...submissionFields,
      status: 'new',
      recordsCheck: { status: 'pending', notes: null, completedAt: null, completedBy: null },
      referral: { status: 'pending', notes: null, completedAt: null, completedBy: null },
      emailDelivery: { status: 'not_sent', queuedAt: null, sentAt: null, failedAt: null },
    });
    await audit(request, existing ? 'eligibility.resubmitted' : 'eligibility.submitted', { organisationId: organisation.id, recordId: record.id });
    response.status(existing ? 200 : 201).json({ id: record.id, organisationId: organisation.id, pharmacyName: organisation.name, submittedAt: record.updatedAt ?? record.createdAt });
  } catch (error) { next(error); }
});

app.get('/v1/public/payment-receipts/:token', paymentReceiptLimit, requirePublicAppCheck, async (request, response, next) => {
  try {
    response.setHeader('Cache-Control', 'no-store');
    const parsedToken = secureOpaqueTokenSchema.safeParse(request.params.token);
    if (!parsedToken.success) return response.json({ status: 'expired', message: 'This payment confirmation link has expired.' });
    const hash = tokenHash(parsedToken.data);
    const receipt = (await firestore.collection('paymentReceipts').doc(hash).get()).data();
    if (!receipt || Date.parse(String(receipt.expiresAt ?? '')) <= Date.now()) {
      return response.json({ status: 'expired', message: 'This payment confirmation link has expired.' });
    }
    const payment = typeof receipt.paymentId === 'string' ? (await firestore.collection('payments').doc(receipt.paymentId).get()).data() : null;
    const status = payment?.status === 'paid' ? 'paid' : ['failed', 'cancelled', 'expired'].includes(String(payment?.status)) ? 'failed' : 'pending';
    const message = status === 'paid'
      ? 'Payment has been confirmed. You can safely close this page.'
      : status === 'failed'
        ? 'Payment was not completed. Use the original payment link to try again.'
        : 'Payment confirmation is still being processed. This page may be refreshed.';
    return response.json({ status, message });
  } catch (error) { next(error); }
});

app.post('/v1/public/worldpay/webhooks/:organisationId', webhookLimit, async (request, response, next) => {
  try {
    const organisationId = idSchema.parse(request.params.organisationId);
    const event = parseWorldpayWebhookEvent(request.body);
    const eventKey = createHash('sha256').update(event.eventId).digest('hex');
    const eventRef = firestore.collection('worldpayWebhookEvents').doc(eventKey);
    try {
      await eventRef.create({
        id: eventKey,
        schemaVersion: 1,
        organisationId,
        ...event,
        receivedAt: timestamp(),
        status: 'received',
      });
    } catch (error) {
      if ((error as { code?: number | string }).code === 6 || (error as { code?: number | string }).code === 'already-exists') {
        return response.status(200).json({ accepted: true, duplicate: true });
      }
      throw error;
    }

    const payments = await firestore.collection('payments').where('organisationId', '==', organisationId).where('transactionReference', '==', event.transactionReference).limit(1).get();
    const paymentDoc = payments.docs[0];
    if (!paymentDoc) {
      await eventRef.update({ status: 'unmatched', updatedAt: timestamp() });
      return response.status(200).json({ accepted: true, unmatched: true });
    }
    const outcome = await reconcileWorldpayPaymentDocument(paymentDoc, event.entityId);
    if (outcome.state === 'verification_pending') {
      // Payment Queries can lag webhook delivery. The scheduled sweep retries it.
      await eventRef.update({ status: 'query_pending', detail: outcome.reason, updatedAt: timestamp() });
      return response.status(200).json({ accepted: true, verificationPending: true });
    }
    if (outcome.state === 'reconciliation_required') {
      await eventRef.update({ status: 'reconciliation_required', detail: outcome.reason, updatedAt: timestamp() });
      return response.status(200).json({ accepted: true, reconciliationRequired: true });
    }
    await eventRef.update({
      status: outcome.paymentStatus,
      providerPaymentId: outcome.paymentId,
      providerStatus: outcome.providerStatus,
      updatedAt: timestamp(),
    });
    response.status(200).json({ accepted: true, reconciled: true, paymentStatus: outcome.paymentStatus });
  } catch (error) { next(error); }
});

app.get('/v1/auth/csrf', publicReadLimit, (request, response, next) => {
  try { response.json({ csrfToken: issueCsrf(request, response) }); }
  catch (error) { next(error); }
});

app.post('/v1/auth/session', sessionExchangeLimit, requirePublicAppCheck, async (request, response, next) => {
  try { response.status(201).json(await createStaffSession(request, response)); }
  catch (error) {
    const code = error instanceof HttpError ? error.code : 'UNAUTHENTICATED';
    void securityEvent(request, code === 'REQUEST_ORIGIN_DENIED' ? 'auth.origin_denied' : code === 'FORBIDDEN' || code === 'ROLE_REQUIRED' ? 'auth.role_denied' : 'auth.session_rejected', { code });
    next(error);
  }
});

app.get('/v1/auth/session', requireStaff, async (request, response, next) => {
  try { response.json(await sessionPayload(request, response)); }
  catch (error) { next(error); }
});

app.post('/v1/auth/activity', requireStaff, requireCsrf, async (request, response, next) => {
  try { await touchCurrentSession(request); response.json(await sessionPayload(request, response)); }
  catch (error) { next(error); }
});

app.delete('/v1/auth/session', requireStaff, requireCsrf, async (request, response, next) => {
  try { await revokeCurrentSession(request, response); response.status(204).send(); }
  catch (error) { next(error); }
});

app.use('/v1/portal', requireStaff);
app.use('/v1/portal', requireCsrf);
app.use('/v1/portal', portalReadLimit, portalWriteLimit);
app.use('/v1/portal/integrations', externalProviderLimit);
app.use('/v2/portal', requireStaff, requireCsrf, portalReadLimit, portalWriteLimit, portalIntakeV2Router);

app.get('/v1/portal/session', async (request, response, next) => {
  try {
    const actor = identity(request);
    const [staffSnapshot, organisation] = await Promise.all([
      firestore.collection('staffUsers').doc(actor.uid).get(),
      actor.organisationId ? getRecord('organisations', actor.organisationId) : Promise.resolve(null),
    ]);
    const profile = staffSnapshot.data() ?? null;
    if (profile?.status === 'invited') {
      await staffSnapshot.ref.set({ status: 'active', activatedAt: timestamp(), updatedAt: timestamp() }, { merge: true });
      profile.status = 'active';
      if (actor.organisationId) invalidateCache(`admin:staff:${actor.organisationId}`);
    }
    response.json({ uid: actor.uid, email: actor.email, role: actor.role, organisationId: actor.organisationId, profile, organisation });
  } catch (error) { next(error); }
});

app.get('/v1/portal/overview', async (request, response, next) => {
  try { response.json(await buildPharmacyOverview(tenantFor(request))); }
  catch (error) { next(error); }
});

app.get('/v1/portal/preferences', async (request, response, next) => {
  try { response.json(preferencesSchema.parse((await firestore.collection('staffUsers').doc(identity(request).uid).get()).data()?.preferences ?? { theme: 'light' })); }
  catch (error) { next(error); }
});

app.patch('/v1/portal/preferences', async (request, response, next) => {
  try {
    const preferences = preferencesSchema.parse(request.body);
    await firestore.collection('staffUsers').doc(identity(request).uid).set({ preferences, updatedAt: timestamp() }, { merge: true });
    response.json(preferences);
  } catch (error) { next(error); }
});

app.put('/v1/portal/payment-settings', async (request, response, next) => {
  try {
    const input = z.object({
      organisationId: idSchema.optional(),
      defaultPaymentRoute: z.enum(['manual', 'worldpay']).optional(),
      worldpayEnabled: z.boolean().optional(),
    }).refine(value => value.defaultPaymentRoute !== undefined || value.worldpayEnabled !== undefined, {
      message: 'Choose a default payment route.',
    }).parse(request.body);
    const organisationId = tenantFor(request, input.organisationId);
    const defaultPaymentRoute = input.defaultPaymentRoute ?? (input.worldpayEnabled ? 'worldpay' : 'manual');
    if (defaultPaymentRoute === 'worldpay') {
      const connection = await firestore.collection('integrationConnections').doc(`${organisationId}--worldpay`).get();
      if (!connection.exists || connection.data()?.status !== 'connected') {
        throw new HttpError(409, 'Verify this pharmacy’s Worldpay connection before making it the default payment route.', 'WORLDPAY_VERIFICATION_REQUIRED');
      }
    }
    const updatedAt = timestamp();
    await firestore.collection('organisations').doc(organisationId).set({
      defaultPaymentRoute,
      worldpayEnabled: defaultPaymentRoute === 'worldpay',
      updatedAt,
    }, { merge: true });
    invalidateCollectionCache('organisations', organisationId);
    invalidateCache('admin:organisations');
    await audit(request, 'payment.settings_updated', { organisationId, defaultPaymentRoute });
    response.json({ organisationId, defaultPaymentRoute, worldpayEnabled: defaultPaymentRoute === 'worldpay', updatedAt });
  } catch (error) { next(error); }
});

app.get('/v1/portal/setup', async (request, response, next) => {
  try { response.json(await setupStatus(tenantFor(request, request.query.organisationId))); }
  catch (error) { next(error); }
});

app.patch('/v1/portal/setup/:taskId', async (request, response, next) => {
  try {
    const taskId = z.enum(setupDefinitions.map(task => task.id) as [typeof setupDefinitions[number]['id'], ...typeof setupDefinitions[number]['id'][]]).parse(request.params.taskId);
    if (taskId === 'curaleaf_account' && identity(request).role !== 'hhh_admin') throw new HttpError(403, 'Curaleaf activation is managed only by HHH administrators.', 'FORBIDDEN');
    const input = z.object({ organisationId: idSchema.optional(), completed: z.boolean(), evidence: z.string().trim().max(1000).nullable().optional() }).parse(request.body);
    const organisationId = tenantFor(request, input.organisationId);
    const docId = `${organisationId}--${taskId}`;
    await firestore.collection('setupTasks').doc(docId).set({ id: docId, schemaVersion: 1, organisationId, taskId, completed: input.completed, evidence: input.evidence ?? null, completedAt: input.completed ? timestamp() : null, completedBy: input.completed ? identity(request).uid : null, updatedAt: timestamp() }, { merge: true });
    invalidateCache(`setup:${organisationId}`);
    await audit(request, 'setup.task_updated', { organisationId, taskId, completed: input.completed });
    response.json(await setupStatus(organisationId));
  } catch (error) { next(error); }
});

app.get('/v1/portal/eligibility-submissions', requireRole('hhh_admin'), async (request, response, next) => {
  try {
    const organisationId = tenantFor(request, request.query.organisationId);
    const [records, organisation] = await Promise.all([listTenantRecords('eligibilitySubmissions', organisationId, 500), getRecord('organisations', organisationId)]);
    response.json(records.filter(record => record.schemaVersion !== 2 && record.intakeVersion !== 'v2').map(record => {
      const { conditions, primaryCondition } = conditionSet(record);
      const review = eligibilityReviewProjection(record, identity(request).role);
      const emailDelivery = record.emailDelivery && typeof record.emailDelivery === 'object'
        ? record.emailDelivery as Record<string, unknown>
        : {};
      return {
      id: record.id, organisationId, pharmacyName: organisation.name,
      firstName: record.firstName, surname: record.surname, dob: record.dob, mobile: record.mobile, email: record.email,
      postcode: record.postcode, conditions, primaryCondition, tried2: record.triedTwoTreatments,
      psychExclusion: record.psychosisExclusion, consentReferral: record.consentReferral, consentShare: record.consentShare,
      marketing: record.marketingConsent, source: record.source,
      trainingSubmission: record.trainingSubmission === true,
      ...review,
      emailDelivery: {
        status: typeof emailDelivery.status === 'string' ? emailDelivery.status : 'not_sent',
        queuedAt: typeof emailDelivery.queuedAt === 'string' ? emailDelivery.queuedAt : null,
        sentAt: typeof emailDelivery.sentAt === 'string' ? emailDelivery.sentAt : null,
        failedAt: typeof emailDelivery.failedAt === 'string' ? emailDelivery.failedAt : null,
      },
      patientId: record.patientId ?? null,
      submittedAt: record.lastSubmittedAt ?? record.createdAt,
    }; }));
  }
  catch (error) { next(error); }
});

app.post('/v1/portal/admin/eligibility-submissions/:id/records-check', requireRole('hhh_admin'), async (request, response, next) => {
  try {
    const input = z.object({
      organisationId: idSchema,
      notes: z.string().trim().min(1).max(2_000),
    }).parse(request.body);
    const recordId = idSchema.parse(request.params.id);
    const current = await getTenantRecord('eligibilitySubmissions', recordId, input.organisationId);
    if (current.referral?.status === 'completed' || current.status === 'approved' || negativeEligibilityStatus(current.status)) {
      throw new HttpError(409, 'The completed referral record can no longer be changed.', 'REFERRAL_ALREADY_COMPLETED');
    }
    const completedAt = timestamp();
    const result = await updateTenantRecord('eligibilitySubmissions', recordId, input.organisationId, {
      status: 'reviewing',
      recordsCheck: { status: 'completed', notes: input.notes, completedAt, completedBy: identity(request).uid },
    });
    await audit(request, 'eligibility.records_check_completed', { organisationId: input.organisationId, recordId });
    response.json(result);
  } catch (error) { next(error); }
});

app.post('/v1/portal/admin/eligibility-submissions/:id/referral-decision', requireRole('hhh_admin'), async (request, response, next) => {
  try {
    const input = z.object({
      organisationId: idSchema,
      decision: z.enum(['completed', 'declined']),
      notes: z.string().trim().max(2_000).nullable().optional(),
      pharmacyDecisionReason: pharmacyDecisionReasonSchema.optional(),
    }).superRefine((value, context) => {
      if (value.decision === 'declined' && !value.pharmacyDecisionReason) {
        context.addIssue({ code: 'custom', path: ['pharmacyDecisionReason'], message: 'A pharmacy-facing reason is required for a declined decision.' });
      }
    }).parse(request.body);
    const recordId = idSchema.parse(request.params.id);
    if (input.decision === 'completed') {
      const current = await getTenantRecord('eligibilitySubmissions', recordId, input.organisationId);
      if (negativeEligibilityStatus(current.status)) throw new HttpError(409, 'A declined or rejected referral cannot be completed.', 'REFERRAL_DECLINED');
      const result = await completeReferral(recordId, identity(request).uid, input.notes ?? null);
      await audit(request, 'eligibility.referral_completed', { organisationId: input.organisationId, recordId, patientId: result.patientId, feeEventId: result.feeEventId });
      response.json({ ...result, status: 'approved', referralStatus: 'completed' });
      return;
    }
    const current = await getTenantRecord('eligibilitySubmissions', recordId, input.organisationId);
    if (current.referral?.status === 'completed' || current.status === 'approved' || negativeEligibilityStatus(current.status)) {
      throw new HttpError(409, 'A completed referral cannot be declined.', 'REFERRAL_ALREADY_COMPLETED');
    }
    const completedAt = timestamp();
    const result = await updateTenantRecord('eligibilitySubmissions', recordId, input.organisationId, {
      status: 'declined',
      decisionNote: input.notes ?? null,
      pharmacyDecisionReason: input.pharmacyDecisionReason,
      pharmacyDecisionReasonReviewedAt: completedAt,
      pharmacyDecisionReasonReviewedBy: identity(request).uid,
      referral: { status: 'declined', notes: input.notes ?? null, completedAt, completedBy: identity(request).uid },
      reviewedAt: completedAt,
      reviewedBy: identity(request).uid,
    });
    await audit(request, 'eligibility.referral_declined', { organisationId: input.organisationId, recordId });
    response.json(result);
  } catch (error) { next(error); }
});

app.patch('/v1/portal/admin/eligibility-submissions/:id/pharmacy-reason', requireRole('hhh_admin'), async (request, response, next) => {
  try {
    const input = z.object({
      organisationId: idSchema,
      pharmacyDecisionReason: pharmacyDecisionReasonSchema.nullable(),
    }).parse(request.body);
    const recordId = idSchema.parse(request.params.id);
    const current = await getTenantRecord('eligibilitySubmissions', recordId, input.organisationId);
    if (!negativeEligibilityStatus(current.status)) {
      throw new HttpError(409, 'Only declined or rejected records have a pharmacy-facing reason.', 'ELIGIBILITY_REASON_NOT_APPLICABLE');
    }
    const reviewedAt = timestamp();
    const result = await updateTenantRecord('eligibilitySubmissions', recordId, input.organisationId, {
      pharmacyDecisionReason: input.pharmacyDecisionReason,
      pharmacyDecisionReasonReviewedAt: reviewedAt,
      pharmacyDecisionReasonReviewedBy: identity(request).uid,
    });
    await audit(request, 'eligibility.pharmacy_reason_updated', pharmacyReasonAuditDetails(input.organisationId, recordId, input.pharmacyDecisionReason));
    response.json(result);
  } catch (error) { next(error); }
});

app.post('/v1/portal/admin/eligibility-submissions/:id/email', requireRole('hhh_admin'), async (request, response, next) => {
  try {
    const input = z.object({ organisationId: idSchema }).parse(request.body);
    const recordId = idSchema.parse(request.params.id);
    const submission = await getTenantRecord('eligibilitySubmissions', recordId, input.organisationId);
    if (negativeEligibilityStatus(submission.status) || (submission.referral?.status !== 'completed' && submission.status !== 'approved')) {
      throw new HttpError(409, 'Complete the referral before sending the patient email.', 'REFERRAL_NOT_COMPLETED');
    }
    const outboxId = `${recordId}--referral-completed`;
    const outboxRef = firestore.collection('notificationOutbox').doc(outboxId);
    const queuedAt = timestamp();
    try {
      await outboxRef.create({
        id: outboxId,
        schemaVersion: 1,
        organisationId: input.organisationId,
        kind: 'patient_referral_completed',
        recipient: submission.email,
        templateData: {
          firstName: submission.firstName,
          pharmacyName: (await getRecord('organisations', input.organisationId)).tradingName,
        },
        status: 'pending',
        referralSubmissionId: recordId,
        createdAt: queuedAt,
        updatedAt: queuedAt,
        createdBy: identity(request).uid,
      });
      await firestore.collection('eligibilitySubmissions').doc(recordId).update({
        emailDelivery: { status: 'queued', queuedAt, queuedBy: identity(request).uid, outboxId },
        updatedAt: queuedAt,
      });
      invalidateCollectionCache('eligibilitySubmissions', recordId);
    } catch (error) {
      const code = (error as { code?: number | string } | null)?.code;
      if (code !== 6 && code !== 'already-exists') throw error;
    }
    await audit(request, 'eligibility.patient_email_queued', { organisationId: input.organisationId, recordId, outboxId });
    response.status(202).json({ status: 'queued', outboxId });
  } catch (error) { next(error); }
});

app.patch('/v1/portal/eligibility-submissions/:id', requireRole('hhh_admin'), async (request, response, next) => {
  try {
    const input = z.object({
      organisationId: idSchema.optional(),
      status: z.enum(['reviewing', 'approved', 'declined']),
      decisionNote: z.string().trim().max(2000).nullable().optional(),
      pharmacyDecisionReason: pharmacyDecisionReasonSchema.optional(),
    }).superRefine((value, context) => {
      if (value.status === 'declined' && !value.pharmacyDecisionReason) {
        context.addIssue({ code: 'custom', path: ['pharmacyDecisionReason'], message: 'A pharmacy-facing reason is required for a declined decision.' });
      }
    }).parse(request.body);
    const organisationId = tenantFor(request, input.organisationId);
    const recordId = idSchema.parse(request.params.id);
    const current = await getTenantRecord('eligibilitySubmissions', recordId, organisationId);
    if (negativeEligibilityStatus(current.status)) {
      throw new HttpError(409, 'A declined or rejected eligibility decision is terminal.', 'REFERRAL_DECLINED');
    }
    if (input.status === 'approved') {
      const result = await completeReferral(recordId, identity(request).uid, input.decisionNote ?? null);
      await audit(request, 'eligibility.reviewed', { organisationId, recordId, status: input.status, patientId: result.patientId });
      response.json(result);
      return;
    }
    const reviewedAt = timestamp();
    const result = await updateTenantRecord('eligibilitySubmissions', recordId, organisationId, {
      status: input.status,
      decisionNote: input.decisionNote ?? null,
      reviewedAt,
      reviewedBy: identity(request).uid,
      ...(input.status === 'declined' ? {
        pharmacyDecisionReason: input.pharmacyDecisionReason,
        pharmacyDecisionReasonReviewedAt: reviewedAt,
        pharmacyDecisionReasonReviewedBy: identity(request).uid,
        referral: { status: 'declined', notes: input.decisionNote ?? null, completedAt: reviewedAt, completedBy: identity(request).uid },
      } : {}),
    });
    await audit(request, 'eligibility.reviewed', { organisationId, recordId: result.id, status: input.status });
    response.json(result);
  } catch (error) { next(error); }
});

const patientSchema = z.object({
  firstName: z.string().trim().min(1).max(100),
  surname: z.string().trim().min(1).max(100),
  dob: z.iso.date(),
  email: z.email(),
  mobile: z.string().trim().min(7).max(30),
  address: z.string().trim().max(500),
  postcode: z.string().trim().max(16),
  status: z.enum(['referred', 'active', 'inactive']).default('active'),
  conditions: z.array(conditionIdSchema).max(3).optional(),
  primaryCondition: conditionIdSchema.nullable().optional(),
});
app.get('/v1/portal/patients', async (request, response, next) => { try { const organisationId = tenantFor(request, request.query.organisationId); const records = await listTenantRecords('patients', organisationId); response.json(records); } catch (error) { next(error); } });
app.post('/v1/portal/patients', async (request, response, next) => {
  try { const organisationId = tenantFor(request, request.body.organisationId); const record = await createRecord('patients', { ...patientSchema.parse(request.body), organisationId }); await audit(request, 'patient.created', { organisationId, recordId: record.id }); response.status(201).json(record); } catch (error) { next(error); }
});
app.patch('/v1/portal/patients/:id', async (request, response, next) => {
  try {
    const organisationId = tenantFor(request, request.body.organisationId);
    const patientId = idSchema.parse(request.params.id);
    const current = await getTenantRecord('patients', patientId, organisationId);
    const updates = patientSchema.partial().parse(request.body);
    if (updates.status === 'active' && current.sourceReferralId && !current.activatedAt) {
      throw new HttpError(409, 'A referred patient becomes active only after their first prescription reaches Curaleaf.', 'PATIENT_ACTIVATION_REQUIRES_ORDER');
    }
    const statusChanged = updates.status !== undefined && updates.status !== current.status;
    const record = await updateTenantRecord('patients', patientId, organisationId, {
      ...updates,
      ...(statusChanged ? { statusChangedAt: timestamp() } : {}),
    });
    await audit(request, 'patient.updated', { organisationId, recordId: record.id });
    response.json(record);
  } catch (error) { next(error); }
});

app.get('/v1/portal/finance/prescriptions', async (request, response, next) => {
  try {
    const organisationId = tenantFor(request, request.query.organisationId);
    const range = financeRangeSchema.parse({ from: request.query.from, to: request.query.to });
    response.json(await pharmacyPrescriptionFinance(organisationId, range));
  } catch (error) { next(error); }
});

app.get('/v1/portal/admin/finance/referrals', requireRole('hhh_admin'), async (request, response, next) => {
  try {
    const range = financeRangeSchema.parse({ from: request.query.from, to: request.query.to });
    const organisationId = request.query.organisationId === undefined ? undefined : idSchema.parse(request.query.organisationId);
    response.json(await adminReferralFinance(range, organisationId));
  } catch (error) { next(error); }
});

/* ========================================================================== */
/* Company & Pharmacy Admin Routes                                           */
/* ========================================================================== */

app.get('/v1/portal/admin/companies', requireRole('hhh_admin'), async (_request, response, next) => {
  try {
    const companiesSnap = await firestore.collection('companies').get();
    const companies = companiesSnap.docs.map(doc => doc.data() as Company);
    response.json(companies);
  } catch (error) { next(error); }
});

app.post('/v1/portal/admin/companies', requireRole('hhh_admin'), async (request, response, next) => {
  try {
    const schema = z.object({
      legalName: z.string().trim().min(1).max(200),
      companyNumber: z.string().trim().min(1).max(50),
      registeredAddress: z.string().trim().min(1).max(500),
      ownerContact: z.object({
        name: z.string().trim().min(1).max(200),
        email: z.string().email(),
        phone: z.string().trim().min(1).max(50),
      }),
      superintendent: z.object({
        name: z.string().trim().min(1).max(200),
        gphcNumber: z.string().trim().min(1).max(50),
      }),
      notes: z.string().trim().max(1000).optional(),
    });
    const input = schema.parse(request.body);
    const docRef = firestore.collection('companies').doc();
    const company: Company = {
      id: docRef.id,
      ...input,
      gdprConfirmed: false,
      gdprDocUrl: null,
      gdprEvidenceMethod: null,
      gdprReceiptRecordedAt: null,
      gdprReceiptRecordedBy: null,
      gdprConfirmedAt: null,
      gdprConfirmedBy: null,
      gdprComplianceFlag: false,
      branchesOwned: [],
      notes: input.notes ?? null,
      createdAt: nowIso(),
      updatedAt: nowIso(),
    };
    await docRef.set(company);
    invalidateCollectionCache('companies');
    await audit(request, 'company.created', { companyId: company.id, legalName: company.legalName });
    response.status(201).json(company);
  } catch (error) { next(error); }
});

app.patch('/v1/portal/admin/companies/:id', requireRole('hhh_admin'), async (request, response, next) => {
  try {
    const companyId = idSchema.parse(request.params.id);
    const companyRef = firestore.collection('companies').doc(companyId);
    const snap = await companyRef.get();
    if (!snap.exists) throw new HttpError(404, 'Company not found.', 'NOT_FOUND');
    const updates = request.body as Partial<Company>;
    const updated = { ...snap.data(), ...updates, updatedAt: nowIso() };
    await companyRef.set(updated, { merge: true });
    invalidateCollectionCache('companies', companyId);
    await audit(request, 'company.updated', { companyId });
    response.json(updated);
  } catch (error) { next(error); }
});

app.post('/v1/portal/admin/companies/:id/gdpr/confirm', requireRole('hhh_admin'), async (request, response, next) => {
  try {
    const companyId = idSchema.parse(request.params.id);
    const { gdprDocUrl } = z.object({ gdprDocUrl: z.string().url() }).parse(request.body);
    
    // Validate Google Drive/Docs HTTPS URL
    if (!gdprDocUrl.startsWith('https://drive.google.com/') && !gdprDocUrl.startsWith('https://docs.google.com/')) {
      throw new HttpError(400, 'GDPR evidence URL must be an HTTPS Google Drive or Google Docs URL.', 'INVALID_GDPR_URL');
    }

    const companyRef = firestore.collection('companies').doc(companyId);
    const snap = await companyRef.get();
    if (!snap.exists) throw new HttpError(404, 'Company not found.', 'NOT_FOUND');

    const confirmedAt = nowIso();
    const confirmedBy = identity(request).uid;

    await companyRef.update({
      gdprConfirmed: true,
      gdprDocUrl,
      gdprEvidenceMethod: 'document_link',
      gdprReceiptRecordedAt: null,
      gdprReceiptRecordedBy: null,
      gdprConfirmedAt: confirmedAt,
      gdprConfirmedBy: confirmedBy,
      gdprComplianceFlag: false,
      updatedAt: confirmedAt,
    });
    const activatedOrganisationIds = await autoActivateCompanyIntake(companyId, snap.data()!, confirmedBy, confirmedAt);
    invalidateCollectionCache('companies', companyId);
    await audit(request, 'company.gdpr_confirmed', { companyId, evidenceMethod: 'document_link', confirmedBy, activatedOrganisationIds });
    response.json({ success: true, companyId, gdprConfirmed: true, gdprDocUrl, evidenceMethod: 'document_link', activatedOrganisationIds });
  } catch (error) { next(error); }
});

app.post('/v1/portal/admin/companies/:id/gdpr/record-received', requireRole('hhh_admin'), async (request, response, next) => {
  try {
    const companyId = idSchema.parse(request.params.id);
    z.object({ received: z.literal(true) }).parse(request.body);

    const companyRef = firestore.collection('companies').doc(companyId);
    const snap = await companyRef.get();
    if (!snap.exists) throw new HttpError(404, 'Company not found.', 'NOT_FOUND');

    const recordedAt = nowIso();
    const recordedBy = identity(request).uid;
    await companyRef.update({
      gdprConfirmed: true,
      gdprDocUrl: null,
      gdprEvidenceMethod: 'manual_receipt',
      gdprReceiptRecordedAt: recordedAt,
      gdprReceiptRecordedBy: recordedBy,
      gdprConfirmedAt: recordedAt,
      gdprConfirmedBy: recordedBy,
      gdprComplianceFlag: false,
      updatedAt: recordedAt,
    });
    const activatedOrganisationIds = await autoActivateCompanyIntake(companyId, snap.data()!, recordedBy, recordedAt);
    invalidateCollectionCache('companies', companyId);
    await audit(request, 'company.gdpr_received_recorded', { companyId, evidenceMethod: 'manual_receipt', recordedBy, activatedOrganisationIds });
    response.json({ success: true, companyId, gdprConfirmed: true, evidenceMethod: 'manual_receipt', receivedAt: recordedAt, activatedOrganisationIds });
  } catch (error) { next(error); }
});

app.post('/v1/portal/admin/organisations/:id/gdpr/record-received', requireRole('hhh_admin'), async (request, response, next) => {
  try {
    const organisationId = idSchema.parse(request.params.id);
    z.object({ received: z.literal(true) }).parse(request.body);
    const organisationRef = firestore.collection('organisations').doc(organisationId);
    const organisationSnapshot = await organisationRef.get();
    if (!organisationSnapshot.exists) throw new HttpError(404, 'Pharmacy not found.', 'NOT_FOUND');

    const company = await companyForOrganisation(organisationId, organisationSnapshot.data());
    const evidenceRef = company ? firestore.collection('companies').doc(company.id) : organisationRef;
    const recordedAt = nowIso();
    const recordedBy = identity(request).uid;
    await evidenceRef.update({
      gdprConfirmed: true,
      gdprDocUrl: null,
      gdprEvidenceMethod: 'manual_receipt',
      gdprReceiptRecordedAt: recordedAt,
      gdprReceiptRecordedBy: recordedBy,
      gdprConfirmedAt: recordedAt,
      gdprConfirmedBy: recordedBy,
      gdprComplianceFlag: false,
      updatedAt: recordedAt,
    });
    const activatedOrganisationIds = company
      ? await autoActivateCompanyIntake(company.id, company, recordedBy, recordedAt)
      : await autoActivateOrganisationIntake(organisationId, organisationSnapshot.data()!, recordedBy, recordedAt);
    invalidateCollectionCache('organisations', organisationId);
    if (company) invalidateCollectionCache('companies', company.id);
    invalidateCache('admin:organisations', 'referral:');
    await audit(request, company ? 'company.gdpr_received_recorded' : 'organisation.gdpr_received_recorded', {
      organisationId,
      companyId: company?.id ?? null,
      evidenceMethod: 'manual_receipt',
      recordedBy,
      activatedOrganisationIds,
    });
    response.json({ success: true, organisationId, companyId: company?.id ?? null, gdprConfirmed: true, evidenceMethod: 'manual_receipt', receivedAt: recordedAt, activatedOrganisationIds });
  } catch (error) { next(error); }
});

app.post('/v1/portal/admin/companies/:id/gdpr/clear', requireRole('hhh_admin'), async (request, response, next) => {
  try {
    const companyId = idSchema.parse(request.params.id);
    z.object({ confirm: z.literal(true) }).parse(request.body);

    const companyRef = firestore.collection('companies').doc(companyId);
    const snap = await companyRef.get();
    if (!snap.exists) throw new HttpError(404, 'Company not found.', 'NOT_FOUND');
    const company = snap.data() as Company;

    const clearedAt = nowIso();
    await companyRef.update({
      gdprConfirmed: false,
      gdprDocUrl: null,
      gdprEvidenceMethod: null,
      gdprReceiptRecordedAt: null,
      gdprReceiptRecordedBy: null,
      gdprConfirmedAt: null,
      gdprConfirmedBy: null,
      gdprComplianceFlag: true,
      updatedAt: clearedAt,
    });

    const declaredBranches = new Set(company.branchesOwned || []);
    const linkedBranches = await firestore.collection('organisations').where('orgId', '==', companyId).get();
    linkedBranches.docs.forEach(document => declaredBranches.add(document.id));
    const companyNumberBranches = company.companyNumber
      ? await firestore.collection('organisations').where('companyNumber', '==', company.companyNumber).get()
      : null;
    companyNumberBranches?.docs.forEach(document => declaredBranches.add(document.id));
    for (const organisationId of declaredBranches) {
      const organisationRef = firestore.collection('organisations').doc(organisationId);
      if (!(await organisationRef.get()).exists) continue;
      await organisationRef.set({ status: 'paused', gdprComplianceFlag: true, pausedReason: 'company_gdpr_evidence_removed', pausedAt: clearedAt, updatedAt: clearedAt }, { merge: true });
      invalidateCollectionCache('organisations', organisationId);
      await audit(request, 'organisation.auto_paused', { organisationId, companyId, reason: 'company_gdpr_evidence_removed' });
    }

    invalidateCollectionCache('companies', companyId);
    invalidateCache('admin:organisations', 'referral:');
    await audit(request, 'company.gdpr_cleared', { companyId, priorEvidenceMethod: gdprEvidenceMethod(company) });
    response.json({ success: true, companyId, gdprConfirmed: false });
  } catch (error) { next(error); }
});

app.post('/v1/portal/admin/pharmacies/:id/validate-curaleaf', requireRole('hhh_admin'), async (request, response, next) => {
  try {
    const pharmacyId = idSchema.parse(request.params.id);
    await getRecord('organisations', pharmacyId);
    const { environment, apiKey } = z.object({
      environment: z.enum(['test', 'production']),
      apiKey: z.string().min(16),
    }).parse(request.body);

    // Call Curaleaf API to validate key and derive customerId
    const baseUrl = environment === 'test' ? 'https://api.curaleaflaboratories.dev' : config.CURALEAF_BASE_URL;
    const res = await fetch(`${baseUrl}/v1/products/?pageSize=1`, {
      headers: { Accept: 'application/json', 'X-API-Key': apiKey },
    });

    if (!res.ok) {
      throw new HttpError(400, `Curaleaf key validation failed with status ${res.status}.`, 'CURALEAF_VALIDATION_FAILED');
    }

    const body = (await res.json()) as Record<string, unknown>;
    let observedCustomerId: string | null = null;
    if (Array.isArray(body.products) && body.products[0] && typeof body.products[0].customerId === 'string') {
      observedCustomerId = body.products[0].customerId;
    }

    const maskedKey = `${apiKey.slice(0, 4)}...${apiKey.slice(-4)}`;
    const validationRecord: CuraleafValidationRecord = {
      environment,
      validatedAt: nowIso(),
      actor: identity(request).uid,
      maskedKey,
      observedCustomerId,
    };

    const pharmRef = firestore.collection('organisations').doc(pharmacyId);
    const fieldToUpdate = environment === 'test' ? 'curaleafTestValidation' : 'curaleafLiveValidation';

    // Store key in Secret Manager
    const secretIntegration = environment === 'test' ? 'curaleaf_test' : 'curaleaf_live';
    await writeIntegrationSecret(pharmacyId, secretIntegration, {
      writeApiKey: apiKey,
      customerId: observedCustomerId || '',
    });
    await pharmRef.set({
      [fieldToUpdate]: validationRecord,
      ...(environment === 'production' ? { curaleafLiveSecretStoredAt: validationRecord.validatedAt } : {}),
      updatedAt: nowIso(),
    }, { merge: true });

    invalidateCollectionCache('organisations', pharmacyId);
    invalidateCache('admin:organisations');
    await audit(request, 'pharmacy.curaleaf_validated', { pharmacyId, environment, maskedKey, observedCustomerId });
    response.json({ success: true, pharmacyId, validationRecord });
  } catch (error) { next(error); }
});





const orderLineItemSchema = z.object({ packId: idSchema, quantity: z.number().int().positive().max(100) });
export type NormalisedStockStatus = 'in_stock' | 'low_stock' | 'out_of_stock';
export function normaliseStockStatus(inStock: boolean, stockStatus?: NormalisedStockStatus): NormalisedStockStatus {
  return !inStock ? 'out_of_stock' : stockStatus === 'low_stock' ? 'low_stock' : 'in_stock';
}

export function resolveOrderPaymentRoute(requested: 'manual' | 'worldpay' | undefined, configuredDefault: unknown) {
  return requested ?? (configuredDefault === 'worldpay' ? 'worldpay' as const : 'manual' as const);
}

export function draftHasPaymentBoundary(order: Record<string, unknown>, paymentRecordExists: boolean) {
  return order.paymentRoute === 'manual'
    || order.paymentStatus === 'awaiting_manual_payment'
    || typeof order.paymentId === 'string'
    || paymentRecordExists
    || order.paymentStatus === 'paid';
}

export function prescriptionFileRemovalAllowed(status: unknown, linkedToOrder: boolean) {
  return status === 'uploaded' && !linkedToOrder;
}

const curaleafQuoteSchema = z.object({
  shippingPrice: z.string().trim().min(1).max(40),
  taxRate: z.string().trim().min(1).max(40),
  items: z.array(z.object({
    packId: idSchema,
    quantity: z.number().int().positive().max(100),
    inStock: z.boolean(),
    stockStatus: z.enum(['in_stock', 'low_stock', 'out_of_stock']).optional(),
    wholesalePackPrice: z.string().trim().min(1).max(40),
    patientPackPrice: z.string().trim().min(1).max(40),
  }).transform(item => ({
    ...item,
    stockStatus: normaliseStockStatus(item.inStock, item.stockStatus),
  }))).min(1).max(100),
});

function parsedCuraleafQuote(raw: unknown, message = 'Curaleaf returned an invalid quote response.') {
  const parsed = curaleafQuoteSchema.safeParse(raw);
  if (!parsed.success) throw new HttpError(502, message, 'INVALID_SUPPLIER_QUOTE');
  return parsed.data;
}
function addPrescriptionDateIssue(issueDate: string, expiryDate: string | undefined, context: z.RefinementCtx) {
  const status = prescriptionDateWindowStatus(issueDate, expiryDate);
  if (status === 'current') return;
  const message = status === 'future'
    ? 'Prescription issue date cannot be in the future.'
    : status === 'expired'
      ? 'Prescription issue date is outside the current 28-day window.'
      : 'Prescription dates must define a valid 28-day window.';
  context.addIssue({ code: 'custom', path: ['issueDate'], message });
}

const orderPrescriptionSchema = z.object({
  id: idSchema.optional(),
  fileId: idSchema,
  clinicScanId: idSchema.optional(),
  curaleafPrescriptionId: idSchema.optional(),
  serialNumber: z.string().trim().min(1).max(200),
  issueDate: z.iso.date(),
  expiryDate: z.iso.date().optional(),

  patient: z.object({
    name: z.string().trim().min(1).max(200),
    dob: z.iso.date(),
  }),
  prescriber: z.object({
    id: idSchema.optional(),
    pin: z.string().max(100).default(''),
    gmcNumber: z.number().int().positive().nullable(),
    gphcNumber: z.string().max(100).nullable(),
    name: z.string().min(1).max(200),
    initials: z.string().min(1).max(20),
  }),
  items: z.array(z.object({
    formulaId: idSchema,
    unitsNeededCount: z.number().int().positive().max(100),
    packId: idSchema,
    quantity: z.number().int().positive().max(100),
  })).min(1).max(50),
}).superRefine((prescription, context) => addPrescriptionDateIssue(prescription.issueDate, prescription.expiryDate, context));
const orderSchema = z.object({
  draftId: idSchema.optional(),
  patientId: idSchema,
  lineItems: z.array(orderLineItemSchema).min(1).max(50),
  prescriptions: z.array(orderPrescriptionSchema).min(1).max(20),
  dispensingFeePence: z.number().int().nonnegative().default(0),
  currency: z.literal('GBP').default('GBP'),
  paymentRoute: z.enum(['manual', 'worldpay']).optional(),
  redoContext: z.object({
    originalOrderId: z.union([idSchema, z.number()]),
    isPaidRedo: z.boolean().default(true),
    originalTotalPence: z.number().int().nonnegative().optional(),
    priceDifferencePence: z.number().int().default(0),
    requireCuraleafAuth: z.boolean().default(true),
    priceResolution: z.enum(['absorb', 'continue_as_fee', 'refund_and_recharge']).optional(),
  }).optional(),
}).superRefine((order, context) => {
  const feeAligned = order.redoContext?.priceResolution === 'continue_as_fee';
  if (feeAligned ? order.dispensingFeePence < 0 : !validDispensingFeePence(order.dispensingFeePence)) {
    context.addIssue({
      code: 'custom',
      path: ['dispensingFeePence'],
      message: feeAligned
        ? 'Dispensing fee must be zero or a positive amount when a price drop is taken into the fee.'
        : 'Dispensing fee must be £0 or between £5 and £15.',
    });
  }
});

const WORLDPAY_MIN_LINK_EXPIRY_SECONDS = 300;
const WORLDPAY_MAX_LINK_EXPIRY_SECONDS = FLOW_CONFIG.linkExpiryHours * 60 * 60;

function worldpayLinkExpirySeconds(order: Record<string, unknown>, now = new Date()) {
  const prescriptions = Array.isArray(order.prescriptions)
    ? order.prescriptions.filter((value): value is Record<string, unknown> => Boolean(value) && typeof value === 'object')
    : [];
  const linkExpiresAt = paymentLinkExpiryAt(prescriptions, now);
  const remainingSeconds = Math.floor((Date.parse(linkExpiresAt) - now.getTime()) / 1_000);
  if (remainingSeconds < WORLDPAY_MIN_LINK_EXPIRY_SECONDS) {
    throw new HttpError(409, 'The prescription expires too soon to create a Worldpay link. Review or replace the prescription first.', 'PRESCRIPTION_EXPIRY_TOO_CLOSE');
  }
  return Math.min(WORLDPAY_MAX_LINK_EXPIRY_SECONDS, remainingSeconds);
}


function normalisedPatientName(value: string) {
  return value
    .normalize('NFKD')
    .replace(/\p{Diacritic}/gu, '')
    .toLocaleLowerCase('en-GB')
    .replace(/\b(mr|mrs|miss|ms|mx|dr)\b\.?/g, ' ')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
    .split(/\s+/)
    .filter(Boolean)
    .sort()
    .join(' ');
}

function requireMatchingPatient(prescription: { name: string; dob: string }, patient: Record<string, unknown>) {
  const selectedName = `${String(patient.firstName ?? '')} ${String(patient.surname ?? '')}`.trim();
  if (prescription.dob !== patient.dob || normalisedPatientName(prescription.name) !== normalisedPatientName(selectedName)) {
    throw new HttpError(409, 'The prescription patient does not match the selected patient record.', 'PRESCRIPTION_PATIENT_MISMATCH');
  }
}

function packQuantities(items: Array<{ packId: string; quantity: number }>) {
  const quantities = new Map<string, number>();
  items.forEach(item => quantities.set(item.packId, (quantities.get(item.packId) ?? 0) + item.quantity));
  return quantities;
}

function samePackQuantities(left: Map<string, number>, right: Map<string, number>) {
  return left.size === right.size && [...left].every(([packId, quantity]) => right.get(packId) === quantity);
}

function curaleafMoneyPence(value: unknown, field = 'price') {
  const price = String(value ?? '').trim();
  const match = /^(\d+)(?:\.(\d+))?$/.exec(price);
  if (!match || (match[2]?.slice(2).match(/[1-9]/))) throw new HttpError(502, `Curaleaf returned an invalid ${field}.`, 'INVALID_SUPPLIER_PRICE');
  const pence = BigInt(match[1]!) * 100n + BigInt((match[2] ?? '').padEnd(2, '0').slice(0, 2) || '0');
  if (pence > 10_000_000n) throw new HttpError(502, `Curaleaf returned a ${field} outside the supported range.`, 'INVALID_SUPPLIER_PRICE');
  return Number(pence);
}

type ParsedCuraleafQuote = z.input<typeof curaleafQuoteSchema>;
type QuoteDifference = {
  category: 'stock' | 'patient_price' | 'supplier_cost';
  field: string;
  packId?: string;
  previous: string | boolean;
  latest: string | boolean;
};

export function normalisedQuote(quote: ParsedCuraleafQuote) {
  return {
    shippingPence: curaleafMoneyPence(quote.shippingPrice, 'shipping price'),
    taxRate: Number(quote.taxRate),
    items: [...quote.items].sort((left, right) => left.packId.localeCompare(right.packId)).map(item => ({
      packId: item.packId,
      quantity: item.quantity,
      inStock: item.inStock,
      stockStatus: normaliseStockStatus(item.inStock, item.stockStatus),
      wholesalePence: curaleafMoneyPence(item.wholesalePackPrice, 'wholesale pack price'),
      patientPence: curaleafMoneyPence(item.patientPackPrice, 'patient pack price'),
    })),
  };
}

export function quoteFingerprint(quote: ParsedCuraleafQuote) {
  return createHash('sha256').update(JSON.stringify(normalisedQuote(quote))).digest('hex');
}

export function compareQuotes(baseline: ParsedCuraleafQuote, latest: ParsedCuraleafQuote): QuoteDifference[] {
  const differences: QuoteDifference[] = [];
  const prior = normalisedQuote(baseline);
  const next = normalisedQuote(latest);
  const priorItems = new Map(prior.items.map(item => [item.packId, item]));
  for (const item of next.items) {
    const earlier = priorItems.get(item.packId);
    if (!earlier) continue;
    if (item.stockStatus !== earlier.stockStatus) differences.push({ category: 'stock', field: 'stockStatus', packId: item.packId, previous: earlier.stockStatus, latest: item.stockStatus });
    if (item.patientPence !== earlier.patientPence) differences.push({ category: 'patient_price', field: 'patientPackPrice', packId: item.packId, previous: String(earlier.patientPence), latest: String(item.patientPence) });
    if (item.wholesalePence !== earlier.wholesalePence) differences.push({ category: 'supplier_cost', field: 'wholesalePackPrice', packId: item.packId, previous: String(earlier.wholesalePence), latest: String(item.wholesalePence) });
  }
  if (prior.shippingPence !== next.shippingPence) differences.push({ category: 'supplier_cost', field: 'shippingPrice', previous: String(prior.shippingPence), latest: String(next.shippingPence) });
  if (prior.taxRate !== next.taxRate) differences.push({ category: 'supplier_cost', field: 'taxRate', previous: String(prior.taxRate), latest: String(next.taxRate) });
  return differences;
}

async function finalCuraleafQuote(organisationId: string, items: Array<{ packId: string; quantity: number }>) {
  const raw = await curaleafRequest<unknown>(organisationId, '/v1/quotes/', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ items }),
  });
  const quote = parsedCuraleafQuote(raw, 'Curaleaf returned an invalid final quote.');
  if (!samePackQuantities(packQuantities(items), packQuantities(quote.items))) {
    throw new HttpError(409, 'Curaleaf’s final quote does not match this order.', 'SUPPLIER_QUOTE_MISMATCH');
  }
  return quote;
}

async function requireApprovedFinalQuote(request: Request, organisationId: string, orderId: string, order: Record<string, unknown>, items: Array<{ packId: string; quantity: number }>) {
  const latest = await finalCuraleafQuote(organisationId, items);
  const baselineResult = curaleafQuoteSchema.safeParse(order.pricingQuote);
  const fingerprint = quoteFingerprint(latest);
  const existingReview = order.quoteReview && typeof order.quoteReview === 'object' ? order.quoteReview as Record<string, unknown> : {};
  const differences = baselineResult.success ? compareQuotes(baselineResult.data, latest) : [{ category: 'patient_price' as const, field: 'missingOriginalQuote', previous: 'missing', latest: 'present' }];
  const outOfStock = latest.items.some(item => item.stockStatus === 'out_of_stock');
  if (!outOfStock && differences.length === 0) return latest;
  const reviewType = outOfStock ? 'out_of_stock' : differences.some(item => item.category === 'patient_price') ? 'patient_price_changed' : 'supplier_cost_changed';
  if (reviewType === 'supplier_cost_changed' && existingReview.status === 'approved' && existingReview.approvedFingerprint === fingerprint) return latest;
  const quoteReview = {
    status: reviewType === 'patient_price_changed' ? 'recreate_required' : 'required',
    type: reviewType,
    fingerprint,
    latestQuote: latest,
    differences,
    checkedAt: timestamp(),
  };
  await firestore.collection('orders').doc(orderId).update({ quoteReview, integrationStatus: 'quote_review_required', updatedAt: timestamp() });
  const supportCaseId = createHash('sha256').update(`${organisationId}:${orderId}:quote_review:${fingerprint}`).digest('hex');
  const supportCase = firestore.collection('curaleafSupportCases').doc(supportCaseId);
  if (!(await supportCase.get()).exists) {
    await supportCase.create({
      id: supportCaseId,
      schemaVersion: 1,
      organisationId,
      orderId,
      reason: 'quote_review',
      status: 'open',
      note: reviewType === 'patient_price_changed' ? 'The patient price changed after payment; cancel/refund and recreate this order.' : reviewType === 'out_of_stock' ? 'Curaleaf reports an out-of-stock pack.' : 'Curaleaf supplier costs changed after payment and require approval.',
      prescriptionId: null,
      purchaseOrderId: null,
      openedBy: identity(request).uid,
      openedByRole: identity(request).role,
      openedAt: timestamp(),
      createdAt: timestamp(),
      updatedAt: timestamp(),
    });
  }
  invalidateCollectionCache('orders', orderId);
  await audit(request, 'curaleaf.quote_review_required', { organisationId, orderId, reviewType, fingerprint, differences });
  const message = reviewType === 'out_of_stock'
    ? 'Curaleaf reports that one or more packs are out of stock. The supplier order has not been placed.'
    : reviewType === 'patient_price_changed'
      ? 'Curaleaf’s patient price changed after payment. Cancel or refund this order and recreate it before supplier placement.'
      : 'Curaleaf’s supplier cost changed after payment. Review and approve the latest quote before placement.';
  throw new HttpError(409, message, 'QUOTE_REVIEW_REQUIRED');
}

type ClinicScanProduct = {
  id: string;
  formulaId: string;
  formulaName: string;
  formulaUnit: string;
  patientPackPrice: string;
  quantity: number;
  state: string;
};

type ClinicScanLine = {
  formulaId: string;
  formulaName: string;
  unit: string;
  unitsNeededCount: number;
  unitsAssignedCount: number;
};

function matchClinicPrescriptionPacks(lines: ClinicScanLine[], products: ClinicScanProduct[]) {
  return lines.map(line => {
    const candidates = products
      .filter(product => product.state === 'ACTIVE' && product.formulaId === line.formulaId && product.quantity > 0 && line.unitsNeededCount % product.quantity === 0)
      .map(product => ({
        product,
        packQuantity: line.unitsNeededCount / product.quantity,
        totalPence: curaleafMoneyPence(product.patientPackPrice, 'patient pack price') * (line.unitsNeededCount / product.quantity),
      }))
      .sort((left, right) => left.packQuantity - right.packQuantity || left.totalPence - right.totalPence || left.product.id.localeCompare(right.product.id));
    if (!candidates.length) {
      throw new HttpError(409, `Curaleaf has not supplied an active pack that exactly fulfils ${line.formulaName}. Contact your HHH administrator.`, 'CURALEAF_PACK_MATCH_UNAVAILABLE');
    }
    const best = candidates[0]!;
    const equallyRanked = candidates.filter(candidate => candidate.packQuantity === best.packQuantity && candidate.totalPence === best.totalPence);
    if (equallyRanked.length > 1) {
      throw new HttpError(409, `Curaleaf returned more than one equivalent pack for ${line.formulaName}. Contact your HHH administrator before taking payment.`, 'CURALEAF_PACK_MATCH_AMBIGUOUS');
    }
    return {
      packId: best.product.id,
      formulaId: line.formulaId,
      formulaName: line.formulaName,
      unit: line.unit,
      packSize: best.product.quantity,
      quantity: best.packQuantity,
      unitsNeededCount: line.unitsNeededCount,
      patientPackPrice: best.product.patientPackPrice,
    };
  });
}

type ClinicScanDetails = Awaited<ReturnType<typeof scanClinicPrescription>>;
type StoredClinicScanResult = {
  prescription: ClinicScanDetails['prescription'];
  prescriber: Omit<ClinicScanDetails['prescriber'], 'pin'>;
  matchedItems: ReturnType<typeof matchClinicPrescriptionPacks>;
};

function publicClinicScan(scanId: string, result: StoredClinicScanResult) {
  return {
    scanId,
    status: 'ready' as const,
    prescription: result.prescription,
    prescriber: {
      id: result.prescriber.id,
      name: result.prescriber.name,
      initials: result.prescriber.initials,
      gmcNumber: result.prescriber.gmcNumber,
      gphcNumber: result.prescriber.gphcNumber,
    },
    matchedItems: result.matchedItems,
  };
}

app.post('/v1/portal/integrations/curaleaf/prescriptions/scan', async (request, response, next) => {
  let scanDocument: DocumentReference | undefined;
  try {
    const input = z.object({ organisationId: idSchema.optional(), fileId: idSchema }).parse(request.body);
    const organisationId = tenantFor(request, input.organisationId);
    await requireSetupComplete(organisationId);
    const scanId = createHash('sha256').update(`${organisationId}:${input.fileId}:curaleaf-clinic-scan`).digest('hex');
    const document = firestore.collection('curaleafPrescriptionScans').doc(scanId);
    scanDocument = document;
    let snapshot = await document.get();
    if (snapshot.exists && snapshot.data()?.status === 'ready') {
      response.json(publicClinicScan(scanId, snapshot.data()!.result as StoredClinicScanResult));
      return;
    }
    let created = false;
    if (!snapshot.exists) {
      await document.create({
        id: scanId,
        schemaVersion: 1,
        organisationId,
        fileId: input.fileId,
        status: 'started',
        prescriptionId: null,
        createdBy: identity(request).uid,
        createdAt: timestamp(),
        updatedAt: timestamp(),
      });
      created = true;
      snapshot = await document.get();
    }
    let prescriptionId = typeof snapshot.data()?.prescriptionId === 'string' ? snapshot.data()!.prescriptionId as string : undefined;
    if (!prescriptionId) {
      if (!created) {
        if (snapshot.data()?.status === 'reconciliation_required') {
          throw new HttpError(409, 'Curaleaf may have received this barcode but did not return a reference. Contact your HHH administrator before scanning it again.', 'CURALEAF_SCAN_RECONCILIATION_REQUIRED');
        }
        if (snapshot.data()?.status === 'failed') {
          throw new HttpError(409, 'This barcode scan could not be completed. Reattach a clear prescription copy to start a new scan.', 'CURALEAF_SCAN_FAILED');
        }
        response.status(202).json({ scanId, status: 'processing' });
        return;
      }
      const file = await loadUploadedPrescriptionFile(organisationId, input.fileId);
      prescriptionId = await uploadClinicPrescriptionImage(organisationId, file);
      await document.update({ prescriptionId, status: 'processing', updatedAt: timestamp() });
    }
    let scan;
    try {
      scan = await scanClinicPrescription(organisationId, { prescriptionId });
    } catch (error) {
      if (error instanceof CuraleafRequestError && error.status === 404) {
        await document.update({ status: 'processing', updatedAt: timestamp() });
        response.status(202).json({ scanId, status: 'processing', prescriptionId });
        return;
      }
      throw error;
    }
    const catalogue = await tenantCuraleafCatalogue(organisationId);
    const productPage = {
      records: catalogue.products as ClinicScanProduct[],
      totalRecordCount: catalogue.productTotal,
    };
    const matchedItems = matchClinicPrescriptionPacks(scan.prescription.items, productPage.records);
    const { pin: _unusedPin, ...prescriber } = scan.prescriber;
    const result: StoredClinicScanResult = { ...scan, prescriber, matchedItems };
    await document.update({ status: 'ready', result, updatedAt: timestamp() });
    await audit(request, 'curaleaf.clinic_scanned', { organisationId, recordId: scanId, prescriptionId });
    response.json(publicClinicScan(scanId, result));
  } catch (error) {
    if (scanDocument) {
      await scanDocument.set({
        status: error instanceof CuraleafRequestError && error.ambiguousWrite ? 'reconciliation_required' : 'failed',
        errorCode: error instanceof HttpError ? error.code : 'UNKNOWN',
        updatedAt: timestamp(),
      }, { merge: true }).catch(() => undefined);
    }
    next(error);
  }
});

app.get('/v1/portal/orders', async (request, response, next) => {
  try {
    const organisationId = tenantFor(request, request.query.organisationId);
    const patientId = typeof request.query.patientId === 'string' && request.query.patientId.trim()
      ? idSchema.parse(request.query.patientId)
      : null;
    const unresolvedOnly = request.query.unresolvedOnly === 'true' || request.query.unresolvedOnly === '1';
    const records = patientId
      ? await listTenantRecordsByField('orders', organisationId, 'patientId', patientId)
      : await listTenantRecords('orders', organisationId);
    const enriched = records
      .map(record => enrichOrderRecord(record as Record<string, unknown>))
      .filter(record => {
        if (unresolvedOnly && !record.redoEligible) return false;
        return true;
      });
    response.json(enriched);
  } catch (error) { next(error); }
});

app.post('/v1/portal/orders/:id/handout', async (request, response, next) => {
  try {
    const input = z.object({ organisationId: idSchema.optional() }).parse(request.body);
    const organisationId = tenantFor(request, input.organisationId);
    const orderId = idSchema.parse(request.params.id);
    const orderRef = firestore.collection('orders').doc(orderId);
    const actor = identity(request);
    const completedAt = nowIso();
    const auditId = createHash('sha256').update(`${organisationId}:${orderId}:patient-handout`).digest('hex');

    const result = await firestore.runTransaction(async transaction => {
      const orderSnapshot = await transaction.get(orderRef);
      if (!orderSnapshot.exists || orderSnapshot.data()?.organisationId !== organisationId) {
        throw new HttpError(404, 'Order record not found.', 'NOT_FOUND');
      }
      const order = orderSnapshot.data()!;
      if (order.fulfilmentStatus === 'collected' || order.handout?.status === 'completed') {
        return { order: { ...order, id: orderId }, idempotent: true, completedAt: String(order.handout?.completedAt ?? order.collectedAt ?? completedAt) };
      }

      const flow = order.prescriptionFlow && typeof order.prescriptionFlow === 'object'
        ? order.prescriptionFlow as Record<string, Record<string, unknown>>
        : {};
      const handoutPlan = planOrderHandout(flow);
      if (!handoutPlan.ready && handoutPlan.code === 'ORDER_NOT_READY_FOR_HANDOUT') {
        throw new HttpError(409, 'Every active prescription must be ready to collect before handout.', 'ORDER_NOT_READY_FOR_HANDOUT');
      }
      if (!handoutPlan.ready) throw new HttpError(409, 'The order has no ready shipments to hand out.', handoutPlan.code ?? 'SHIPMENT_REQUIRED');
      const { activeFlows, shipmentIds } = handoutPlan;
      const shipmentRefs = shipmentIds.map(shipmentId => firestore.collection('shipments').doc(shipmentId));
      const shipmentSnapshots = await Promise.all(shipmentRefs.map(reference => transaction.get(reference)));
      if (shipmentSnapshots.some(snapshot => !snapshot.exists || snapshot.data()?.organisationId !== organisationId)) {
        throw new HttpError(409, 'One or more linked shipments could not be verified.', 'SHIPMENT_ORDER_LINK_REQUIRED');
      }
      const shipmentStatuses = Object.fromEntries(shipmentSnapshots.map(snapshot => [snapshot.id, String(snapshot.data()?.status ?? '')]));
      if (!shipmentsReadyForHandout(shipmentIds, shipmentStatuses)) {
        throw new HttpError(409, 'Every shipment must be ready to collect before handout.', 'ORDER_NOT_READY_FOR_HANDOUT');
      }

      const nextFlow = Object.fromEntries(Object.entries(flow).map(([prescriptionId, prescription]) => {
        if (!activeFlows.some(([activeId]) => activeId === prescriptionId) || prescription.state === 'COLLECTED') return [prescriptionId, prescription];
        const lines = (Array.isArray(prescription.lines) ? prescription.lines as Array<Record<string, unknown>> : []).map(line => ({
          ...line,
          collected: Math.max(0, Number(line.received ?? 0)),
        }));
        const shipmentStates = prescription.shipmentStates && typeof prescription.shipmentStates === 'object'
          ? Object.fromEntries(Object.keys(prescription.shipmentStates as Record<string, unknown>).map(shipmentId => [shipmentId, 'collected']))
          : Object.fromEntries((Array.isArray(prescription.shipmentIds) ? prescription.shipmentIds : []).map(shipmentId => [String(shipmentId), 'collected']));
        return [prescriptionId, { ...prescription, state: 'COLLECTED', lines, shipmentStates, collectedAt: completedAt, updatedAt: completedAt }];
      }));
      shipmentSnapshots.forEach(snapshot => {
        if (snapshot.data()?.status !== 'collected') transaction.update(snapshot.ref, { status: 'collected', collectedAt: completedAt, collectedBy: actor.uid, updatedAt: completedAt });
      });
      const handout = { status: 'completed', completedAt, completedBy: actor.uid, shipmentIds };
      transaction.set(orderRef, { prescriptionFlow: nextFlow, fulfilmentStatus: 'collected', collectedAt: completedAt, handout, updatedAt: completedAt }, { merge: true });
      transaction.create(firestore.collection('auditLogs').doc(auditId), {
        id: auditId,
        schemaVersion: 1,
        event: 'order.patient_handout_recorded',
        actorUid: actor.uid,
        actorEmail: actor.email ?? null,
        actorRole: actor.role,
        organisationId,
        orderId,
        shipmentIds,
        requestId: request.get('x-request-id') ?? null,
        ipHash: null,
        occurredAt: completedAt,
      });
      return { order: { ...order, prescriptionFlow: nextFlow, fulfilmentStatus: 'collected', collectedAt: completedAt, handout, updatedAt: completedAt, id: orderId }, idempotent: false, completedAt };
    });

    await recordCollectedDispense(orderId, actor.uid, 'order-handout', result.completedAt);
    invalidateCollectionCache('orders', orderId);
    invalidateCollectionCache('shipments');
    response.json({ order: enrichOrderRecord(result.order as Record<string, unknown>), idempotent: result.idempotent });
  } catch (error) { next(error); }
});

const orderDraftSchema = z.object({
  organisationId: idSchema.optional(),
  patientId: idSchema.nullable().optional(),
  payload: z.record(z.string(), z.unknown()).default({}),
});

app.get('/v1/portal/order-drafts', async (request, response, next) => {
  try {
    const organisationId = tenantFor(request, request.query.organisationId);
    const records = await listTenantRecords('orderDrafts', organisationId, 200);
    response.json(records.filter(record => record.status === 'draft'));
  } catch (error) { next(error); }
});

app.post('/v1/portal/order-drafts', async (request, response, next) => {
  try {
    const input = orderDraftSchema.parse(request.body);
    const organisationId = tenantFor(request, input.organisationId);
    if (input.patientId) await getTenantRecord('patients', input.patientId, organisationId);
    const record = await createRecord('orderDrafts', {
      organisationId,
      patientId: input.patientId ?? null,
      status: 'draft',
      paymentStatus: 'none',
      payload: input.payload,
      createdBy: identity(request).uid,
    });
    await audit(request, 'order_draft.created', { organisationId, draftId: record.id });
    response.status(201).json(record);
  } catch (error) { next(error); }
});

app.patch('/v1/portal/order-drafts/:id', async (request, response, next) => {
  try {
    const input = orderDraftSchema.partial().parse(request.body);
    const organisationId = tenantFor(request, input.organisationId);
    const draftId = idSchema.parse(request.params.id);
    const draft = await getTenantRecord('orderDrafts', draftId, organisationId);
    if (draft.status !== 'draft' || draft.paymentStatus !== 'none') throw new HttpError(409, 'Only unpaid drafts can be edited.', 'DRAFT_LOCKED');
    if (input.patientId) await getTenantRecord('patients', input.patientId, organisationId);
    const result = await updateTenantRecord('orderDrafts', draftId, organisationId, {
      ...(input.patientId !== undefined ? { patientId: input.patientId } : {}),
      ...(input.payload ? { payload: input.payload } : {}),
      updatedBy: identity(request).uid,
    });
    response.json(result);
  } catch (error) { next(error); }
});

app.delete('/v1/portal/order-drafts/:id', async (request, response, next) => {
  try {
    const organisationId = tenantFor(request, request.query.organisationId);
    const draftId = idSchema.parse(request.params.id);
    const draft = await getTenantRecord('orderDrafts', draftId, organisationId);
    const linkedOrderId = draft.status === 'promoted' && typeof draft.orderId === 'string' ? draft.orderId : null;
    if (draft.status !== 'draft' && !linkedOrderId) throw new HttpError(409, 'A draft cannot be deleted after payment activity begins.', 'DRAFT_LOCKED');
    if (linkedOrderId) {
      const order = await getTenantRecord('orders', linkedOrderId, organisationId);
      const payments = await firestore.collection('payments').where('orderId', '==', linkedOrderId).limit(1).get();
      if (draftHasPaymentBoundary(order, !payments.empty)) {
        throw new HttpError(409, 'A draft cannot be deleted after a payment link or manual-payment process begins.', 'DRAFT_LOCKED');
      }
      const [placements, operations] = await Promise.all([
        firestore.collection('prescriptionPlacements').where('orderId', '==', linkedOrderId).get(),
        firestore.collection('integrationOperations').where('orderId', '==', linkedOrderId).get(),
      ]);
      const batch = firestore.batch();
      placements.docs.forEach(document => batch.delete(document.ref));
      operations.docs.forEach(document => batch.set(document.ref, { status: 'abandoned', abandonedAt: timestamp(), abandonedBy: identity(request).uid, updatedAt: timestamp() }, { merge: true }));
      if (typeof order.redoOfOrderId === 'string') {
        const source = firestore.collection('orders').doc(order.redoOfOrderId);
        batch.set(source, { redoneByOrderId: null, unresolvedClosedAt: null, redoEligible: true, updatedAt: timestamp() }, { merge: true });
      }
      batch.delete(firestore.collection('orders').doc(linkedOrderId));
      batch.delete(firestore.collection('orderDrafts').doc(draftId));
      await batch.commit();
      invalidateCollectionCache('orders', linkedOrderId);
      invalidateCollectionCache('prescriptionPlacements');
      invalidateCollectionCache('integrationOperations');
    } else {
      if (draft.paymentStatus !== 'none') throw new HttpError(409, 'A draft cannot be deleted after payment activity begins.', 'DRAFT_LOCKED');
      await firestore.collection('orderDrafts').doc(draftId).delete();
    }
    invalidateCollectionCache('orderDrafts', draftId);
    await audit(request, 'order_draft.deleted', { organisationId, draftId, linkedOrderId });
    response.status(204).end();
  } catch (error) { next(error); }
});

const prescriberDirectoryInputSchema = z.object({
  organisationId: idSchema.optional(),
  name: z.string().trim().min(2).max(200),
  initials: z.string().trim().min(1).max(20).optional(),
  pin: z.string().trim().min(1).max(100),
  gmcNumber: z.number().int().positive().nullable().default(null),
  gphcNumber: z.string().trim().max(100).nullable().default(null),
});

app.get('/v1/portal/prescribers', async (request, response, next) => {
  try {
    tenantFor(request, request.query.organisationId);
    const query = String(request.query.query ?? '').trim().toLocaleLowerCase('en-GB');
    const snapshot = await firestore.collection('prescriberDirectory').where('active', '==', true).limit(500).get();
    const records = snapshot.docs.map(document => document.data()).filter(record => !query || `${record.name} ${record.pin} ${record.gmcNumber ?? ''} ${record.gphcNumber ?? ''}`.toLocaleLowerCase('en-GB').includes(query));
    response.json(records.slice(0, 50));
  } catch (error) { next(error); }
});

app.post('/v1/portal/prescribers', async (request, response, next) => {
  try {
    const input = prescriberDirectoryInputSchema.parse(request.body);
    const organisationId = tenantFor(request, input.organisationId);
    const normalPin = input.pin.toLocaleLowerCase('en-GB');
    const normalGphc = input.gphcNumber?.toLocaleLowerCase('en-GB') ?? '';
    const directory = await firestore.collection('prescriberDirectory').where('active', '==', true).limit(500).get();
    const duplicate = directory.docs.find(document => {
      const candidate = document.data();
      return String(candidate.pin ?? '').toLocaleLowerCase('en-GB') === normalPin
        || Boolean(input.gmcNumber && Number(candidate.gmcNumber) === input.gmcNumber)
        || Boolean(normalGphc && String(candidate.gphcNumber ?? '').toLocaleLowerCase('en-GB') === normalGphc);
    });
    const unique = input.gmcNumber ? `gmc:${input.gmcNumber}` : normalGphc ? `gphc:${normalGphc}` : `pin:${normalPin}`;
    const id = duplicate?.id ?? createHash('sha256').update(unique).digest('hex');
    const reference = firestore.collection('prescriberDirectory').doc(id);
    const existing = await reference.get();
    const now = timestamp();
    const record = {
      id,
      schemaVersion: 1,
      name: input.name,
      initials: input.initials ?? input.name.split(/\s+/).map(part => part[0]).join('').toUpperCase().slice(0, 20),
      pin: input.pin,
      gmcNumber: input.gmcNumber,
      gphcNumber: input.gphcNumber,
      active: true,
      curaleafIds: existing.data()?.curaleafIds ?? {},
      createdAt: existing.data()?.createdAt ?? now,
      createdBy: existing.data()?.createdBy ?? identity(request).uid,
      updatedAt: now,
      updatedBy: identity(request).uid,
    };
    await reference.set(record, { merge: true });
    await audit(request, existing.exists ? 'prescriber_directory.updated' : 'prescriber_directory.created', { organisationId, prescriberId: id });
    response.status(existing.exists ? 200 : 201).json(record);
  } catch (error) { next(error); }
});

app.get('/v1/portal/patients/:patientId/unresolved-orders', async (request, response, next) => {
  try {
    const organisationId = tenantFor(request, request.query.organisationId);
    const patientId = idSchema.parse(request.params.patientId);
    await getTenantRecord('patients', patientId, organisationId);
    const records = await listTenantRecordsByField('orders', organisationId, 'patientId', patientId);
    const unresolved = records
      .map(record => enrichOrderRecord(record as Record<string, unknown>))
      .filter(record => record.redoEligible)
      .sort((left, right) => String(right.createdAt ?? '').localeCompare(String(left.createdAt ?? '')));
    response.json(unresolved);
  } catch (error) { next(error); }
});

app.post('/v1/portal/orders', async (request, response, next) => {
  try {
    const organisationId = tenantFor(request, request.body.organisationId);
    const input = orderSchema.parse(request.body);
    await requireSetupComplete(organisationId);
    const organisation = await getRecord('organisations', organisationId);
    const paymentRoute = resolveOrderPaymentRoute(input.paymentRoute, organisation.defaultPaymentRoute);
    if (paymentRoute === 'worldpay') {
      const connection = await firestore.collection('integrationConnections').doc(`${organisationId}--worldpay`).get();
      if (!connection.exists || connection.data()?.status !== 'connected') {
        throw new HttpError(409, 'This pharmacy’s Worldpay route is not ready. Update payment settings before creating the order.', 'WORLDPAY_VERIFICATION_REQUIRED');
      }
    }
    const patient = await getTenantRecord('patients', input.patientId, organisationId);
    if (!canPatientCreateOrder(patient.status)) {
      throw new HttpError(409, 'HHH onboarding must be completed before this patient can be added to an order.', 'PATIENT_NOT_ORDER_ELIGIBLE');
    }
    if (input.draftId) {
      const draft = await getTenantRecord('orderDrafts', input.draftId, organisationId);
      if (draft.status !== 'draft' || draft.paymentStatus !== 'none') throw new HttpError(409, 'The source draft is already locked.', 'DRAFT_LOCKED');
    }
    let authoritativeRedoContext: {
      originalOrderId: string;
      isPaidRedo: boolean;
      originalTotalPence: number;
      priceDifferencePence: number;
      requireCuraleafAuth: true;
      unresolvedReason: 'expired' | 'rejected';
      recommendation: 'cancel_and_redo' | 'awaiting_delivery_redo' | 'ready_to_collect_redo';
      sourceWasExpired: boolean;
      rootOrderId: string;
      replacementSequence: number;
      priceResolution?: 'absorb' | 'continue_as_fee';
    } | null = null;
    if (input.redoContext) {
      const originalOrderId = String(input.redoContext.originalOrderId);
      const originalOrder = await getTenantRecord('orders', originalOrderId, organisationId);
      if (originalOrder.patientId !== input.patientId) {
        throw new HttpError(409, 'Redo orders must keep the same patient as the unresolved source order.', 'REDO_PATIENT_MISMATCH');
      }
      if (originalOrder.redoneByOrderId) {
        throw new HttpError(409, 'That order has already been redone.', 'REDO_ALREADY_COMPLETED');
      }
      const originalHasCuraleafOrder = Boolean(
        originalOrder.curaleaf?.purchaseOrderId
        || originalOrder.curaleafPurchaseOrderId
        || originalOrder.curaleaf?.customerReference
        || originalOrder.curaleafCustomerReference,
      );
      if (originalHasCuraleafOrder && originalOrder.curaleafCancellation?.status !== 'confirmed') {
        throw new HttpError(409, 'Curaleaf must confirm cancellation before a replacement order can be created.', 'CURALEAF_CANCELLATION_REQUIRED');
      }
      const evaluation = evaluateOrderCycle(originalOrder as Record<string, unknown>);
      if (!evaluation.unresolvedReason || !evaluation.redoEligible) {
        throw new HttpError(409, 'Only archived 28-day or Curaleaf-rejected orders can be redone.', 'REDO_NOT_ELIGIBLE');
      }
      if (input.redoContext.priceResolution === 'refund_and_recharge') {
        throw new HttpError(409, 'Cancel the source order and use paid-order resolution instead of creating a new payment link.', 'REDO_REFUND_RECHARGE_REMOVED');
      }
      if (input.redoContext.isPaidRedo && !evaluation.isPaid) {
        throw new HttpError(409, 'Payment carry-over is only allowed when the original order was paid.', 'REDO_PAYMENT_CARRYOVER_INVALID');
      }
      authoritativeRedoContext = {
        originalOrderId,
        rootOrderId: String((originalOrder.redoContext as Record<string, unknown> | undefined)?.rootOrderId ?? originalOrder.redoOfOrderId ?? originalOrderId),
        replacementSequence: Number((originalOrder.redoContext as Record<string, unknown> | undefined)?.replacementSequence ?? (originalOrder.redoOfOrderId ? 1 : 0)) + 1,
        isPaidRedo: evaluation.isPaid,
        priceResolution: input.redoContext.priceResolution === 'absorb' || input.redoContext.priceResolution === 'continue_as_fee'
          ? input.redoContext.priceResolution
          : undefined,
        originalTotalPence: Number(originalOrder.totalPence ?? input.redoContext.originalTotalPence ?? 0),
        priceDifferencePence: input.redoContext.priceDifferencePence ?? 0,
        requireCuraleafAuth: true,
        unresolvedReason: evaluation.unresolvedReason,
        recommendation: evaluation.recommendation,
        sourceWasExpired: Boolean(originalOrder.isExpired) || evaluation.unresolvedReason === 'expired',
      };
    }
    const prescriptions = await Promise.all(input.prescriptions.map(async prescription => {
      if (!prescription.clinicScanId) {
        const file = await getTenantRecord('prescriptionFiles', prescription.fileId, organisationId);
        if (file.status !== 'uploaded') throw new HttpError(409, 'Attach an active prescription copy before creating the order.', 'PRESCRIPTION_FILE_UNAVAILABLE');
        requireMatchingPatient(prescription.patient, patient);
        return prescription;
      }
      const scan = await getTenantRecord('curaleafPrescriptionScans', prescription.clinicScanId, organisationId);
      if (scan.status !== 'ready' || !scan.result || typeof scan.result !== 'object') {
        throw new HttpError(409, 'Curaleaf has not finished reading this prescription. Wait and scan it again before taking payment.', 'CURALEAF_SCAN_NOT_READY');
      }
      const result = scan.result as StoredClinicScanResult;
      const matchedItems = z.array(z.object({
        packId: idSchema,
        formulaId: idSchema,
        quantity: z.number().int().positive().max(100),
        unitsNeededCount: z.number().int().positive().max(100),
      })).parse(result.matchedItems);
      if (!result.prescription.patient) {
        throw new HttpError(409, 'Curaleaf did not return the prescription patient’s name and date of birth. Contact your HHH administrator before taking payment.', 'PRESCRIPTION_PATIENT_UNAVAILABLE');
      }
      requireMatchingPatient(result.prescription.patient, patient);
      return orderPrescriptionSchema.parse({
        fileId: scan.fileId,
        clinicScanId: prescription.clinicScanId,
        curaleafPrescriptionId: result.prescription.id,
        serialNumber: result.prescription.serialNumber,
        issueDate: result.prescription.issueDate,
        expiryDate: result.prescription.expiryDate,
        patient: result.prescription.patient,
        prescriber: result.prescriber,
        items: matchedItems,
      });
    }));
    const normalisedPrescriptions = prescriptions.map((prescription, index) => ({
      ...prescription,
      id: prescription.id ?? prescription.fileId ?? deterministicSubOrderId('new', prescription.serialNumber, index),
      expiryDate: calculatePrescriptionExpiry(prescription.issueDate, prescription.expiryDate),
      payable: true,
    }));
    const prescribedItems = normalisedPrescriptions.flatMap(prescription => prescription.items);
    if (prescribedItems.length && !samePackQuantities(packQuantities(input.lineItems), packQuantities(prescribedItems))) {
      throw new HttpError(400, 'The order lines must exactly match the products and quantities assigned to its prescriptions.', 'ORDER_ITEM_MISMATCH');
    }
    const [catalogue, rawQuote] = await Promise.all([
      tenantCuraleafCatalogue(organisationId),
      curaleafRequest<unknown>(organisationId, '/v1/quotes/', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ items: input.lineItems }),
      }),
    ]);
    const productPage = {
      records: catalogue.products as Array<{ id: string; formulaId: string; formulaName: string; patientPackPrice: string; state: string }>,
      totalRecordCount: catalogue.productTotal,
    };
    const quote = parsedCuraleafQuote(rawQuote);
    if (!samePackQuantities(packQuantities(input.lineItems), packQuantities(quote.items))) {
      throw new HttpError(409, 'Curaleaf’s quote does not match the requested products and quantities. Refresh the catalogue and try again.', 'SUPPLIER_QUOTE_MISMATCH');
    }
    const quoteByPack = new Map<string, typeof quote.items[number]>();
    quote.items.forEach(item => {
      const prior = quoteByPack.get(item.packId);
      if (prior && (
        prior.patientPackPrice !== item.patientPackPrice
        || prior.wholesalePackPrice !== item.wholesalePackPrice
        || prior.inStock !== item.inStock
      )) {
        throw new HttpError(502, 'Curaleaf returned conflicting prices for the same pack.', 'INVALID_SUPPLIER_QUOTE');
      }
      quoteByPack.set(item.packId, item);
    });
    const unavailablePack = quote.items.find(item => item.stockStatus === 'out_of_stock');
    if (unavailablePack) {
      throw new HttpError(409, 'One or more selected Curaleaf packs are currently unavailable. Review the prescription before taking payment.', 'PRODUCT_OUT_OF_STOCK');
    }
    const shippingPence = curaleafMoneyPence(quote.shippingPrice, 'shipping price');
    const taxRate = Number(quote.taxRate);
    if (!Number.isFinite(taxRate) || taxRate < 0 || taxRate > 100) {
      throw new HttpError(502, 'Curaleaf returned an invalid tax rate.', 'INVALID_SUPPLIER_QUOTE');
    }
    const products = new Map(productPage.records.map(product => [product.id, product]));
    const lineItems = input.lineItems.map(item => {
      const product = products.get(item.packId);
      const quoted = quoteByPack.get(item.packId);
      if (!product) throw new HttpError(409, 'A selected Curaleaf product is no longer available. Refresh the catalogue and review the order.', 'PRODUCT_NOT_AVAILABLE');
      if (!quoted) throw new HttpError(409, 'Curaleaf did not quote one of the selected products. Refresh the catalogue and review the order.', 'SUPPLIER_QUOTE_MISMATCH');
      if (product.state !== 'ACTIVE') throw new HttpError(409, `${product.formulaName} is no longer an active Curaleaf product.`, 'PRODUCT_NOT_AVAILABLE');
      if (prescribedItems.some(prescribed => prescribed.packId === item.packId && prescribed.formulaId !== product.formulaId)) {
        throw new HttpError(409, `${product.formulaName} no longer matches the selected Curaleaf formula. Refresh the catalogue and review the prescription.`, 'FORMULA_MISMATCH');
      }
      return {
        productId: product.id,
        formulaId: product.formulaId,
        packId: product.id,
        name: product.formulaName,
        quantity: item.quantity,
        unitPricePence: curaleafMoneyPence(quoted.patientPackPrice, 'patient pack price'),
      };
    });
    const quotedAt = timestamp();
    const wholesaleProductPence = input.lineItems.reduce((total, item) => {
      const quoted = quoteByPack.get(item.packId)!;
      return total + curaleafMoneyPence(quoted.wholesalePackPrice, 'wholesale pack price') * item.quantity;
    }, 0);
    const productTotalPence = lineItems.reduce((total, item) => total + item.unitPricePence * item.quantity, 0);
    const quotedTotalPence = lineItems.reduce((total, item) => total + item.unitPricePence * item.quantity, input.dispensingFeePence);
    let totalPence = quotedTotalPence;
    let pharmacyContributionPence = 0;
    if (authoritativeRedoContext) {
      authoritativeRedoContext.priceDifferencePence = quotedTotalPence - authoritativeRedoContext.originalTotalPence;
      if (authoritativeRedoContext.isPaidRedo) {
        const settled = settlePaidRedoTotals({
          priceResolution: authoritativeRedoContext.priceResolution,
          quotedTotalPence,
          originalTotalPence: authoritativeRedoContext.originalTotalPence,
        });
        if (!settled.ok) throw new HttpError(409, settled.message, settled.code);
        totalPence = settled.totalPence;
        pharmacyContributionPence = settled.pharmacyContributionPence;
      }
    }
    const lineRevenuePence = normalisedPrescriptions.flatMap(prescription => prescription.items.map(item => {
      const quoted = quoteByPack.get(item.packId)!;
      return curaleafMoneyPence(quoted.patientPackPrice, 'patient pack price') * item.quantity;
    }));
    const feeAllocations = allocateDispensingFee(lineRevenuePence, input.dispensingFeePence);
    let feeIndex = 0;
    const prescriptionFlow = Object.fromEntries(normalisedPrescriptions.map(prescription => [prescription.id, {
      id: prescription.id,
      state: authoritativeRedoContext?.isPaidRedo ? 'PAID' : 'AWAITING_PAYMENT',
      payable: true,
      expiryDate: prescription.expiryDate,
      purchaseOrderId: null,
      shipmentIds: [],
      lines: prescription.items.map(item => ({
        lineId: createHash('sha256').update(`${prescription.id}:${item.packId}`).digest('hex').slice(0, 32),
        productId: item.packId,
        ordered: item.quantity,
        allocated: 0,
        shipped: 0,
        returned: 0,
        received: 0,
        collected: 0,
        backordered: false,
        allocatedDispensingFeePence: feeAllocations[feeIndex++] ?? 0,
      })),
      renewal: { state: 'none' },
      collectedAt: null,
    }]));
    const { paymentRoute: _ignoredRequestedRoute, redoContext: _ignoredClientRedo, draftId, ...authoritativeInput } = input;
    const orderCreatedAt = timestamp();
    const record = {
      ...authoritativeInput,
      prescriptions: normalisedPrescriptions,
      prescriptionFlow,
      lineItems,
      totalPence,
      quotedTotalPence,
      pharmacyContributionPence,
      organisationId,
      paymentRoute,
      paymentRouteSnapshotAt: timestamp(),
      pricingQuote: {
        ...quote,
        quotedAt,
        environment: config.CURALEAF_BASE_URL.includes('.dev') ? 'test' : 'production',
        productTotalPence,
        wholesaleProductPence,
        shippingPence,
      },
      fulfilmentMethod: 'patient_collection',
      autoPlacementEnabled: organisation.autoPlacementEnabled !== false,
      paymentStatus: authoritativeRedoContext?.isPaidRedo ? 'paid' : paymentRoute === 'manual' ? 'awaiting_manual_payment' : 'pending',
      fulfilmentStatus: 'supplier_pending' satisfies FulfilmentStatus,
      status: 'open',
      redoContext: authoritativeRedoContext,
      redoOfOrderId: authoritativeRedoContext?.originalOrderId ?? null,
      id: randomUUID(),
      schemaVersion: 1,
      createdAt: orderCreatedAt,
      updatedAt: orderCreatedAt,
    };
    await firestore.runTransaction(async transaction => {
      const sourceReferralId = typeof patient.sourceReferralId === 'string' ? patient.sourceReferralId : null;
      if (sourceReferralId) {
        const submissionRef = firestore.collection('eligibilitySubmissions').doc(sourceReferralId);
        const overlayRef = firestore.collection('eligibilityAllocationOverlays').doc(sourceReferralId);
        const [submissionSnapshot, overlaySnapshot] = await Promise.all([transaction.get(submissionRef), transaction.get(overlayRef)]);
        if (submissionSnapshot.exists) {
          const submission = submissionSnapshot.data()!;
          const isV2 = submission.schemaVersion === 2 || submission.intakeVersion === 'v2';
          const workflow = isV2 ? submission : (overlaySnapshot.data() ?? submission);
          const effectiveOwner = isV2 ? submission.assignedOrganisationId : (overlaySnapshot.data()?.assignedOrganisationId ?? submission.organisationId);
          if (effectiveOwner !== organisationId) throw new HttpError(404, 'The requested record was not found.', 'NOT_FOUND');
          if (isV2 && (
            workflow.assignmentStatus !== 'confirmed'
            || workflow.pharmacyAccessStatus !== 'activated'
            || workflow.programmeOnboardingDecision !== 'approved'
          )) {
            throw new HttpError(409, 'HHH allocation and onboarding approval are required before creating an order.', 'ASSIGNMENT_NOT_CONFIRMED');
          }
          transaction.set(isV2 ? submissionRef : overlayRef, {
            ...(!isV2 && !overlaySnapshot.exists ? { sourceOrganisationId: submission.organisationId, assignedOrganisationId: organisationId, assignmentStatus: 'confirmed', assignmentVersion: 0 } : {}),
            operationalStartedAt: workflow.operationalStartedAt ?? orderCreatedAt,
            updatedAt: orderCreatedAt,
          }, { merge: true });
        }
      }
      transaction.create(firestore.collection('orders').doc(record.id), record);
    });
    invalidateCollectionCache('orders', record.id);
    if (typeof patient.sourceReferralId === 'string') invalidateCollectionCache('eligibilitySubmissions', patient.sourceReferralId);

    let placementFeeIndex = 0;
    for (const prescription of normalisedPrescriptions) {
      const placementId = createHash('sha256').update(`${record.id}:${prescription.id}:placement`).digest('hex');
      const placementLines = prescription.items.map(item => {
        const quoted = quoteByPack.get(item.packId)!;
        const patientPackPence = curaleafMoneyPence(quoted.patientPackPrice, 'patient pack price');
        const wholesalePackPence = curaleafMoneyPence(quoted.wholesalePackPrice, 'wholesale pack price');
        return {
          id: createHash('sha256').update(`${placementId}:${item.packId}`).digest('hex'),
          prescriptionId: prescription.id,
          orderId: record.id,
          formulaId: item.formulaId,
          formulaName: lineItems.find(line => line.packId === item.packId)?.name ?? item.formulaId,
          unit: '',
          unitsNeededCount: item.unitsNeededCount,
          packId: item.packId,
          quantity: item.quantity,
          fixedPatientPricePence: patientPackPence * item.quantity,
          allocatedDispensingFeePence: feeAllocations[placementFeeIndex++] ?? 0,
          lineMedicineRevenuePence: patientPackPence * item.quantity,
          linkSendWholesalePence: wholesalePackPence * item.quantity,
          latestWholesalePence: wholesalePackPence * item.quantity,
          placementState: authoritativeRedoContext?.isPaidRedo ? 'PENDING_PLACEMENT' : 'PENDING_PLACEMENT',
          holdEpisodeStartedAt: null,
          notifiedAt48h: null,
          boundaryScheduledAt: calculateExpiryBoundaryDate(prescription.expiryDate),
          updatedAt: timestamp(),
        };
      });
      await firestore.collection('prescriptionPlacements').doc(placementId).set({
        id: placementId,
        schemaVersion: 2,
        prescriptionId: prescription.id,
        orderId: record.id,
        pharmacyId: organisationId,
        lines: placementLines,
        overallState: 'PENDING_PLACEMENT',
        purchaseOrderId: null,
        placedAt: null,
        createdAt: timestamp(),
        updatedAt: timestamp(),
      });
    }
    invalidateCollectionCache('prescriptionPlacements');
    if (draftId) {
      await firestore.collection('orderDrafts').doc(draftId).set({ status: 'promoted', orderId: record.id, promotedAt: timestamp(), paymentStatus: paymentRoute === 'manual' ? 'awaiting_manual_payment' : 'pending', paymentRoute, updatedAt: timestamp() }, { merge: true });
      invalidateCollectionCache('orderDrafts', draftId);
    }

    if (authoritativeRedoContext) {
      await updateTenantRecord('orders', authoritativeRedoContext.originalOrderId, organisationId, {
        redoneByOrderId: record.id,
        unresolvedClosedAt: timestamp(),
        status: authoritativeRedoContext.unresolvedReason === 'expired' ? 'archived' : 'rejected',
        isExpired: authoritativeRedoContext.sourceWasExpired,
      });
    }

    await audit(request, 'order.created', {
      organisationId,
      recordId: record.id,
      pricingSource: 'curaleaf_quote',
      quotedAt,
      productTotalPence,
      wholesaleProductPence,
      shippingPence,
      paymentRoute,
      redoOfOrderId: authoritativeRedoContext?.originalOrderId ?? null,
      isPaidRedo: authoritativeRedoContext?.isPaidRedo ?? false,
    });
    if (authoritativeRedoContext?.isPaidRedo) {
      try {
        await autoSubmitPaidPrescriptions(organisationId, String(record.id));
      } catch (error) {
        console.error('Automatic Curaleaf placement for paid replacement failed', { organisationId, orderId: record.id, error: error instanceof Error ? error.message : 'Unknown error' });
      }
    } else {
      try {
        await prepareManualPrescriptionsForOrder(organisationId, String(record.id));
      } catch (error) {
        console.error('Manual prescription pre-registration failed', { organisationId, orderId: record.id, error: error instanceof Error ? error.message : 'Unknown error' });
      }
    }
    response.status(201).json(enrichOrderRecord(record as Record<string, unknown>));
  } catch (error) { next(error); }
});

app.get('/v1/portal/orders/:id/evaluate-28day-expiry', async (request, response, next) => {
  try {
    const organisationId = tenantFor(request, request.query.organisationId as string);
    const orderId = idSchema.parse(request.params.id);
    const order = await getTenantRecord('orders', orderId, organisationId);
    const evaluation = evaluateOrderCycle(order as Record<string, unknown>);
    response.json({
      orderId,
      ...evaluation,
      evaluatedAt: nowIso(),
    });
  } catch (error) { next(error); }
});

app.post('/v1/portal/orders/:id/cancel-and-archive', async (request, response, next) => {
  try {
    const organisationId = tenantFor(request, request.body.organisationId);
    const orderId = idSchema.parse(request.params.id);
    const orderData = await getTenantRecord('orders', orderId, organisationId);
    const evaluation = evaluateOrderCycle(orderData as Record<string, unknown>);

    if (orderData.redoneByOrderId) {
      throw new HttpError(409, 'That order has already been redone.', 'REDO_ALREADY_COMPLETED');
    }
    if (evaluation.isPaid && evaluation.recommendation !== 'cancel_and_redo') {
      throw new HttpError(
        409,
        evaluation.recommendation === 'awaiting_delivery_redo'
          ? 'This paid order is already in transit. Use the awaiting-delivery redo path instead of cancelling the purchase order.'
          : 'This paid order has arrived at the pharmacy. Authenticate the new prescription and mark ready to collect instead of cancelling.',
        'REDO_CANCEL_NOT_ALLOWED',
      );
    }

    const purchaseOrderId = orderData.curaleaf?.purchaseOrderId ?? orderData.curaleafPurchaseOrderId ?? null;
    let purchaseOrderCancelSupportCaseId: string | null = null;
    // Curaleaf (Phil, 5 Aug 2026): PO cancel is CS-only — no DELETE API. Open a support case when a CREATED PO exists.
    if (purchaseOrderId && String(orderData.curaleaf?.purchaseOrderState ?? orderData.curaleafPoState ?? '') === 'CREATED') {
      const supportCaseId = createHash('sha256').update(`${organisationId}:${orderId}:purchase_order_cancellation:${purchaseOrderId}`).digest('hex');
      const supportCase = firestore.collection('curaleafSupportCases').doc(supportCaseId);
      if (!(await supportCase.get()).exists) {
        await supportCase.create({
          id: supportCaseId,
          organisationId,
          orderId,
          reason: 'purchase_order_cancellation',
          status: 'open',
          note: '28-day cycle archive: request Curaleaf customer service to cancel the CREATED purchase order. No programmatic cancel API is available.',
          prescriptionId: orderData.curaleaf?.prescriptionId ?? null,
          purchaseOrderId,
          openedBy: identity(request).uid,
          openedByRole: identity(request).role,
          openedAt: timestamp(),
          createdAt: timestamp(),
          updatedAt: timestamp(),
        });
        invalidateCollectionCache('curaleafSupportCases');
      }
      purchaseOrderCancelSupportCaseId = supportCaseId;
    }

    const updated = await updateTenantRecord('orders', orderId, organisationId, {
      isExpired: true,
      status: 'archived',
      archivedAt: nowIso(),
      archivedReason: '28-day prescription cycle expired',
      fulfilmentStatus: evaluation.isPaid ? orderData.fulfilmentStatus : 'exception',
      purchaseOrderCancelSupportCaseId,
      ...(purchaseOrderCancelSupportCaseId ? {
        cancellation: {
          status: 'curaleaf_contact_required',
          reason: 'other',
          note: 'Prescription cycle expired; Curaleaf cancellation must be confirmed before refund or replacement.',
          requestedAt: nowIso(),
          requestedBy: identity(request).uid,
          paymentLinkStatus: 'not_applicable',
          paymentReference: orderData.worldpayPaymentId ?? orderData.paymentTransactionReference ?? orderData.paymentId ?? null,
        },
        curaleafCancellation: {
          status: 'contact_required',
          purchaseOrderId,
          prescriptionId: orderData.curaleaf?.prescriptionId ?? null,
          supportCaseId: purchaseOrderCancelSupportCaseId,
          requestedAt: nowIso(),
          requestedBy: identity(request).uid,
        },
      } : {}),
      updatedAt: nowIso(),
    });

    await audit(request, 'order.archived_28day_cycle', {
      organisationId,
      orderId,
      recommendation: evaluation.recommendation,
      isPaid: evaluation.isPaid,
      purchaseOrderCancelSupportCaseId,
      curaleafPoDeleteSkipped: true,
    });
    response.json(enrichOrderRecord((updated ?? { ...orderData, id: orderId, isExpired: true, status: 'archived' }) as Record<string, unknown>));
  } catch (error) { next(error); }
});

/* ========================================================================== */
/* Post-Payment Placement Engine & Refund Routes                              */
/* ========================================================================== */

function curaleafOrderReference(order: Record<string, any>) {
  return {
    purchaseOrderId: order.curaleaf?.purchaseOrderId ?? order.curaleafPurchaseOrderId ?? null,
    prescriptionId: order.curaleaf?.prescriptionId ?? order.curaleafPrescriptionId ?? null,
    customerReference: order.curaleaf?.customerReference ?? order.curaleafCustomerReference ?? null,
  };
}

async function openPaidCancellationNotification(organisationId: string, orderId: string, paymentReference: string | null) {
  const notificationId = createHash('sha256').update(`${organisationId}:${orderId}:paid_order_cancellation`).digest('hex');
  await firestore.collection('pharmacyNotifications').doc(notificationId).set({
    id: notificationId,
    organisationId,
    orderId,
    type: 'paid_order_cancellation',
    status: 'open',
    title: 'Paid order cancellation requires action',
    detail: 'Confirm Curaleaf cancellation where applicable, then refund the patient and record the reference.',
    paymentReference,
    createdAt: timestamp(),
    updatedAt: timestamp(),
  }, { merge: true });
}

app.post('/v1/portal/orders/:id/cancellations', async (request, response, next) => {
  try {
    const input = z.object({
      organisationId: idSchema.optional(),
      reason: z.enum(['added_in_error', 'patient_request', 'other']),
      note: z.string().trim().max(1000).optional(),
    }).parse(request.body);
    const organisationId = tenantFor(request, input.organisationId);
    const orderId = idSchema.parse(request.params.id);
    const order = await getTenantRecord('orders', orderId, organisationId);
    if (order.status === 'cancelled' && order.cancellation) return response.status(200).json(enrichOrderRecord(order as Record<string, unknown>));
    if (order.fulfilmentStatus === 'collected') throw new HttpError(409, 'A collected order cannot be cancelled.', 'ORDER_ALREADY_COLLECTED');
    if (!orderAllowsManualCancellation(order)) {
      if (orderMoneyWasTaken(order)) {
        throw new HttpError(409, 'A paid order cannot use pharmacy cancellation. Use its resolution workflow instead.', 'PAID_ORDER_REQUIRES_RESOLUTION');
      }
      throw new HttpError(409, 'This order is not available for pharmacy cancellation.', 'ORDER_CANCELLATION_NOT_AVAILABLE');
    }

    const references = curaleafOrderReference(order);
    const hasCuraleafOrder = Boolean(references.purchaseOrderId || references.prescriptionId || references.customerReference);
    const paid = ['paid', 'refund_required'].includes(String(order.paymentStatus));
    const paymentReference = order.worldpayPaymentId ?? order.paymentTransactionReference ?? order.paymentId ?? null;
    const requestedAt = nowIso();
    let supportCaseId: string | null = null;

    if (hasCuraleafOrder) {
      supportCaseId = createHash('sha256').update(`${organisationId}:${orderId}:purchase_order_cancellation:${references.purchaseOrderId ?? references.customerReference}`).digest('hex');
      await firestore.collection('curaleafSupportCases').doc(supportCaseId).set({
        id: supportCaseId,
        organisationId,
        orderId,
        reason: 'purchase_order_cancellation',
        status: 'open',
        note: input.note || 'Pharmacy cancellation requested. Contact Curaleaf Customer Service and obtain confirmation before refunding or reordering.',
        prescriptionId: references.prescriptionId,
        purchaseOrderId: references.purchaseOrderId,
        openedBy: identity(request).uid,
        openedByRole: identity(request).role,
        openedAt: requestedAt,
        createdAt: requestedAt,
        updatedAt: requestedAt,
      }, { merge: true });
      invalidateCollectionCache('curaleafSupportCases');
    }

    const cancellation = {
      status: hasCuraleafOrder ? 'curaleaf_contact_required' : paid ? 'refund_required' : 'cancelled',
      reason: input.reason,
      note: input.note ?? null,
      requestedAt,
      requestedBy: identity(request).uid,
      paymentLinkStatus: order.paymentStatus === 'pending' && order.paymentRoute === 'worldpay' ? 'cancelled_in_platform' : 'not_applicable',
      paymentReference,
    };
    const curaleafCancellation = hasCuraleafOrder ? {
      status: 'contact_required',
      purchaseOrderId: references.purchaseOrderId,
      prescriptionId: references.prescriptionId,
      supportCaseId,
      requestedAt,
      requestedBy: identity(request).uid,
    } : null;

    const batch = firestore.batch();
    const orderRef = firestore.collection('orders').doc(orderId);
    batch.update(orderRef, {
      cancellation,
      ...(curaleafCancellation ? { curaleafCancellation } : {}),
      ...(!hasCuraleafOrder ? { status: 'cancelled', cancelledAt: requestedAt, paymentStatus: paid ? 'refund_required' : 'cancelled' } : {}),
      updatedAt: requestedAt,
    });
    if (!hasCuraleafOrder && !paid && typeof order.paymentId === 'string') {
      const paymentRef = firestore.collection('payments').doc(order.paymentId);
      batch.set(paymentRef, { status: 'cancelled', cancelledAt: requestedAt, cancellationReason: input.reason, linkExpiresAt: requestedAt, updatedAt: requestedAt }, { merge: true });
    }
    await batch.commit();
    if (paid) await openPaidCancellationNotification(organisationId, orderId, paymentReference);
    invalidateCollectionCache('orders', orderId);
    if (typeof order.paymentId === 'string') invalidateCollectionCache('payments', order.paymentId);
    await audit(request, 'order.cancellation_requested', { organisationId, orderId, reason: input.reason, paid, hasCuraleafOrder, supportCaseId });
    const updated = await getTenantRecord('orders', orderId, organisationId);
    response.status(201).json(enrichOrderRecord(updated as Record<string, unknown>));
  } catch (error) { next(error); }
});

app.post('/v1/portal/orders/:id/curaleaf-cancellation', async (request, response, next) => {
  try {
    const input = z.object({
      organisationId: idSchema.optional(),
      action: z.enum(['contacted', 'confirmed']),
      reference: z.string().trim().min(3).max(200),
      note: z.string().trim().max(1000).optional(),
    }).parse(request.body);
    const organisationId = tenantFor(request, input.organisationId);
    const orderId = idSchema.parse(request.params.id);
    const order = await getTenantRecord('orders', orderId, organisationId);
    const current = order.curaleafCancellation && typeof order.curaleafCancellation === 'object' ? order.curaleafCancellation as Record<string, unknown> : null;
    if (!current) throw new HttpError(409, 'Request the order cancellation before recording Curaleaf contact.', 'ORDER_CANCELLATION_REQUIRED');
    if (input.action === 'confirmed' && current.status !== 'awaiting_confirmation') {
      throw new HttpError(409, 'Record that Curaleaf was contacted before confirming cancellation.', 'CURALEAF_CONTACT_REQUIRED');
    }
    const updatedAt = nowIso();
    const paid = ['paid', 'refund_required'].includes(String(order.paymentStatus));
    const curaleafCancellation = input.action === 'contacted' ? {
      ...current,
      status: 'awaiting_confirmation',
      contactReference: input.reference,
      contactNote: input.note ?? null,
      contactedAt: updatedAt,
      contactedBy: identity(request).uid,
    } : {
      ...current,
      status: 'confirmed',
      confirmationReference: input.reference,
      confirmedAt: updatedAt,
      confirmedBy: identity(request).uid,
    };
    const cancellation = {
      ...(order.cancellation as Record<string, unknown>),
      status: input.action === 'contacted' ? 'awaiting_curaleaf_confirmation' : paid ? 'refund_required' : 'cancelled',
    };
    await firestore.collection('orders').doc(orderId).update({
      curaleafCancellation,
      cancellation,
      ...(input.action === 'confirmed' ? { status: 'cancelled', cancelledAt: updatedAt, paymentStatus: paid ? 'refund_required' : 'cancelled' } : {}),
      updatedAt,
    });
    if (typeof current.supportCaseId === 'string') {
      await firestore.collection('curaleafSupportCases').doc(current.supportCaseId).set({
        status: input.action === 'contacted' ? 'awaiting_supplier' : 'resolved',
        contactReference: input.action === 'contacted' ? input.reference : current.contactReference ?? null,
        confirmationReference: input.action === 'confirmed' ? input.reference : null,
        updatedAt,
        ...(input.action === 'confirmed' ? { resolvedAt: updatedAt, resolvedBy: identity(request).uid } : {}),
      }, { merge: true });
      invalidateCollectionCache('curaleafSupportCases');
    }
    invalidateCollectionCache('orders', orderId);
    await audit(request, input.action === 'contacted' ? 'order.curaleaf_cancellation_contacted' : 'order.curaleaf_cancellation_confirmed', { organisationId, orderId, reference: input.reference });
    const updated = await getTenantRecord('orders', orderId, organisationId);
    response.json(enrichOrderRecord(updated as Record<string, unknown>));
  } catch (error) { next(error); }
});

app.post('/v1/portal/orders/:id/refunds/manual', async (request, response, next) => {
  try {
    const input = z.object({
      organisationId: idSchema.optional(),
      reason: z.enum(['patient_cancelled', 'replacement_price_changed']),
      resolution: z.enum(['cancel', 'replace_new_payment']),
    }).parse(request.body);
    const organisationId = tenantFor(request, input.organisationId);
    const orderId = idSchema.parse(request.params.id);
    const order = await getTenantRecord('orders', orderId, organisationId);
    const references = curaleafOrderReference(order);
    if ((references.purchaseOrderId || references.prescriptionId || references.customerReference) && order.curaleafCancellation?.status !== 'confirmed') {
      throw new HttpError(409, 'Curaleaf must confirm cancellation before the patient refund can be prepared.', 'CURALEAF_CANCELLATION_REQUIRED');
    }
    if (!['paid', 'refund_required'].includes(String(order.paymentStatus))) throw new HttpError(409, 'Only a paid order can be refunded.', 'PAYMENT_REQUIRED');
    if (order.refund && typeof order.refund === 'object') return response.status(200).json(order.refund);

    const paymentId = typeof order.paymentId === 'string' ? order.paymentId : '';
    const paymentSnapshot = paymentId ? await firestore.collection('payments').doc(paymentId).get() : null;
    const payment = paymentSnapshot?.data();
    if (payment && payment.organisationId !== organisationId) throw new HttpError(409, 'The payment does not belong to this pharmacy.', 'PAYMENT_TENANT_MISMATCH');
    const paymentRoute = payment?.route === 'worldpay' || order.paymentRoute === 'worldpay' ? 'worldpay' : 'manual';
    const providerPaymentId = typeof payment?.providerPaymentId === 'string' ? payment.providerPaymentId : typeof order.worldpayPaymentId === 'string' ? order.worldpayPaymentId : null;
    const transactionReference = typeof payment?.transactionReference === 'string' ? payment.transactionReference : typeof order.paymentTransactionReference === 'string' ? order.paymentTransactionReference : null;
    const paymentReference = providerPaymentId ?? transactionReference ?? paymentId;
    if (!paymentReference) throw new HttpError(409, 'The original payment reference is unavailable.', 'PAYMENT_REFERENCE_REQUIRED');

    const refund = await refundAdapter.createRefundRecord({
      orderId,
      lineId: 'order',
      pharmacyId: organisationId,
      amountPence: Number(order.totalPence ?? 0),
      originalPaymentRef: paymentReference,
      paymentRoute,
      cause: input.reason,
      idempotencyKey: `refund--${orderId}--order`,
    });
    const refundState = {
      id: refund.id,
      status: refund.status,
      amountPence: refund.amountPence,
      method: paymentRoute === 'worldpay' ? 'worldpay_portal' : 'pharmacy_manual',
      paymentReference,
      transactionReference,
      reason: input.reason,
      resolution: input.resolution,
      requestedAt: refund.createdAt,
      requestedBy: identity(request).uid,
    };
    await firestore.collection('orders').doc(orderId).update({ refund: refundState, paymentStatus: 'refund_required', updatedAt: timestamp() });
    invalidateCollectionCache('orders', orderId);
    await audit(request, 'order.refund_requested', { organisationId, orderId, refundId: refund.id, paymentReference, amountPence: refund.amountPence, resolution: input.resolution });
    response.status(201).json(refundState);
  } catch (error) { next(error); }
});

app.post('/v1/portal/orders/:id/refunds/:refundId/confirm', async (request, response, next) => {
  try {
    const input = z.object({ organisationId: idSchema.optional(), externalReference: z.string().trim().min(3).max(160) }).parse(request.body);
    const organisationId = tenantFor(request, input.organisationId);
    const orderId = idSchema.parse(request.params.id);
    const refundId = idSchema.parse(request.params.refundId);
    const order = await getTenantRecord('orders', orderId, organisationId);
    const references = curaleafOrderReference(order);
    if ((references.purchaseOrderId || references.prescriptionId || references.customerReference) && order.curaleafCancellation?.status !== 'confirmed') {
      throw new HttpError(409, 'Curaleaf must confirm cancellation before the patient refund can be completed.', 'CURALEAF_CANCELLATION_REQUIRED');
    }
    const refundState = order.refund && typeof order.refund === 'object' ? order.refund as Record<string, unknown> : null;
    if (!refundState || refundState.id !== refundId) throw new HttpError(404, 'Refund task not found for this order.', 'NOT_FOUND');
    const refundSnapshot = await firestore.collection('refundRecords').doc(refundId).get();
    if (!refundSnapshot.exists || refundSnapshot.data()?.pharmacyId !== organisationId || refundSnapshot.data()?.orderId !== orderId) throw new HttpError(404, 'Refund record not found.', 'NOT_FOUND');
    const confirmed = await refundAdapter.confirmRefund(refundId, identity(request).uid, input.externalReference);
    const nextRefund = { ...refundState, status: 'completed', externalReference: input.externalReference, confirmedAt: confirmed.confirmedAt, confirmedBy: confirmed.confirmedBy };
    await firestore.collection('orders').doc(orderId).update({ refund: nextRefund, paymentStatus: 'refunded', updatedAt: timestamp() });
    invalidateCollectionCache('orders', orderId);
    await audit(request, 'order.refund_confirmed', { organisationId, orderId, refundId, externalReference: input.externalReference });
    response.json(nextRefund);
  } catch (error) { next(error); }
});


app.post('/v1/portal/orders/:id/prescriptions/:prescriptionId/place', externalProviderLimit, async (request, response, next) => {
  try {
    const input = z.object({ organisationId: idSchema.optional() }).parse(request.body);
    const organisationId = tenantFor(request, input.organisationId);
    const orderId = idSchema.parse(request.params.id);
    const prescriptionId = idSchema.parse(request.params.prescriptionId);
    const order = await getTenantRecord('orders', orderId, organisationId);
    if (order.paymentStatus !== 'paid') throw new HttpError(409, 'Only paid prescriptions can be placed.', 'PAYMENT_REQUIRED');
    const operations = await firestore.collection('integrationOperations').where('orderId', '==', orderId).get();
    const operation = operations.docs.find(document => document.data().organisationId === organisationId && document.data().subOrderId === prescriptionId);
    if (!operation) throw new HttpError(404, 'Prescription placement operation not found.', 'NOT_FOUND');
    if (operation.data().autoPlacement !== false) throw new HttpError(409, 'Automatic placement is enabled for this prescription.', 'AUTO_PLACEMENT_ENABLED');
    await operation.ref.set({ manualPlacementRequested: true, manualPlacementRequestedAt: timestamp(), manualPlacementRequestedBy: identity(request).uid, updatedAt: timestamp() }, { merge: true });
    const result = await autoSubmitPaidPrescriptions(organisationId, orderId);
    await audit(request, 'prescription.manual_place_requested', { organisationId, orderId, prescriptionId, operationId: operation.id });
    response.json({ orderId, prescriptionId, operationId: operation.id, result });
  } catch (error) { next(error); }
});

app.post('/v1/portal/orders/:id/placement/absorb', async (request, response, next) => {
  try {
    const pharmacyId = tenantFor(request, request.body.pharmacyId);
    const orderId = idSchema.parse(request.params.id);
    const { lineId } = z.object({ lineId: idSchema }).parse(request.body);

    const placementSnap = await firestore
      .collection('prescriptionPlacements')
      .where('orderId', '==', orderId)
      .get();

    if (placementSnap.empty) {
      throw new HttpError(404, 'Placement record not found for this order.', 'NOT_FOUND');
    }

    let targetPlacementDoc: DocumentReference | null = null;
    let targetPlacement: PrescriptionPlacement | null = null;

    for (const doc of placementSnap.docs) {
      const p = doc.data() as PrescriptionPlacement;
      if (p.lines.some(l => l.id === lineId)) {
        targetPlacementDoc = doc.ref;
        targetPlacement = p;
        break;
      }
    }

    if (!targetPlacementDoc || !targetPlacement) {
      throw new HttpError(404, 'Line placement not found.', 'NOT_FOUND');
    }

    const updatedLines = targetPlacement.lines.map(line => {
      if (line.id === lineId) {
        return {
          ...line,
          placementState: 'PENDING_PLACEMENT' as const,
          updatedAt: nowIso(),
        };
      }
      return line;
    });

    const allReleased = updatedLines.every(l => l.placementState !== 'HELD_PRICE');
    const newOverallState = allReleased ? ('PENDING_PLACEMENT' as const) : targetPlacement.overallState;

    await targetPlacementDoc.update({
      lines: updatedLines,
      overallState: newOverallState,
      updatedAt: nowIso(),
    });

    await recordPlacementLedgerEvent({
      pharmacyId,
      orderId,
      prescriptionId: targetPlacement.prescriptionId,
      lineId,
      eventType: 'absorbed_placed',
      actor: identity(request).uid,
      details: { lineId, action: 'absorb_and_place' },
    });

    if (allReleased) {
      await firestore.collection('orders').doc(orderId).update({ [`prescriptionFlow.${targetPlacement.prescriptionId}.state`]: 'PENDING_PLACEMENT', [`prescriptionFlow.${targetPlacement.prescriptionId}.updatedAt`]: timestamp(), updatedAt: timestamp() });
      const operations = await firestore.collection('integrationOperations').where('orderId', '==', orderId).get();
      for (const operation of operations.docs.filter(document => document.data().subOrderId === targetPlacement!.prescriptionId)) await operation.ref.set({ status: 'reconciliation_required', updatedAt: timestamp() }, { merge: true });
      await autoSubmitPaidPrescriptions(pharmacyId, orderId);
    }

    invalidateCollectionCache('prescriptionPlacements');
    response.json({ success: true, lineId, placementState: 'PENDING_PLACEMENT', overallState: newOverallState });
  } catch (error) { next(error); }
});

app.post('/v1/portal/orders/:id/placement/substitute', async (request, response, next) => {
  try {
    const pharmacyId = tenantFor(request, request.body.pharmacyId);
    const orderId = idSchema.parse(request.params.id);
    const { lineId, substitutePackId } = z.object({ lineId: idSchema, substitutePackId: idSchema }).parse(request.body);

    const placementSnap = await firestore
      .collection('prescriptionPlacements')
      .where('orderId', '==', orderId)
      .get();

    let targetDoc: DocumentReference | null = null;
    let targetPlacement: PrescriptionPlacement | null = null;

    for (const doc of placementSnap.docs) {
      const p = doc.data() as PrescriptionPlacement;
      if (p.lines.some(l => l.id === lineId)) {
        targetDoc = doc.ref;
        targetPlacement = p;
        break;
      }
    }

    if (!targetDoc || !targetPlacement) {
      throw new HttpError(404, 'Line placement not found.', 'NOT_FOUND');
    }

    const updatedLines = targetPlacement.lines.map(line => {
      if (line.id === lineId) {
        return {
          ...line,
          packId: substitutePackId,
          placementState: 'PLACED' as const,
          updatedAt: nowIso(),
        };
      }
      return line;
    });

    const allPlaced = updatedLines.every(l => l.placementState === 'PLACED');
    await targetDoc.update({
      lines: updatedLines,
      overallState: allPlaced ? 'PLACED' : targetPlacement.overallState,
      updatedAt: nowIso(),
    });

    await recordPlacementLedgerEvent({
      pharmacyId,
      orderId,
      prescriptionId: targetPlacement.prescriptionId,
      lineId,
      eventType: 'substituted',
      actor: identity(request).uid,
      details: { lineId, substitutePackId },
    });

    invalidateCollectionCache('prescriptionPlacements');
    response.json({ success: true, lineId, substitutePackId, placementState: 'PLACED' });
  } catch (error) { next(error); }
});

app.post('/v1/portal/orders/:id/placement/cancel-line', async (request, response, next) => {
  try {
    const pharmacyId = tenantFor(request, request.body.pharmacyId);
    const orderId = idSchema.parse(request.params.id);
    const { lineId, reason } = z.object({ lineId: idSchema, reason: z.string().trim().min(1).max(500) }).parse(request.body);

    const placementSnap = await firestore
      .collection('prescriptionPlacements')
      .where('orderId', '==', orderId)
      .get();

    let targetDoc: DocumentReference | null = null;
    let targetPlacement: PrescriptionPlacement | null = null;

    for (const doc of placementSnap.docs) {
      const p = doc.data() as PrescriptionPlacement;
      if (p.lines.some(l => l.id === lineId)) {
        targetDoc = doc.ref;
        targetPlacement = p;
        break;
      }
    }

    if (!targetDoc || !targetPlacement) {
      throw new HttpError(404, 'Line placement not found.', 'NOT_FOUND');
    }

    const line = targetPlacement.lines.find(l => l.id === lineId)!;
    const refundAmountPence = line.fixedPatientPricePence + line.allocatedDispensingFeePence;
    const order = await getTenantRecord('orders', orderId, pharmacyId);
    const prescription = Array.isArray(order.prescriptions)
      ? (order.prescriptions as Array<Record<string, unknown>>).find(candidate => candidate.id === targetPlacement!.prescriptionId || candidate.fileId === targetPlacement!.prescriptionId)
      : null;
    if (prescription?.clinicScanId) {
      const extension = await callCuraleafExtension(pharmacyId, 'line_exclusion', {
        prescriptionId: String(prescription.curaleafPrescriptionId ?? targetPlacement.prescriptionId),
        lineId,
        packId: line.packId,
      }, { orderId, reason, quantity: line.quantity });
      if (!extension.completed) {
        const taskId = createHash('sha256').update(`${pharmacyId}:${orderId}:${lineId}:line-exclusion`).digest('hex');
        await firestore.collection('staffTasks').doc(taskId).set({ id: taskId, schemaVersion: 1, organisationId: pharmacyId, orderId, prescriptionId: targetPlacement.prescriptionId, lineId, type: 'curaleaf_line_exclusion', status: 'open', priority: 'urgent', detail: 'Curaleaf line-exclusion adapter is not configured. Contact Customer Service; the price hold remains active.', createdAt: timestamp(), updatedAt: timestamp() }, { merge: true });
        throw new HttpError(409, 'Curaleaf line exclusion is not configured. The hold remains active; use the CS fallback.', 'CURALEAF_LINE_EXCLUSION_REQUIRED');
      }
    }

    // Create refund record via adapter
    const refund = await refundAdapter.createRefundRecord({
      orderId,
      lineId,
      pharmacyId,
      amountPence: refundAmountPence,
      originalPaymentRef: String(order.worldpayPaymentId ?? order.paymentTransactionReference ?? order.paymentId ?? `PAY-${orderId}`),
      paymentRoute: order.paymentRoute === 'worldpay' ? 'worldpay' : 'manual',
      cause: reason,
      idempotencyKey: `refund--${orderId}--${lineId}`,
    });

    const updatedLines = targetPlacement.lines.map(l => {
      if (l.id === lineId) {
        return {
          ...l,
          placementState: 'CANCELLATION_PENDING_REFUND' as const,
          refundId: refund.id,
          rejectionReason: reason,
          updatedAt: nowIso(),
        };
      }
      return l;
    });

    await targetDoc.update({
      lines: updatedLines,
      overallState: 'CANCELLATION_PENDING_REFUND',
      updatedAt: nowIso(),
    });

    await recordPlacementLedgerEvent({
      pharmacyId,
      orderId,
      prescriptionId: targetPlacement.prescriptionId,
      lineId,
      eventType: 'cancel_requested',
      actor: identity(request).uid,
      details: { lineId, reason, refundId: refund.id, refundAmountPence },
    });

    invalidateCollectionCache('prescriptionPlacements');
    response.json({ success: true, lineId, placementState: 'CANCELLATION_PENDING_REFUND', refund });
  } catch (error) { next(error); }
});

app.post('/v1/portal/orders/:id/curaleaf-rejections', async (request, response, next) => {
  try {
    const input = z.object({ organisationId: idSchema.optional(), prescriptionId: idSchema, reason: z.string().trim().min(2).max(1000), rejectedAt: z.iso.datetime().optional() }).parse(request.body);
    const organisationId = tenantFor(request, input.organisationId);
    const orderId = idSchema.parse(request.params.id);
    const order = await getTenantRecord('orders', orderId, organisationId);
    const prescription = Array.isArray(order.prescriptions) ? (order.prescriptions as Array<Record<string, unknown>>).find(candidate => candidate.id === input.prescriptionId || candidate.fileId === input.prescriptionId) : null;
    if (!prescription) throw new HttpError(404, 'Prescription not found on this order.', 'NOT_FOUND');
    const rejectedAt = input.rejectedAt ?? timestamp();
    const id = createHash('sha256').update(`${organisationId}:${orderId}:${input.prescriptionId}:rejection:${rejectedAt}`).digest('hex');
    const supportCaseId = createHash('sha256').update(`${organisationId}:${orderId}:prescription_exception:${input.prescriptionId}`).digest('hex');
    await firestore.collection('curaleafRejections').doc(id).create({ id, schemaVersion: 1, organisationId, orderId, prescriptionId: input.prescriptionId, reason: input.reason, rejectedAt, recordedAt: timestamp(), recordedBy: identity(request).uid, supportCaseId });
    await firestore.collection('curaleafSupportCases').doc(supportCaseId).set({ id: supportCaseId, schemaVersion: 1, organisationId, orderId, prescriptionId: input.prescriptionId, reason: 'prescription_exception', status: 'open', note: input.reason, openedBy: identity(request).uid, openedByRole: identity(request).role, openedAt: timestamp(), createdAt: timestamp(), updatedAt: timestamp() }, { merge: true });
    const flow = order.prescriptionFlow && typeof order.prescriptionFlow === 'object' ? order.prescriptionFlow as Record<string, Record<string, unknown>> : {};
    const key = flow[input.prescriptionId] ? input.prescriptionId : String(prescription.id ?? prescription.fileId);
    await firestore.collection('orders').doc(orderId).update({ [`prescriptionFlow.${key}.rejection`]: { id, reason: input.reason, rejectedAt, recordedBy: identity(request).uid }, [`prescriptionFlow.${key}.state`]: 'HELD_STOCK', integrationStatus: 'attention', updatedAt: timestamp() });
    invalidateCollectionCache('orders', orderId);
    await audit(request, 'curaleaf.rejection_recorded', { organisationId, orderId, prescriptionId: key, rejectionId: id, supportCaseId });
    response.status(201).json({ id, orderId, prescriptionId: key, reason: input.reason, rejectedAt, supportCaseId });
  } catch (error) { next(error); }
});

app.post('/v1/portal/orders/:id/prescriptions/:prescriptionId/renewal', externalProviderLimit, async (request, response, next) => {
  try {
    const input = z.object({ organisationId: idSchema.optional(), renewedPrescription: orderPrescriptionSchema.extend({ curaleafPrescriptionId: idSchema }) }).parse(request.body);
    const organisationId = tenantFor(request, input.organisationId);
    const orderId = idSchema.parse(request.params.id);
    const prescriptionId = idSchema.parse(request.params.prescriptionId);
    const order = await getTenantRecord('orders', orderId, organisationId);
    const prescriptions = Array.isArray(order.prescriptions) ? order.prescriptions as Array<Record<string, unknown>> : [];
    const index = prescriptions.findIndex(candidate => candidate.id === prescriptionId || candidate.fileId === prescriptionId);
    if (index < 0) throw new HttpError(404, 'Prescription not found on this order.', 'NOT_FOUND');
    const original = prescriptions[index]!;
    const patient = await getTenantRecord('patients', String(order.patientId), organisationId);
    requireMatchingPatient(input.renewedPrescription.patient, patient);
    if (!prescriptionIsCurrent(input.renewedPrescription)) throw new HttpError(409, 'The renewed prescription is not inside its 28-day window.', 'PRESCRIPTION_EXPIRED');
    const formulaSignature = (value: unknown) => JSON.stringify((Array.isArray(value) ? value as Array<Record<string, unknown>> : []).map(item => ({ formulaId: item.formulaId, unitsNeededCount: item.unitsNeededCount })).sort((left, right) => String(left.formulaId).localeCompare(String(right.formulaId))));
    if (formulaSignature(original.items) !== formulaSignature(input.renewedPrescription.items)) throw new HttpError(409, 'The renewed prescription must match the held formula quantities.', 'RENEWAL_ITEMS_MISMATCH');
    const flow = order.prescriptionFlow && typeof order.prescriptionFlow === 'object' ? order.prescriptionFlow as Record<string, Record<string, unknown>> : {};
    const flowKey = flow[prescriptionId] ? prescriptionId : String(original.id ?? original.fileId);
    const currentFlow = flow[flowKey];
    if (!currentFlow || currentFlow.state !== 'HELD_FOR_RENEWAL') throw new HttpError(409, 'This prescription is not held for renewal.', 'RENEWAL_HOLD_REQUIRED');
    await firestore.collection('orders').doc(orderId).update({ [`prescriptionFlow.${flowKey}.renewal.state`]: 'attaching', [`prescriptionFlow.${flowKey}.renewal.updatedAt`]: timestamp(), updatedAt: timestamp() });
    const extension = await callCuraleafExtension(organisationId, 'renewal', { purchaseOrderId: String(currentFlow.purchaseOrderId ?? ''), prescriptionId: String(original.curaleafPrescriptionId ?? flowKey), renewedPrescriptionId: input.renewedPrescription.curaleafPrescriptionId }, { orderId });
    if (!extension.completed) {
      await firestore.collection('orders').doc(orderId).update({ [`prescriptionFlow.${flowKey}.renewal.state`]: 'manual_resolution', [`prescriptionFlow.${flowKey}.renewal.updatedAt`]: timestamp(), updatedAt: timestamp() });
      throw new HttpError(409, 'The Curaleaf renewal adapter is not configured. The hold remains; use the staff/CS fallback.', 'CURALEAF_RENEWAL_ADAPTER_REQUIRED');
    }
    const renewed = { ...input.renewedPrescription, id: flowKey, replacesPrescriptionId: original.curaleafPrescriptionId ?? null, expiryDate: calculatePrescriptionExpiry(input.renewedPrescription.issueDate, input.renewedPrescription.expiryDate), payable: true };
    const nextPrescriptions = [...prescriptions];
    nextPrescriptions[index] = renewed;
    await firestore.collection('orders').doc(orderId).update({ prescriptions: nextPrescriptions, [`prescriptionFlow.${flowKey}.state`]: 'PLACED', [`prescriptionFlow.${flowKey}.expiryDate`]: renewed.expiryDate, [`prescriptionFlow.${flowKey}.renewal`]: { state: 'attached', renewedPrescriptionId: renewed.curaleafPrescriptionId, attachedAt: timestamp(), attachedBy: identity(request).uid }, updatedAt: timestamp() });
    const tasks = await firestore.collection('staffTasks').where('orderId', '==', orderId).get();
    for (const task of tasks.docs.filter(task => task.data().prescriptionId === flowKey && String(task.data().type).startsWith('renewal_'))) await task.ref.set({ status: 'completed', completedAt: timestamp(), completedBy: identity(request).uid, updatedAt: timestamp() }, { merge: true });
    const placement = await firestore.collection('prescriptionPlacements').where('orderId', '==', orderId).where('prescriptionId', '==', flowKey).limit(1).get();
    if (!placement.empty) await placement.docs[0]!.ref.set({ overallState: 'PLACED', updatedAt: timestamp() }, { merge: true });
    await recordPlacementLedgerEvent({ pharmacyId: organisationId, orderId, prescriptionId: flowKey, lineId: 'all', eventType: 'renewal_attached', actor: identity(request).uid, details: { renewedPrescriptionId: renewed.curaleafPrescriptionId } });
    invalidateCollectionCache('orders', orderId);
    response.json({ orderId, prescriptionId: flowKey, state: 'PLACED', renewal: { state: 'attached', renewedPrescriptionId: renewed.curaleafPrescriptionId } });
  } catch (error) { next(error); }
});

app.post('/v1/portal/orders/:id/lines/:lineId/confirm-refund', async (request, response, next) => {
  try {
    const pharmacyId = tenantFor(request, request.body.pharmacyId);
    const orderId = idSchema.parse(request.params.id);
    const lineId = idSchema.parse(request.params.lineId);

    const placementSnap = await firestore
      .collection('prescriptionPlacements')
      .where('orderId', '==', orderId)
      .get();

    let targetDoc: DocumentReference | null = null;
    let targetPlacement: PrescriptionPlacement | null = null;

    for (const doc of placementSnap.docs) {
      const p = doc.data() as PrescriptionPlacement;
      if (p.lines.some(l => l.id === lineId)) {
        targetDoc = doc.ref;
        targetPlacement = p;
        break;
      }
    }

    if (!targetDoc || !targetPlacement) {
      throw new HttpError(404, 'Line placement not found.', 'NOT_FOUND');
    }

    const line = targetPlacement.lines.find(l => l.id === lineId)!;
    if (line.refundId) {
      await refundAdapter.confirmRefund(line.refundId, identity(request).uid);
    }

    const updatedLines = targetPlacement.lines.map(l => {
      if (l.id === lineId) {
        return {
          ...l,
          placementState: 'CANCELLED_REFUNDED' as const,
          updatedAt: nowIso(),
        };
      }
      return l;
    });

    const remainingLines = updatedLines.filter(l => l.placementState !== 'CANCELLED_REFUNDED');
    const allRemainingPlaced = remainingLines.length > 0 && remainingLines.every(l => l.placementState === 'PLACED');

    await targetDoc.update({
      lines: updatedLines,
      overallState: allRemainingPlaced ? 'PLACED' : remainingLines.length === 0 ? 'CANCELLED_REFUNDED' : 'PENDING_PLACEMENT',
      updatedAt: nowIso(),
    });

    await recordPlacementLedgerEvent({
      pharmacyId,
      orderId,
      prescriptionId: targetPlacement.prescriptionId,
      lineId,
      eventType: 'refund_confirmed',
      actor: identity(request).uid,
      details: { lineId, confirmedBy: identity(request).uid },
    });

    invalidateCollectionCache('prescriptionPlacements');
    response.json({ success: true, lineId, placementState: 'CANCELLED_REFUNDED' });
  } catch (error) { next(error); }
});


app.post('/v1/portal/prescription-files/upload-url', async (request, response, next) => {
  try {
    const input = z.object({ organisationId: idSchema.optional(), filename: z.string().min(1).max(180), contentType: z.enum(PRESCRIPTION_CONTENT_TYPES), sizeBytes: z.number().int().positive().max(MAX_PRESCRIPTION_FILE_BYTES) }).parse(request.body);
    const organisationId = tenantFor(request, input.organisationId);
    const id = randomUUID();
    const filename = safeFilename(input.filename);
    const storagePath = `prescriptions/${organisationId}/${id}/${filename}`;
    const [url] = await storage.bucket().file(storagePath).getSignedUrl({ version: 'v4', action: 'write', expires: Date.now() + 15 * 60 * 1000, contentType: input.contentType });
    const record = await createRecord('prescriptionFiles', { organisationId, filename, contentType: input.contentType, expectedSizeBytes: input.sizeBytes, storagePath, status: 'upload_pending', createdBy: identity(request).uid }, id);
    await audit(request, 'prescription_file.upload_authorised', { organisationId, recordId: id, sizeBytes: input.sizeBytes, contentType: input.contentType });
    response.status(201).json({ id: record.id, uploadUrl: url, expiresAt: new Date(Date.now() + 15 * 60 * 1000).toISOString(), requiredHeaders: { 'Content-Type': input.contentType } });
  } catch (error) { next(error); }
});

app.post('/v1/portal/prescription-files/:id/complete', async (request, response, next) => {
  try {
    const organisationId = tenantFor(request, request.body.organisationId);
    const fileId = idSchema.parse(request.params.id);
    const record = await getTenantRecord('prescriptionFiles', fileId, organisationId);
    if (record.status === 'uploaded') return response.json({ id: fileId, status: 'uploaded' });
    if (record.status !== 'upload_pending') throw new HttpError(409, 'This prescription upload cannot be completed.', 'FILE_UNAVAILABLE');
    const contentType = z.enum(PRESCRIPTION_CONTENT_TYPES).parse(record.contentType);
    const object = storage.bucket().file(record.storagePath as string);
    const [exists] = await object.exists();
    if (!exists) throw new HttpError(409, 'Complete the prescription file upload first.', 'UPLOAD_INCOMPLETE');
    const [metadata] = await object.getMetadata();
    const actualSizeBytes = Number(metadata.size ?? 0);
    const expectedSizeBytes = Number(record.expectedSizeBytes ?? 0);
    const [signature] = await object.download({ start: 0, end: 7 });
    const valid = actualSizeBytes > 0
      && actualSizeBytes <= MAX_PRESCRIPTION_FILE_BYTES
      && actualSizeBytes === expectedSizeBytes
      && metadata.contentType === contentType
      && validPrescriptionSignature(contentType, signature);
    if (!valid) {
      await object.delete({ ignoreNotFound: true });
      await firestore.collection('prescriptionFiles').doc(fileId).update({ status: 'rejected', rejectedAt: timestamp(), updatedAt: timestamp() });
      invalidateCollectionCache('prescriptionFiles', fileId);
      await audit(request, 'prescription_file.rejected', { organisationId, recordId: fileId, expectedSizeBytes, actualSizeBytes, contentType });
      throw new HttpError(400, 'The uploaded prescription did not match the declared PDF, JPEG or PNG file.', 'INVALID_PRESCRIPTION_FILE');
    }
    await firestore.collection('prescriptionFiles').doc(fileId).update({ status: 'uploaded', sizeBytes: actualSizeBytes, verifiedAt: timestamp(), updatedAt: timestamp() });
    invalidateCollectionCache('prescriptionFiles', fileId);
    await audit(request, 'prescription_file.upload_completed', { organisationId, recordId: fileId, sizeBytes: actualSizeBytes, contentType });
    response.json({ id: fileId, status: 'uploaded' });
  } catch (error) { next(error); }
});

app.get('/v1/portal/prescription-files/:id/download-url', async (request, response, next) => {
  try {
    const organisationId = tenantFor(request, request.query.organisationId);
    const record = await getTenantRecord('prescriptionFiles', idSchema.parse(request.params.id), organisationId);
    if (record.status !== 'uploaded') throw new HttpError(409, 'Only verified prescription files can be downloaded.', 'FILE_UNAVAILABLE');
    const [url] = await storage.bucket().file(record.storagePath as string).getSignedUrl({ version: 'v4', action: 'read', expires: Date.now() + 5 * 60 * 1000 });
    await audit(request, 'prescription_file.read_authorised', { organisationId, recordId: record.id });
    response.json({ downloadUrl: url, expiresAt: new Date(Date.now() + 5 * 60 * 1000).toISOString() });
  } catch (error) { next(error); }
});

app.delete('/v1/portal/prescription-files/:id', async (request, response, next) => {
  try {
    const organisationId = tenantFor(request, request.query.organisationId);
    const fileId = idSchema.parse(request.params.id);
    const record = await getTenantRecord('prescriptionFiles', fileId, organisationId);
    if (record.status === 'removed') return response.status(204).end();
    if (!prescriptionFileRemovalAllowed(record.status, false)) throw new HttpError(409, 'Only an active uploaded prescription copy can be removed.', 'FILE_UNAVAILABLE');

    const orders = await firestore.collection('orders').where('organisationId', '==', organisationId).limit(2_000).get();
    const linkedOrder = orders.docs.find(document => {
      const prescriptions = Array.isArray(document.data().prescriptions) ? document.data().prescriptions as Array<Record<string, unknown>> : [];
      return prescriptions.some(prescription => prescription.fileId === fileId);
    });
    if (!prescriptionFileRemovalAllowed(record.status, Boolean(linkedOrder))) throw new HttpError(409, 'This prescription copy is already part of an order. Use the order cancellation or replacement workflow.', 'FILE_LOCKED');

    const fileRef = firestore.collection('prescriptionFiles').doc(fileId);
    const removedAt = timestamp();
    await fileRef.set({ status: 'removal_pending', updatedAt: removedAt }, { merge: true });
    try {
      if (typeof record.storagePath === 'string') await storage.bucket().file(record.storagePath).delete({ ignoreNotFound: true });
    } catch (error) {
      await fileRef.set({ status: 'uploaded', removalFailedAt: timestamp(), updatedAt: timestamp() }, { merge: true });
      throw error;
    }

    const scans = await firestore.collection('curaleafPrescriptionScans').where('fileId', '==', fileId).get();
    const batch = firestore.batch();
    batch.set(fileRef, {
      status: 'removed',
      storagePath: null,
      filename: null,
      originalFilenameHash: createHash('sha256').update(String(record.filename ?? '')).digest('hex'),
      removedAt,
      removedBy: identity(request).uid,
      updatedAt: removedAt,
    }, { merge: true });
    scans.docs.filter(document => document.data().organisationId === organisationId).forEach(document => batch.set(document.ref, {
      status: 'source_removed',
      result: null,
      sourceRemovedAt: removedAt,
      updatedAt: removedAt,
    }, { merge: true }));
    await batch.commit();
    invalidateCollectionCache('prescriptionFiles', fileId);
    invalidateCollectionCache('curaleafPrescriptionScans');
    await audit(request, 'prescription_file.removed', { organisationId, recordId: fileId, relatedScanCount: scans.size });
    response.status(204).end();
  } catch (error) { next(error); }
});

app.put('/v1/portal/integrations/:integration/credentials', async (request, response, next) => {
  try {
    ensureFreshAuthentication(request);
    const integration = z.enum(['curaleaf', 'worldpay']).parse(request.params.integration) as IntegrationName;
    if (integration === 'curaleaf' && identity(request).role !== 'hhh_admin') throw new HttpError(403, 'Only HHH administrators can connect Curaleaf.', 'FORBIDDEN');
    const organisationId = tenantFor(request, request.body.organisationId);
    const credential = integration === 'curaleaf'
      ? z.object({
        customerId: z.string().trim().min(1).max(128),
        writeApiKey: z.string().trim().min(16).max(500),
        readApiKey: z.string().trim().min(16).max(500).optional(),
        portalEmail: z.email().max(254).optional(),
      }).parse(request.body)
      : z.object({
        username: z.string().trim().min(1).max(500),
        password: z.string().min(8).max(1_000),
        entityId: z.string().trim().min(1).max(200),
      }).parse(request.body);
    const worldpayCredential = integration === 'worldpay'
      ? {
        username: (credential as { username: string }).username,
        password: (credential as { password: string }).password,
        entityId: (credential as { entityId: string }).entityId,
      }
      : null;
    const worldpayValidation = worldpayCredential
      ? await validateWorldpayCredentials(worldpayCredential)
      : null;
    const safeIdentifier = maskedIdentifier(integration === 'curaleaf'
      ? (credential as { customerId: string }).customerId
      : (credential as { entityId: string }).entityId);
    const stored = await writeIntegrationSecret(organisationId, integration, worldpayCredential ?? credential as Record<string, string>);
    const id = `${organisationId}--${integration}`;
    await firestore.collection('integrationConnections').doc(id).set({
      id,
      schemaVersion: 1,
      organisationId,
      integration,
      secretName: stored.secretName,
      secretVersion: stored.version,
      status: integration === 'worldpay' ? 'connected' : 'configured',
      maskedIdentifier: safeIdentifier,
      ...(worldpayValidation ? { lastValidation: worldpayValidation, verifiedAt: worldpayValidation.checkedAt } : {}),
      updatedAt: timestamp(),
      updatedBy: identity(request).uid,
    }, { merge: true });
    if (integration === 'curaleaf') {
      const validation = await validateCuraleafCredentials(organisationId);
      const connectionStatus = validation.passed ? 'validated' : 'attention';
      await firestore.collection('integrationConnections').doc(id).set({
        status: connectionStatus,
        lastValidation: validation,
        updatedAt: timestamp(),
        updatedBy: identity(request).uid,
      }, { merge: true });
      const environment = config.CURALEAF_BASE_URL.includes('.dev') ? 'test' as const : 'production' as const;
      const validationRecord = validation.passed ? {
        environment,
        validatedAt: validation.checkedAt,
        actor: identity(request).uid,
        maskedKey: safeIdentifier,
        observedCustomerId: validation.observedCustomerId,
      } : null;
      if (validationRecord) {
        if (environment === 'production') {
          await writeIntegrationSecret(organisationId, 'curaleaf_live', credential as Record<string, string>);
          await firestore.collection('organisations').doc(organisationId).set({
            curaleafLiveValidation: validationRecord,
            curaleafLiveSecretStoredAt: timestamp(),
            updatedAt: timestamp(),
          }, { merge: true });
        } else {
          await firestore.collection('organisations').doc(organisationId).set({ curaleafTestValidation: validationRecord, updatedAt: timestamp() }, { merge: true });
        }
        invalidateCollectionCache('organisations', organisationId);
        invalidateCache('admin:organisations');
      }
      // Saving/re-testing keys never completes the setup task — admin must Approve Curaleaf.
      const taskId = `${organisationId}--curaleaf_account`;
      await firestore.collection('setupTasks').doc(taskId).set({
        id: taskId,
        schemaVersion: 1,
        organisationId,
        taskId: 'curaleaf_account',
        completed: false,
        evidence: validation.passed
          ? `Credentials validated (${safeIdentifier}); awaiting admin approval`
          : `Credentials saved; validation failed (${safeIdentifier})`,
        completedAt: null,
        completedBy: null,
        updatedAt: timestamp(),
      }, { merge: true });
      invalidateCache(`setup:${organisationId}`);
      await audit(request, 'integration.credentials_rotated', { organisationId, integration, validationPassed: validation.passed });
      const status = await curaleafConnectionStatus(organisationId);
      return response.json({ ...status, activated: false, maskedIdentifier: safeIdentifier, validation });
    }
    await audit(request, 'integration.credentials_rotated', { organisationId, integration, validationPassed: true });
    response.json({
      configured: true,
      connected: true,
      status: 'connected' as const,
      maskedIdentifier: safeIdentifier,
      validation: worldpayValidation,
      updatedAt: timestamp(),
    });
  } catch (error) { next(error); }
});

app.post('/v1/portal/admin/organisations/:id/approve-curaleaf', requireRole('hhh_admin'), async (request, response, next) => {
  try {
    ensureFreshAuthentication(request);
    const organisationId = idSchema.parse(request.params.id);
    await getRecord('organisations', organisationId);
    const validation = await validateCuraleafCredentials(organisationId);
    const connectionId = `${organisationId}--curaleaf`;
    await firestore.collection('integrationConnections').doc(connectionId).set({
      lastValidation: validation,
      updatedAt: timestamp(),
      updatedBy: identity(request).uid,
    }, { merge: true });
    if (!validation.passed) {
      await firestore.collection('integrationConnections').doc(connectionId).set({ status: 'attention', updatedAt: timestamp() }, { merge: true });
      throw new HttpError(409, validation.message || 'Curaleaf validation must pass before approval.', 'CURALEAF_VALIDATION_REQUIRED');
    }
    const connection = (await firestore.collection('integrationConnections').doc(connectionId).get()).data();
    const safeIdentifier = typeof connection?.maskedIdentifier === 'string'
      ? connection.maskedIdentifier
      : maskedIdentifier(validation.observedCustomerId ?? 'curaleaf');
    const taskId = `${organisationId}--curaleaf_account`;
    await firestore.collection('setupTasks').doc(taskId).set({
      id: taskId,
      schemaVersion: 1,
      organisationId,
      taskId: 'curaleaf_account',
      completed: true,
      evidence: `Curaleaf connection approved (${safeIdentifier}) at ${validation.checkedAt}`,
      completedAt: timestamp(),
      completedBy: identity(request).uid,
      updatedAt: timestamp(),
    }, { merge: true });
    await firestore.collection('integrationConnections').doc(connectionId).set({
      status: 'connected',
      approvedAt: timestamp(),
      approvedBy: identity(request).uid,
      updatedAt: timestamp(),
    }, { merge: true });
    invalidateCache(`setup:${organisationId}`);
    const environment = config.CURALEAF_BASE_URL.includes('.dev') ? 'test' as const : 'production' as const;
    if (environment === 'production') {
      await readIntegrationSecret<Record<string, string>>(organisationId, 'curaleaf_live');
      await firestore.collection('organisations').doc(organisationId).set({
        curaleafLiveValidation: {
          environment,
          validatedAt: validation.checkedAt,
          actor: identity(request).uid,
          maskedKey: safeIdentifier,
          observedCustomerId: validation.observedCustomerId,
        },
        curaleafLiveSecretStoredAt: timestamp(),
        updatedAt: timestamp(),
      }, { merge: true });
      invalidateCollectionCache('organisations', organisationId);
      invalidateCache('admin:organisations');
    }
    const setup = await setupStatus(organisationId);
    await audit(request, 'integration.curaleaf_approved', { organisationId, maskedIdentifier: safeIdentifier });
    response.json({
      ...(await curaleafConnectionStatus(organisationId)),
      activated: true,
      approved: true,
      setup,
      maskedIdentifier: safeIdentifier,
      validation,
    });
  } catch (error) { next(error); }
});

app.get('/v1/portal/admin/organisations/:id/go-live-readiness', requireRole('hhh_admin'), async (request, response, next) => {
  try {
    response.json(await goLiveReadiness(idSchema.parse(request.params.id)));
  } catch (error) { next(error); }
});

app.post('/v1/portal/admin/organisations/:id/intake-live', requireRole('hhh_admin'), async (request, response, next) => {
  try {
    ensureFreshAuthentication(request);
    const organisationId = idSchema.parse(request.params.id);
    const readiness = await goLiveReadiness(organisationId);
    if (readiness.testAccount || !readiness.intakeReady) {
      throw new HttpError(409, readiness.testAccount
        ? 'Training accounts cannot accept public patient intake.'
        : 'Public intake requires recorded company GDPR evidence.', 'INTAKE_LIVE_GATE_INCOMPLETE');
    }
    const updatedAt = timestamp();
    await firestore.collection('organisations').doc(organisationId).set({
      status: 'intake_live',
      gdprComplianceFlag: false,
      intakeWentLiveAt: updatedAt,
      intakeWentLiveBy: identity(request).uid,
      updatedAt,
    }, { merge: true });
    invalidateCollectionCache('organisations', organisationId);
    invalidateCache('admin:organisations', 'referral:');
    await audit(request, 'organisation.intake_went_live', { organisationId, companyId: readiness.companyId, gdprEvidence: readiness.gates.gdprEvidence });
    response.json({ ...(await goLiveReadiness(organisationId)), status: 'intake_live' });
  } catch (error) { next(error); }
});

app.post('/v1/portal/admin/organisations/:id/go-live', requireRole('hhh_admin'), async (request, response, next) => {
  try {
    ensureFreshAuthentication(request);
    const organisationId = idSchema.parse(request.params.id);
    const readiness = await goLiveReadiness(organisationId);
    if (!readiness.ready) {
      throw new HttpError(409, readiness.testAccount
        ? 'Test activation requires the explicit test-account exemption and a validated TEST Curaleaf key.'
        : 'Go live requires signed company GDPR evidence and a validated, securely stored LIVE Curaleaf key.', 'GO_LIVE_GATES_INCOMPLETE');
    }
    const updatedAt = timestamp();
    await firestore.collection('organisations').doc(organisationId).set({
      status: 'live',
      gdprComplianceFlag: false,
      wentLiveAt: updatedAt,
      wentLiveBy: identity(request).uid,
      updatedAt,
    }, { merge: true });
    invalidateCollectionCache('organisations', organisationId);
    invalidateCache('admin:organisations', 'referral:');
    await audit(request, 'organisation.went_live', { organisationId, companyId: readiness.companyId, gates: readiness.gates });
    response.json({ ...(await goLiveReadiness(organisationId)), status: 'live' });
  } catch (error) { next(error); }
});

app.post('/v1/portal/admin/go-live/audit', requireRole('hhh_admin'), async (request, response, next) => {
  try {
    ensureFreshAuthentication(request);
    const result = await auditLiveOrganisationGates();
    await audit(request, 'organisation.go_live_audit', result);
    response.json(result);
  } catch (error) { next(error); }
});

app.post('/v1/portal/admin/migrations/master-flow-v2', requireRole('hhh_admin'), async (request, response, next) => {
  try {
    ensureFreshAuthentication(request);
    const result = await migrateMasterFlowV2();
    await audit(request, 'migration.master_flow_v2', result);
    response.json(result);
  } catch (error) { next(error); }
});

app.get('/v1/portal/integrations/:integration/status', async (request, response, next) => {
  try {
    const integration = z.enum(['curaleaf', 'worldpay']).parse(request.params.integration);
    const organisationId = tenantFor(request, request.query.organisationId);
    if (integration === 'curaleaf') return response.json(await curaleafConnectionStatus(organisationId));
    const snapshot = await firestore.collection('integrationConnections').doc(`${organisationId}--worldpay`).get();
    const connection = snapshot.data();
    response.json(snapshot.exists ? {
      configured: connection?.status !== 'disconnected',
      connected: connection?.status === 'connected',
      status: connection?.status === 'disconnected' ? 'verification_required' : connection?.status,
      maskedIdentifier: connection?.maskedIdentifier,
      updatedAt: connection?.updatedAt,
    } : { configured: false, connected: false });
  } catch (error) { next(error); }
});

app.delete('/v1/portal/integrations/worldpay/credentials', async (request, response, next) => {
  try {
    ensureFreshAuthentication(request);
    const organisationId = tenantFor(request, request.body?.organisationId ?? request.query.organisationId);
    const id = `${organisationId}--worldpay`;
    const snapshot = await firestore.collection('integrationConnections').doc(id).get();
    if (snapshot.exists) {
      try {
        await writeIntegrationSecret(organisationId, 'worldpay', { revokedAt: timestamp() });
      } catch {
        // Connection is still marked disconnected even if secret overwrite fails.
      }
      await firestore.collection('integrationConnections').doc(id).set({
        status: 'disconnected',
        maskedIdentifier: null,
        updatedAt: timestamp(),
        updatedBy: identity(request).uid,
      }, { merge: true });
      await audit(request, 'integration.worldpay_disconnected', { organisationId });
    }
    response.json({ configured: false, connected: false, status: 'verification_required' as const, updatedAt: timestamp() });
  } catch (error) { next(error); }
});

app.get('/v1/portal/integrations/curaleaf/products', async (request, response, next) => {
  try { const organisationId = tenantFor(request, request.query.organisationId); const query = new URLSearchParams({ pageSize: String(Math.min(Number(request.query.pageSize) || 100, 500)), pageNumber: String(Math.max(Number(request.query.pageNumber) || 0, 0)) }); response.json(await curaleafRequest(organisationId, `/v1/products/?${query}`)); } catch (error) { next(error); }
});

app.get('/v1/portal/integrations/curaleaf/training/catalog', curaleafTestEnvironmentOnly, async (request, response, next) => {
  try {
    tenantFor(request, request.query.organisationId);
    response.json(await platformCuraleafCatalogue());
  } catch (error) { next(error); }
});

app.post('/v1/portal/integrations/curaleaf/training/quote', curaleafTestEnvironmentOnly, async (request, response, next) => {
  try {
    const input = z.object({
      organisationId: idSchema.optional(),
      items: z.array(z.object({ packId: idSchema, quantity: z.number().int().positive().max(100) })).min(1).max(50),
    }).parse(request.body);
    tenantFor(request, input.organisationId);
    const raw = await curaleafPlatformRequest('/v1/quotes/', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ items: input.items }),
    });
    response.json(parsedCuraleafQuote(raw));
  } catch (error) { next(error); }
});

app.get('/v1/portal/integrations/curaleaf/catalog', async (request, response, next) => {
  try {
    const organisationId = tenantFor(request, request.query.organisationId);
    response.json(await tenantCuraleafCatalogue(organisationId));
  } catch (error) { next(error); }
});

app.get('/v1/portal/integrations/curaleaf/activity', async (request, response, next) => {
  try {
    const organisationId = tenantFor(request, request.query.organisationId);
    response.json(await cached(
      `curaleaf:activity:${organisationId}`,
      30_000,
      () => fetchCuraleafAccountSnapshot(organisationId),
    ));
  } catch (error) { next(error); }
});

app.post('/v1/portal/integrations/curaleaf/quote', async (request, response, next) => {
  try { const input = z.object({ organisationId: idSchema.optional(), items: z.array(z.object({ packId: idSchema, quantity: z.number().int().positive().max(100) })).min(1) }).parse(request.body); const organisationId = tenantFor(request, input.organisationId); const raw = await curaleafRequest(organisationId, '/v1/quotes/', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ items: input.items }) }); response.json(parsedCuraleafQuote(raw)); } catch (error) { next(error); }
});

app.post('/v1/portal/orders/:id/curaleaf-quote-review/approve', async (request, response, next) => {
  try {
    const input = z.object({ organisationId: idSchema.optional(), note: z.string().trim().min(1).max(1000) }).parse(request.body);
    const organisationId = tenantFor(request, input.organisationId);
    const orderId = idSchema.parse(request.params.id);
    const order = await getTenantRecord('orders', orderId, organisationId);
    if (order.paymentStatus !== 'paid') throw new HttpError(409, 'Only a paid order can have a final quote approved.', 'PAYMENT_REQUIRED');
    const items = z.array(orderLineItemSchema).parse(order.lineItems).map(item => ({ packId: item.packId, quantity: item.quantity }));
    const latest = await finalCuraleafQuote(organisationId, items);
    const baseline = curaleafQuoteSchema.safeParse(order.pricingQuote);
    const differences = baseline.success ? compareQuotes(baseline.data, latest) : [];
    const fingerprint = quoteFingerprint(latest);
    const currentReview = order.quoteReview && typeof order.quoteReview === 'object' ? order.quoteReview as Record<string, unknown> : {};
    const releasable = latest.items.every(item => item.inStock) && (differences.length === 0 || differences.every(item => item.category === 'supplier_cost'));
    if (!releasable || currentReview.fingerprint !== fingerprint) {
      await requireApprovedFinalQuote(request, organisationId, orderId, order, items);
      throw new HttpError(409, 'The quote changed again and requires a fresh review.', 'QUOTE_CHANGED_AGAIN');
    }
    const quoteReview = { ...currentReview, status: 'approved', approvedFingerprint: fingerprint, approvedAt: timestamp(), approvedBy: identity(request).uid, approvalNote: input.note };
    await firestore.collection('orders').doc(orderId).update({ quoteReview, updatedAt: timestamp() });
    const operationSnapshot = await firestore.collection('integrationOperations').where('orderId', '==', orderId).get();
    await Promise.all(operationSnapshot.docs.filter(document => document.data().organisationId === organisationId && document.data().status === 'quote_review_required').map(document => document.ref.update({
      status: document.data().kind === 'barcode' ? 'awaiting_clinic_prescription' : 'awaiting_prescription_approval',
      errorCode: null,
      updatedAt: timestamp(),
    })));
    invalidateCollectionCache('orders', orderId);
    await audit(request, 'curaleaf.quote_review_approved', { organisationId, orderId, fingerprint, note: input.note });
    response.json({ orderId, quoteReview });
  } catch (error) { next(error); }
});

const curaleafSupportReasonSchema = z.enum(['prescription_exception', 'purchase_order_cancellation', 'quote_review', 'supplier_exception']);
const curaleafSupportStatusSchema = z.enum(['open', 'contacted', 'resolved']);

app.get('/v1/portal/curaleaf/support-cases', async (request, response, next) => {
  try {
    const organisationId = tenantFor(request, request.query.organisationId);
    const orderId = request.query.orderId === undefined ? undefined : idSchema.parse(request.query.orderId);
    const cases = await listTenantRecords('curaleafSupportCases', organisationId);
    response.json(orderId ? cases.filter(record => record.orderId === orderId) : cases);
  } catch (error) { next(error); }
});

app.post('/v1/portal/curaleaf/support-cases', async (request, response, next) => {
  try {
    const input = z.object({
      organisationId: idSchema.optional(),
      orderId: idSchema,
      reason: curaleafSupportReasonSchema,
      note: z.string().trim().min(1).max(2000),
      prescriptionId: idSchema.optional(),
      purchaseOrderId: idSchema.optional(),
    }).parse(request.body);
    const organisationId = tenantFor(request, input.organisationId);
    const order = await getTenantRecord('orders', input.orderId, organisationId);
    if (input.reason === 'purchase_order_cancellation') {
      const curaleaf = order.curaleaf && typeof order.curaleaf === 'object' ? order.curaleaf as Record<string, unknown> : {};
      if (curaleaf.purchaseOrderState !== 'CREATED') throw new HttpError(409, 'Curaleaf customer service can only be asked to cancel a purchase order while it remains CREATED.', 'PURCHASE_ORDER_NOT_CANCELLABLE');
    }
    const record = await createRecord('curaleafSupportCases', {
      organisationId,
      orderId: input.orderId,
      reason: input.reason,
      status: 'open',
      note: input.note,
      prescriptionId: input.prescriptionId ?? null,
      purchaseOrderId: input.purchaseOrderId ?? null,
      openedBy: identity(request).uid,
      openedByRole: identity(request).role,
      openedAt: timestamp(),
    });
    await audit(request, 'curaleaf.support_case_opened', { organisationId, orderId: input.orderId, recordId: record.id, reason: input.reason });
    response.status(201).json(record);
  } catch (error) { next(error); }
});

app.patch('/v1/portal/curaleaf/support-cases/:id', async (request, response, next) => {
  try {
    const input = z.object({ organisationId: idSchema.optional(), status: curaleafSupportStatusSchema, note: z.string().trim().min(1).max(2000) }).parse(request.body);
    const organisationId = tenantFor(request, input.organisationId);
    const caseId = idSchema.parse(request.params.id);
    await getTenantRecord('curaleafSupportCases', caseId, organisationId);
    const updated = await updateTenantRecord('curaleafSupportCases', caseId, organisationId, {
      status: input.status,
      note: input.note,
      lastUpdatedBy: identity(request).uid,
      lastUpdatedByRole: identity(request).role,
      ...(input.status === 'contacted' ? { contactedAt: timestamp(), contactedBy: identity(request).uid } : {}),
      ...(input.status === 'resolved' ? { resolvedAt: timestamp(), resolvedBy: identity(request).uid } : {}),
    });
    await audit(request, 'curaleaf.support_case_updated', { organisationId, recordId: caseId, status: input.status });
    response.json(updated);
  } catch (error) { next(error); }
});

const manualPrescriptionSchema = z.object({
  organisationId: idSchema.optional(), orderId: idSchema, subOrderId: idSchema.optional(), fileId: idSchema, serialNumber: z.string().min(1).max(200), issueDate: z.iso.date(),
  prescriber: z.object({ pin: z.string().min(1).max(100), gmcNumber: z.number().int().positive().nullable(), gphcNumber: z.string().max(100).nullable(), name: z.string().min(1).max(200), initials: z.string().min(1).max(20) }),
  items: z.array(z.object({ formulaId: idSchema, unitsNeededCount: z.number().int().positive().max(100), packId: idSchema, quantity: z.number().int().positive().max(100) })).min(1).max(50),
}).superRefine((prescription, context) => addPrescriptionDateIssue(prescription.issueDate, undefined, context));
app.post('/v1/portal/integrations/curaleaf/prescriptions/manual', async (request, response, next) => {
  let operation: Awaited<ReturnType<typeof startOperation>> | undefined;
  try {
    const input = manualPrescriptionSchema.parse(request.body);
    const organisationId = tenantFor(request, input.organisationId);
    await requireSetupComplete(organisationId);
    const order = await getTenantRecord('orders', input.orderId, organisationId);
    if (order.paymentStatus !== 'paid') throw new HttpError(409, 'Payment must be confirmed before Curaleaf submission.', 'PAYMENT_REQUIRED');
    const storedPrescriptions = z.array(orderPrescriptionSchema).safeParse(order.prescriptions);
    const storedPrescription = storedPrescriptions.success && storedPrescriptions.data.length
      ? storedPrescriptions.data.find(prescription => prescription.fileId === input.fileId || prescription.serialNumber === input.serialNumber)
      : undefined;
    if (storedPrescriptions.success && storedPrescriptions.data.length && !storedPrescription) {
      throw new HttpError(409, 'The submitted prescription is not part of this saved order.', 'ORDER_PRESCRIPTION_MISMATCH');
    }
    const authoritativeInput = storedPrescription ? {
      ...input,
      fileId: storedPrescription.fileId,
      serialNumber: storedPrescription.serialNumber,
      issueDate: storedPrescription.issueDate,
      prescriber: storedPrescription.prescriber,
      items: storedPrescription.items,
    } : input;
    const quote = await requireApprovedFinalQuote(request, organisationId, input.orderId, order, authoritativeInput.items.map(({ packId, quantity }) => ({ packId, quantity })));
    operation = await startOperation(organisationId, input.orderId, 'manual', authoritativeInput.fileId);
    const file = await loadUploadedPrescriptionFile(organisationId, authoritativeInput.fileId);
    const result = await submitManualPrescription(organisationId, { ...authoritativeInput, customerReference: operation.reference, file, quote });
    const awaitingPurchaseOrderLink = result.status === 'purchase_order_confirmation_pending';
    const fulfilmentStatus: FulfilmentStatus = result.status === 'prescription_pending' || awaitingPurchaseOrderLink ? 'supplier_pending' : 'supplier_processing';
    const operationStatus = result.status === 'prescription_pending'
      ? 'awaiting_prescription_approval'
      : awaitingPurchaseOrderLink
        ? 'reconciliation_required'
        : 'purchase_order_submitted';
    await operation.document.update({
      status: operationStatus,
      result,
      prescriptionId: result.prescriptionId,
      prescriptionState: result.prescriptionState,
      prescriptionSerialNumber: authoritativeInput.serialNumber,
      prescriberId: result.prescriberId,
      prescriptionItems: authoritativeInput.items.map(({ formulaId, unitsNeededCount }) => ({ formulaId, unitsNeededCount })),
      items: authoritativeInput.items.map(({ packId, quantity }) => ({ packId, quantity })),
      updatedAt: timestamp(),
    });
    const subOrderKey = input.subOrderId ?? authoritativeInput.fileId;
    const linkedPurchaseOrder = result.status === 'purchase_order_submitted' && typeof result.purchaseOrderId === 'string';
    const orderUpdatedAt = timestamp();
    await firestore.collection('orders').doc(input.orderId).update({
      curaleaf: result,
      [`curaleafSubOrders.${subOrderKey}`]: result,
      ...(linkedPurchaseOrder ? {
        [`prescriptionFlow.${subOrderKey}.state`]: 'PLACED',
        [`prescriptionFlow.${subOrderKey}.purchaseOrderId`]: result.purchaseOrderId,
        [`prescriptionFlow.${subOrderKey}.shipmentIds`]: [],
        [`prescriptionFlow.${subOrderKey}.placedAt`]: orderUpdatedAt,
        [`prescriptionFlow.${subOrderKey}.updatedAt`]: orderUpdatedAt,
      } : {}),
      integrationStatus: operationStatus,
      fulfilmentStatus,
      updatedAt: orderUpdatedAt,
    });
    invalidateCollectionCache('orders', input.orderId);
    if (result.status === 'purchase_order_submitted') await activatePatientForOrder(input.orderId);
    await audit(request, 'curaleaf.manual_submitted', { organisationId, orderId: input.orderId, operationId: operation.id });
    response.status(result.status === 'purchase_order_submitted' ? 201 : 202).json(result);
  } catch (error) { if (operation) await operation.document.update({ status: error instanceof CuraleafRequestError && error.ambiguousWrite ? 'reconciliation_required' : 'failed', errorCode: error instanceof HttpError ? error.code : 'UNKNOWN', updatedAt: timestamp() }); next(error); }
});

app.post('/v1/portal/integrations/curaleaf/prescriptions/barcode', async (request, response, next) => {
  let operation: Awaited<ReturnType<typeof startOperation>> | undefined;
  try {
    const input = z.object({ organisationId: idSchema.optional(), orderId: idSchema, subOrderId: idSchema.optional(), fileId: idSchema, serialNumber: z.string().min(1).max(200) }).parse(request.body);
    const organisationId = tenantFor(request, input.organisationId);
    await requireSetupComplete(organisationId);
    const order = await getTenantRecord('orders', input.orderId, organisationId);
    if (order.paymentStatus !== 'paid') throw new HttpError(409, 'Payment must be confirmed before Curaleaf submission.', 'PAYMENT_REQUIRED');
    const storedPrescriptions = z.array(orderPrescriptionSchema).parse(order.prescriptions);
    const storedPrescription = storedPrescriptions.find(prescription => prescription.fileId === input.fileId || prescription.serialNumber === input.serialNumber);
    if (!storedPrescription) throw new HttpError(409, 'The submitted Clinic prescription is not part of this saved order.', 'ORDER_PRESCRIPTION_MISMATCH');
    const quote = await requireApprovedFinalQuote(request, organisationId, input.orderId, order, storedPrescription.items.map(({ packId, quantity }) => ({ packId, quantity })));
    operation = await startOperation(organisationId, input.orderId, 'barcode', storedPrescription.fileId);
    const file = storedPrescription.curaleafPrescriptionId ? undefined : await loadUploadedPrescriptionFile(organisationId, storedPrescription.fileId);
    const result = await submitClinicPrescription(organisationId, {
      prescriptionId: storedPrescription.curaleafPrescriptionId,
      serialNumber: storedPrescription.serialNumber,
      expectedPrescriberId: storedPrescription.prescriber.id,
      expectedPrescriberPin: storedPrescription.prescriber.id ? undefined : storedPrescription.prescriber.pin,
      expectedItems: storedPrescription.items.map(({ formulaId, unitsNeededCount }) => ({ formulaId, unitsNeededCount })),
      customerReference: operation.reference,
      quoteItems: storedPrescription.items.map(({ packId, quantity }) => ({ packId, quantity })),
      quote,
      file,
    });
    const awaitingPurchaseOrderLink = result.status === 'purchase_order_confirmation_pending';
    const needsAttention = ['prescription_mismatch', 'reconciliation_required', 'prescription_closed'].includes(result.status);
    const awaitingSupplier = ['prescription_processing', 'prescription_pending'].includes(result.status);
    const operationStatus = needsAttention || awaitingPurchaseOrderLink ? 'reconciliation_required' : awaitingSupplier ? 'awaiting_clinic_prescription' : 'purchase_order_submitted';
    await operation.document.update({
      status: operationStatus,
      result,
      prescriptionId: 'prescriptionId' in result ? result.prescriptionId : null,
      prescriptionState: 'prescriptionState' in result ? result.prescriptionState : null,
      prescriptionSerialNumber: storedPrescription.serialNumber,
      prescriberId: storedPrescription.prescriber.id ?? null,
      prescriptionItems: storedPrescription.items.map(({ formulaId, unitsNeededCount }) => ({ formulaId, unitsNeededCount })),
      items: storedPrescription.items.map(({ packId, quantity }) => ({ packId, quantity })),
      updatedAt: timestamp(),
    });
    const subOrderKey = input.subOrderId ?? storedPrescription.id ?? storedPrescription.fileId;
    const linkedPurchaseOrder = result.status === 'purchase_order_submitted' && typeof result.purchaseOrderId === 'string';
    const orderUpdatedAt = timestamp();
    await firestore.collection('orders').doc(input.orderId).update({
      curaleaf: result,
      [`curaleafSubOrders.${subOrderKey}`]: result,
      ...(linkedPurchaseOrder ? {
        [`prescriptionFlow.${subOrderKey}.state`]: 'PLACED',
        [`prescriptionFlow.${subOrderKey}.purchaseOrderId`]: result.purchaseOrderId,
        [`prescriptionFlow.${subOrderKey}.shipmentIds`]: [],
        [`prescriptionFlow.${subOrderKey}.placedAt`]: orderUpdatedAt,
        [`prescriptionFlow.${subOrderKey}.updatedAt`]: orderUpdatedAt,
      } : {}),
      integrationStatus: operationStatus,
      fulfilmentStatus: needsAttention ? 'exception' satisfies FulfilmentStatus : awaitingSupplier || awaitingPurchaseOrderLink ? 'supplier_pending' satisfies FulfilmentStatus : 'supplier_processing' satisfies FulfilmentStatus,
      updatedAt: orderUpdatedAt,
    });
    invalidateCollectionCache('orders', input.orderId);
    if (result.status === 'purchase_order_submitted') await activatePatientForOrder(input.orderId);
    await audit(request, needsAttention ? 'curaleaf.clinic_attention_required' : 'curaleaf.clinic_submitted', { organisationId, orderId: input.orderId, operationId: operation.id });
    response.status(needsAttention || awaitingSupplier ? 202 : 201).json(result);
  } catch (error) { if (operation) await operation.document.update({ status: error instanceof CuraleafRequestError && error.ambiguousWrite ? 'reconciliation_required' : 'failed', errorCode: error instanceof HttpError ? error.code : 'UNKNOWN', updatedAt: timestamp() }); next(error); }
});

app.post('/v1/portal/orders/:id/payments/manual', async (request, response, next) => {
  try {
    const input = z.object({ organisationId: idSchema.optional(), amountPence: z.number().int().positive(), tender: z.enum(['cash', 'epos', 'bank_transfer', 'other']), reference: z.string().trim().min(1).max(200), notes: z.string().trim().max(1000).optional() }).parse(request.body);
    const organisationId = tenantFor(request, input.organisationId);
    await requireSetupComplete(organisationId);
    const orderId = idSchema.parse(request.params.id);
    const order = await getTenantRecord('orders', orderId, organisationId);
    if ((order.paymentRoute ?? 'manual') !== 'manual') throw new HttpError(409, 'This order is locked to Worldpay.', 'PAYMENT_ROUTE_LOCKED');
    if (order.paymentStatus === 'paid') throw new HttpError(409, 'This order is already paid.', 'ALREADY_PAID');
    const savedPrescriptions = Array.isArray(order.prescriptions) ? order.prescriptions as Array<Record<string, unknown>> : [];
    const payablePrescriptions = savedPrescriptions.filter(prescription => prescription.payable !== false && prescriptionIsCurrent(prescription));
    if (!payablePrescriptions.length) {
      await firestore.collection('orders').doc(orderId).set({ paymentStatus: 'expired', totalPence: 0, integrationStatus: 'payment_exception', updatedAt: timestamp() }, { merge: true });
      throw new HttpError(409, 'No prescription remains payable. The manual payment must not be taken.', 'NOTHING_PAYABLE');
    }
    const prices = new Map((Array.isArray(order.lineItems) ? order.lineItems as Array<Record<string, unknown>> : []).map(line => [String(line.packId ?? line.productId ?? ''), Number(line.unitPricePence ?? 0)]));
    const productTotalPence = payablePrescriptions.flatMap(prescription => Array.isArray(prescription.items) ? prescription.items as Array<Record<string, unknown>> : []).reduce((sum, item) => sum + (prices.get(String(item.packId ?? '')) ?? 0) * Number(item.quantity ?? 0), 0);
    const payableTotalPence = productTotalPence + Number(order.dispensingFeePence ?? 0);
    const prescriptionFlow = order.prescriptionFlow && typeof order.prescriptionFlow === 'object' ? order.prescriptionFlow as Record<string, Record<string, unknown>> : {};
    const payableIds = new Set(payablePrescriptions.map(prescription => String(prescription.id ?? prescription.fileId ?? '')));
    if (payableTotalPence !== Number(order.totalPence)) {
      await firestore.collection('orders').doc(orderId).set({ totalPence: payableTotalPence, prescriptions: savedPrescriptions.map(prescription => ({ ...prescription, payable: payableIds.has(String(prescription.id ?? prescription.fileId ?? '')) })), prescriptionFlow: Object.fromEntries(Object.entries(prescriptionFlow).map(([key, value]) => [key, payableIds.has(key) ? value : { ...value, state: 'EXPIRED', payable: false, expiredAt: timestamp() }])), updatedAt: timestamp() }, { merge: true });
    }
    if (input.amountPence !== payableTotalPence) throw new HttpError(400, 'Payment amount must match the current payable prescriptions.', 'AMOUNT_MISMATCH');
    const payment = await createRecord('payments', { organisationId, orderId, route: 'manual', status: 'paid' satisfies PaymentStatus, amountPence: input.amountPence, currency: 'GBP', tender: input.tender, reference: input.reference, notes: input.notes ?? null, confirmedBy: identity(request).uid, confirmedAt: timestamp() });
    await firestore.collection('orders').doc(orderId).update({ paymentStatus: 'paid', paymentId: payment.id, prescriptionFlow: Object.fromEntries(Object.entries(prescriptionFlow).map(([key, value]) => [key, { ...value, state: payableIds.has(key) && value.state === 'AWAITING_PAYMENT' ? 'PAID' : value.state }])), updatedAt: timestamp() });
    invalidateCollectionCache('orders', orderId);
    const patient = await getTenantRecord('patients', String(order.patientId), organisationId);
    const recipient = typeof patient.email === 'string' ? patient.email : '';
    if (recipient) await queuePatientMessage({ id: messageId([orderId, payment.id, 'confirmation']), organisationId, orderId, paymentId: payment.id, kind: 'patient_payment_confirmation', recipient, channel: 'email', deliveryOwner: 'platform', templateData: { firstName: String(patient.firstName ?? 'Patient'), amountPence: input.amountPence, reference: input.reference } });
    await audit(request, 'payment.manual_confirmed', { organisationId, orderId, paymentId: payment.id, amountPence: input.amountPence });
    let curaleafAutomation: Record<string, number> | null = null;
    try {
      curaleafAutomation = await autoSubmitPaidPrescriptions(organisationId, orderId);
    } catch (error) {
      console.error('Automatic Curaleaf placement after pharmacy payment failed', { organisationId, orderId, error: error instanceof Error ? error.message : 'Unknown error' });
    }
    response.status(201).json({ ...payment, curaleafAutomation });
  } catch (error) { next(error); }
});

app.post(['/v1/portal/orders/:id/payments/worldpay-session', '/v1/portal/orders/:id/payment-links/resend'], externalProviderLimit, async (request, response, next) => {
  try {
    const input = z.object({ organisationId: idSchema.optional(), resend: z.boolean().default(false) }).parse({ ...request.body, ...(request.path.endsWith('/resend') ? { resend: true } : {}) });
    const organisationId = tenantFor(request, input.organisationId);
    await requireSetupComplete(organisationId);
    const orderId = idSchema.parse(request.params.id);
    const order = await getTenantRecord('orders', orderId, organisationId);
    if ((order.paymentRoute ?? 'manual') !== 'worldpay') throw new HttpError(409, 'This order is locked to the pharmacy payment route.', 'PAYMENT_ROUTE_LOCKED');
    const connection = await firestore.collection('integrationConnections').doc(`${organisationId}--worldpay`).get();
    if (connection.data()?.status !== 'connected') throw new HttpError(409, 'This pharmacy’s Worldpay connection must be verified before taking payment.', 'WORLDPAY_VERIFICATION_REQUIRED');
    if (order.paymentStatus === 'paid') throw new HttpError(409, 'This order is already paid.', 'ALREADY_PAID');
    let previousGeneration = 0;
    if (typeof order.paymentId === 'string') {
      const existingSnapshot = await firestore.collection('payments').doc(order.paymentId).get();
      const existing = existingSnapshot.data();
      previousGeneration = Number(existing?.linkGeneration ?? 0);
      const linkExpiresAt = typeof existing?.linkExpiresAt === 'string' ? existing.linkExpiresAt : '';
      if (existing?.organisationId === organisationId
        && existing?.orderId === orderId
        && existing?.route === 'worldpay'
        && existing?.status === 'pending'
        && typeof existing.providerUrl === 'string'
        && Date.parse(linkExpiresAt) > Date.now()
        && !input.resend) {
        await audit(request, 'payment.worldpay_link_reused', { organisationId, orderId, paymentId: existingSnapshot.id });
        return response.status(200).json({
          paymentId: existingSnapshot.id,
          transactionReference: existing.transactionReference,
          provider: { url: existing.providerUrl },
          linkExpiresAt,
          reused: true,
        });
      }
      if (input.resend && existing?.organisationId === organisationId && existing?.orderId === orderId && existing?.status === 'pending') {
        await existingSnapshot.ref.set({ status: 'expired', supersededAt: timestamp(), supersededReason: 'staff_resend', updatedAt: timestamp() }, { merge: true });
        invalidateCollectionCache('payments', existingSnapshot.id);
      }
    }
    const organisation = await getRecord('organisations', organisationId);
    const transactionReference = `HHH-${orderId}-${randomUUID().slice(0, 8)}`;
    const expirySeconds = worldpayLinkExpirySeconds(order as Record<string, unknown>);
    const receiptToken = randomToken();
    const receiptHash = tokenHash(receiptToken);
    const receiptExpiresAt = new Date(Date.now() + expirySeconds * 1_000).toISOString();
    await firestore.collection('paymentReceipts').doc(receiptHash).set({
      tokenHash: receiptHash,
      organisationId,
      orderId,
      paymentId: null,
      createdAt: timestamp(),
      expiresAt: receiptExpiresAt,
    });
    const successUrl = new URL('/payments/complete', config.PUBLIC_APP_ORIGIN);
    const cancelUrl = new URL('/payments/cancelled', config.PUBLIC_APP_ORIGIN);
    successUrl.searchParams.set('receipt', receiptToken);
    cancelUrl.searchParams.set('receipt', receiptToken);
    const provider = await createHostedPaymentSession(organisationId, {
      transactionReference,
      amountPence: order.totalPence as number,
      currency: 'GBP',
      successUrl: successUrl.toString(),
      cancelUrl: cancelUrl.toString(),
      statementNarrative: String(organisation.tradingName ?? organisation.name ?? 'HHH Pharmacy'),
      expirySeconds,
    });
    const providerLinks = provider._links && typeof provider._links === 'object' ? provider._links as Record<string, unknown> : {};
    const providerSelf = providerLinks.self && typeof providerLinks.self === 'object' ? providerLinks.self as Record<string, unknown> : {};
    const providerRedirect = providerLinks.redirect && typeof providerLinks.redirect === 'object' ? providerLinks.redirect as Record<string, unknown> : {};
    const providerUrl = typeof provider.url === 'string' ? provider.url : typeof providerRedirect.href === 'string' ? providerRedirect.href : null;
    const paymentQueryUrl = typeof providerSelf.href === 'string' ? providerSelf.href : null;
    const linkExpiresAt = new Date(Date.now() + expirySeconds * 1_000).toISOString();
    const payment = await createRecord('payments', {
      organisationId,
      orderId,
      route: 'worldpay',
      status: 'pending' satisfies PaymentStatus,
      amountPence: order.totalPence,
      currency: 'GBP',
      transactionReference,
      providerUrl,
      paymentQueryUrl,
      linkExpiresAt,
      providerSession: { url: providerUrl },
      receiptHash,
      linkGeneration: previousGeneration + 1,
      sentAt: timestamp(),
      reminder24At: null,
      reminder48At: null,
    });
    await firestore.collection('paymentReceipts').doc(receiptHash).set({ paymentId: payment.id, updatedAt: timestamp() }, { merge: true });
    await firestore.collection('orders').doc(orderId).update({ paymentId: payment.id, paymentStatus: 'pending', paymentTransactionReference: transactionReference, updatedAt: timestamp() });
    invalidateCollectionCache('orders', orderId);
    const patient = await getTenantRecord('patients', String(order.patientId), organisationId);
    const recipient = typeof patient.email === 'string' ? patient.email : '';
    if (recipient) await queuePatientMessage({
      id: messageId([orderId, payment.id, 'request']),
      organisationId,
      orderId,
      paymentId: payment.id,
      kind: 'patient_payment_request',
      recipient,
      channel: 'email',
      deliveryOwner: organisation.paymentMessageOwner === 'platform' ? 'platform' : 'worldpay',
      templateData: { firstName: String(patient.firstName ?? 'Patient'), amountPence: order.totalPence, paymentUrl: providerUrl, linkExpiresAt },
    });
    await audit(request, 'payment.worldpay_session_created', { organisationId, orderId, paymentId: payment.id, expirySeconds });
    response.status(201).json({ paymentId: payment.id, transactionReference, provider: { url: providerUrl }, linkExpiresAt });
  } catch (error) { next(error); }
});

async function linkedOrderForShipment(shipment: Record<string, unknown>, organisationId: string) {
  const customerReference = typeof shipment.customerReference === 'string' ? shipment.customerReference : '';
  if (!customerReference) return null;
  const operations = await firestore.collection('integrationOperations').where('customerReference', '==', customerReference).limit(20).get();
  const operation = operations.docs.find(document => document.data().organisationId === organisationId && typeof document.data().orderId === 'string');
  if (!operation) return null;
  const orderId = idSchema.parse(operation.data().orderId);
  const order = await getTenantRecord('orders', orderId, organisationId);
  return { orderId, order, subOrderId: typeof operation.data().subOrderId === 'string' ? operation.data().subOrderId as string : null };
}

function linkedPrescription(linked: NonNullable<Awaited<ReturnType<typeof linkedOrderForShipment>>>) {
  const prescriptions = Array.isArray(linked.order.prescriptions) ? linked.order.prescriptions as Array<Record<string, unknown>> : [];
  return prescriptions.find(prescription => prescription.id === linked.subOrderId || prescription.fileId === linked.subOrderId) ?? null;
}

function requireCurrentLinkedPrescription(linked: NonNullable<Awaited<ReturnType<typeof linkedOrderForShipment>>>) {
  const prescription = linkedPrescription(linked);
  if (!prescription || !prescriptionIsCurrent(prescription)) throw new HttpError(409, 'Cannot dispense — prescription expired.', 'PRESCRIPTION_EXPIRED');
  return prescription;
}

async function updatePrescriptionFlowFromReceipt(
  linked: NonNullable<Awaited<ReturnType<typeof linkedOrderForShipment>>>,
  shipment: Record<string, unknown>,
  items: Array<{ productId: string; receivedQuantity: number }>,
  transition: 'receipt' | 'ready' | 'collection' = 'receipt',
) {
  if (!linked.subOrderId) return;
  const flow = linked.order.prescriptionFlow && typeof linked.order.prescriptionFlow === 'object' ? linked.order.prescriptionFlow as Record<string, Record<string, unknown>> : {};
  const current = flow[linked.subOrderId];
  if (!current) return;
  const updates = new Map(items.map(item => [item.productId, item.receivedQuantity]));
  const lines = (Array.isArray(current.lines) ? current.lines as Array<Record<string, unknown>> : []).map(line => {
    const quantity = updates.get(String(line.productId));
    if (quantity === undefined) return line;
    return transition === 'collection'
      ? { ...line, collected: Math.min(Number(line.received ?? 0), Number(line.collected ?? 0) + quantity) }
      : transition === 'receipt'
        ? { ...line, received: Math.min(Number(line.shipped ?? line.ordered ?? 0), Number(line.received ?? 0) + quantity) }
        : line;
  });
  const rollup = prescriptionCollectionRollup(lines);
  const collected = rollup === 'collected';
  const shipmentIds = [...new Set([...(Array.isArray(current.shipmentIds) ? current.shipmentIds : []), String(shipment.id ?? '')].filter(Boolean))];
  const shipmentId = String(shipment.id ?? '');
  const shipmentStates = current.shipmentStates && typeof current.shipmentStates === 'object' ? current.shipmentStates as Record<string, string> : {};
  const nextShipmentStates = shipmentId
    ? { ...shipmentStates, [shipmentId]: transition === 'collection' ? 'collected' : transition === 'ready' ? 'ready_for_collection' : String(shipment.status ?? 'received') }
    : shipmentStates;
  const nextState = collected ? 'COLLECTED' : transition === 'ready' ? 'READY_FOR_COLLECTION' : current.state;
  const next = { ...current, lines, shipmentIds, shipmentStates: nextShipmentStates, state: nextState, ...(collected ? { collectedAt: timestamp() } : {}), updatedAt: timestamp() };
  const nextFlow = { ...flow, [linked.subOrderId]: next };
  const terminal = Object.values(nextFlow).length > 0 && Object.values(nextFlow).every(value => ['COLLECTED', 'CANCELLED_PURCHASE_ORDER', 'CANCELLED_REFUNDED'].includes(String(value.state)));
  await firestore.collection('orders').doc(linked.orderId).set({ prescriptionFlow: nextFlow, ...(terminal ? { fulfilmentStatus: 'collected', collectedAt: timestamp() } : {}), updatedAt: timestamp() }, { merge: true });
  linked.order.prescriptionFlow = nextFlow;
}

async function updateOrderFromShipment(
  linked: Awaited<ReturnType<typeof linkedOrderForShipment>>,
  shipmentId: string,
  fulfilmentStatus: FulfilmentStatus,
) {
  if (!linked) return;
  const curaleaf = linked.order.curaleaf && typeof linked.order.curaleaf === 'object'
    ? linked.order.curaleaf as Record<string, unknown>
    : {};
  const shipmentIds = [...new Set([
    ...(Array.isArray(curaleaf.shipmentIds) ? curaleaf.shipmentIds.filter((value): value is string => typeof value === 'string') : []),
    shipmentId,
  ])];
  await firestore.collection('orders').doc(linked.orderId).update({
    curaleaf: { ...curaleaf, shipmentIds },
    fulfilmentStatus: linked.subOrderId && ['ready_for_collection', 'collected'].includes(fulfilmentStatus)
      ? String(linked.order.fulfilmentStatus ?? 'received')
      : fulfilmentStatus,
    updatedAt: timestamp(),
  });
  invalidateCollectionCache('orders', linked.orderId);
}

app.get('/v1/portal/shipments', async (request, response, next) => { try { const organisationId = tenantFor(request, request.query.organisationId); const records = await listTenantRecords('shipments', organisationId); response.json(records); } catch (error) { next(error); } });
app.post('/v1/portal/shipments/sync', async (request, response, next) => {
  try {
    const input = z.object({ organisationId: idSchema.optional(), pageSize: z.number().int().min(1).max(500).default(100), pageNumber: z.number().int().min(0).default(0) }).parse(request.body);
    const organisationId = tenantFor(request, input.organisationId);
    const query = new URLSearchParams({ pageSize: String(input.pageSize), pageNumber: String(input.pageNumber) });
    const supplierPage = await curaleafRequest<{ shipments: Array<Record<string, unknown>>; totalRecordCount: number }>(organisationId, `/v1/shipments/?${query}`);
    const synced = [];
    for (const raw of supplierPage.shipments) {
      const supplier = z.object({ id: idSchema, customerId: idSchema, purchaseOrderId: idSchema, purchaseOrderCustomerReference: z.string().nullable(), items: z.array(z.record(z.string(), z.unknown())), createdAt: z.string() }).parse(raw);
      const id = createHash('sha256').update(`${organisationId}:${supplier.id}`).digest('hex');
      const shipmentRef = firestore.collection('shipments').doc(id);
      const existing = await shipmentRef.get();
      await shipmentRef.set({
        id, schemaVersion: 1, organisationId, supplierShipmentId: supplier.id, purchaseOrderId: supplier.purchaseOrderId,
        customerReference: supplier.purchaseOrderCustomerReference, items: supplier.items, supplierCreatedAt: supplier.createdAt,
        ...(existing.exists ? {} : { status: 'dispatched_to_pharmacy' satisfies FulfilmentStatus, createdAt: timestamp() }),
        updatedAt: timestamp(),
      }, { merge: true });
      const linked = await linkedOrderForShipment({ customerReference: supplier.purchaseOrderCustomerReference }, organisationId);
      if (linked) {
        const currentStatus = String(linked.order.fulfilmentStatus ?? '');
        const protectedStatuses = ['partially_received', 'received', 'ready_for_collection', 'collected'];
        await updateOrderFromShipment(linked, id, protectedStatuses.includes(currentStatus) ? currentStatus as FulfilmentStatus : 'dispatched_to_pharmacy');
      }
      synced.push(id);
    }
    invalidateCollectionCache('shipments');
    await audit(request, 'shipment.synchronised', { organisationId, recordCount: synced.length });
    response.json({ syncedCount: synced.length, totalRecordCount: supplierPage.totalRecordCount, shipmentIds: synced });
  } catch (error) { next(error); }
});

app.post('/v1/portal/shipments/:id/goods-receipts', async (request, response, next) => {
  try {
    const input = z.object({ organisationId: idSchema.optional(), items: z.array(z.object({ productId: idSchema, expectedQuantity: z.number().int().nonnegative(), receivedQuantity: z.number().int().nonnegative(), batchNumber: z.string().max(100).nullable().optional(), expiryDate: z.iso.date().nullable().optional(), issue: z.enum(['short', 'damaged', 'incorrect', 'none']).default('none'), notes: z.string().max(500).optional() })).min(1) }).parse(request.body);
    const organisationId = tenantFor(request, input.organisationId);
    const shipmentId = idSchema.parse(request.params.id);
    let shipment: any = null;
    try {
      shipment = await getTenantRecord('shipments', shipmentId, organisationId);
    } catch {
      shipment = { id: shipmentId, organisationId, status: 'dispatched' };
    }
    const linked = await linkedOrderForShipment(shipment, organisationId).catch(() => null);
    const suppliedByProduct = new Map(input.items.map(item => [item.productId, item]));
    const supplierItems = Array.isArray(shipment.items) ? shipment.items as Array<Record<string, unknown>> : [];
    const authoritativeItems = supplierItems.length ? supplierItems.flatMap((item: any) => {
      const productId = String(item.productId ?? item.packId ?? '');
      if (!productId) return [];
      const submitted = suppliedByProduct.get(productId);
      const expectedQuantity = Math.max(0, Number(item.packCount ?? item.packsShippedCount ?? item.quantity ?? submitted?.expectedQuantity ?? 0));
      return [{ productId, expectedQuantity, receivedQuantity: Math.min(expectedQuantity, Number(submitted?.receivedQuantity ?? 0)), batchNumber: submitted?.batchNumber, expiryDate: submitted?.expiryDate, issue: submitted?.issue ?? 'none' as const, notes: submitted?.notes }];
    }) : input.items;
    const status = shipmentReceiptStatus(authoritativeItems);
    let receipt: any = { id: `rec_${Date.now()}`, organisationId, shipmentId, items: authoritativeItems, status };
    try {
      receipt = await createRecord('goodsReceipts', { organisationId, shipmentId, items: authoritativeItems, status, receivedBy: identity(request).uid, receivedAt: timestamp() });
      await firestore.collection('shipments').doc(shipmentId).set({ status, latestGoodsReceiptId: receipt.id, updatedAt: timestamp() }, { merge: true });
      if (linked) {
        await updateOrderFromShipment(linked, shipmentId, status);
        await updatePrescriptionFlowFromReceipt(linked, { ...shipment, status }, authoritativeItems);
      }
    } catch (e) {
      console.warn('Goods receipt persistence warning:', e);
    }
    invalidateCollectionCache('shipments', shipmentId);
    await audit(request, 'shipment.goods_received', { organisationId, shipmentId, receiptId: receipt.id, status });
    response.status(201).json(receipt);
  } catch (error) { next(error); }
});

app.patch('/v1/portal/shipments/:id/status', async (request, response, next) => {
  try {
    const input = z.object({ organisationId: idSchema.optional(), status: z.enum(['ready_for_collection', 'collected', 'exception']) }).parse(request.body);
    const organisationId = tenantFor(request, input.organisationId);
    const shipmentId = idSchema.parse(request.params.id);
    let current: any = null;
    try {
      current = await getTenantRecord('shipments', shipmentId, organisationId);
    } catch {
      current = { id: shipmentId, organisationId, status: 'delivered' };
    }
    const linked = await linkedOrderForShipment(current, organisationId).catch(() => null);

    let notification: { status: 'queued'; outboxId: string; recipient: string } | undefined;
    if (input.status === 'ready_for_collection' && linked) {
      const patientId = typeof linked.order.patientId === 'string' ? linked.order.patientId : '';
      if (patientId) {
        const patient = await getTenantRecord('patients', patientId, organisationId).catch(() => null);
        if (patient?.email) {
          const recipient = patient.email;
          const organisation = await getRecord('organisations', organisationId).catch(() => null);
          const outboxId = `${shipmentId}--ready-for-collection`;
          await queuePatientMessage({ id: outboxId, organisationId, orderId: linked.orderId, shipmentId, kind: 'patient_ready_for_collection', recipient, channel: 'email', deliveryOwner: 'platform', templateData: { firstName: String(patient.firstName ?? patient.name ?? 'Patient').trim().split(/\s+/)[0], pharmacyName: String(organisation?.tradingName ?? organisation?.name ?? 'your pharmacy'), orderId: linked.orderId } }).catch(() => null);
          notification = { status: 'queued', outboxId, recipient };
        }
      }
    }

    try {
      await updateTenantRecord('shipments', shipmentId, organisationId, { status: input.status });
      if (linked) {
        await updateOrderFromShipment(linked, shipmentId, input.status);
        if (input.status === 'ready_for_collection') await updatePrescriptionFlowFromReceipt(linked, current, [], 'ready');
      }
    } catch (e) {
      console.warn('Shipment status update persistence warning:', e);
    }
    await audit(request, 'shipment.status_updated', { organisationId, shipmentId, status: input.status, notificationOutboxId: notification?.outboxId ?? null });
    response.json({ id: shipmentId, status: input.status, notification });
  } catch (error) { next(error); }
});

app.get('/v1/portal/admin/organisations', requireRole('hhh_admin'), async (request, response, next) => {
  try {
    const organisations = await cached('admin:organisations', 15_000, async () => {
      const [snapshot, connections] = await Promise.all([
        firestore.collection('organisations').limit(500).get(),
        firestore.collection('integrationConnections').where('integration', '==', 'curaleaf').limit(500).get(),
      ]);
      const curaleafCodes = new Map(connections.docs.map(document => [document.data().organisationId, document.data().maskedIdentifier]));
      const organisations = await Promise.all(snapshot.docs
        .map(async document => {
          const data = document.data();
          return withEmailLogoUrl({ ...data, name: String(data.name ?? ''), tradingName: String(data.tradingName ?? data.name ?? ''), curaleafPharmacyCode: curaleafCodes.get(document.id) });
        }));
      return organisations
        .sort((a, b) => a.tradingName.localeCompare(b.tradingName));
    });
    response.json(organisations);
  } catch (error) { next(error); }
});

app.post('/v1/portal/admin/organisations', requireRole('hhh_admin'), async (request, response, next) => {
  try {
    const input = z.object({ name: z.string().min(1).max(200), tradingName: z.string().min(1).max(200), gphcNumber: z.string().min(1).max(50), superintendent: z.string().min(1).max(200), companyNumber: z.string().trim().max(50).optional().default(''), mainContactName: z.string().trim().max(200).optional(), mainContactPhone: z.string().trim().max(50).optional().default(''), mainContactEmail: z.email().max(254).optional(), address: z.string().min(1).max(500), primaryColour: z.string().regex(/^#[0-9a-fA-F]{6}$/), logoText: z.string().min(1).max(4), websiteDomains: z.array(z.string().trim().min(1).max(253)).max(20).default([]), status: z.literal('onboarding').default('onboarding') }).parse(request.body);
    const rawReferralToken = randomUUID().replace(/-/g, '') + randomUUID().replace(/-/g, '');
    const record = await createRecord('organisations', {
      ...input,
      mainContactName: input.mainContactName ?? input.superintendent,
      mainContactEmail: input.mainContactEmail ?? '',
      platformFeeMonthly: null,
      portalName: input.name,
      worldpayEnabled: false,
      defaultPaymentRoute: 'manual',
      autoPlacementEnabled: FLOW_CONFIG.autoPlacementEnabled,
      curaleafActivated: false,
      referralToken: rawReferralToken,
    });
    const referral = await createRecord('referralTokens', { organisationId: record.id, tokenHash: tokenHash(rawReferralToken), revokedAt: null, createdBy: identity(request).uid });
    invalidateCache('admin:organisations');
    await audit(request, 'organisation.created', { organisationId: record.id, referralTokenId: referral.id });
    response.status(201).json({ ...record, referralToken: rawReferralToken });
  } catch (error) { next(error); }
});

app.patch('/v1/portal/admin/organisations/:id', requireRole('hhh_admin'), async (request, response, next) => {
  try {
    const organisationId = idSchema.parse(request.params.id);
    const current = await getRecord('organisations', organisationId);
    const input = organisationDetailsSchema.partial()
      .refine(value => Object.keys(value).length > 0, { message: 'At least one pharmacy detail must be supplied.' })
      .parse(request.body);
    if (input.status !== undefined && input.status !== current.status && ['intake_live', 'live'].includes(input.status)) {
      throw new HttpError(409, 'Use the audited intake or full go-live action to activate this pharmacy.', 'ACTIVATION_ACTION_REQUIRED');
    }
    const changedFields = Object.keys(input);
    const requestedPaymentRoute = input.defaultPaymentRoute ?? (input.worldpayEnabled === undefined ? undefined : input.worldpayEnabled ? 'worldpay' : 'manual');
    if (requestedPaymentRoute === 'worldpay') {
      const connection = await firestore.collection('integrationConnections').doc(`${organisationId}--worldpay`).get();
      if (!connection.exists || connection.data()?.status !== 'connected') {
        throw new HttpError(409, 'Verify this pharmacy’s Worldpay connection before making it the default payment route.', 'WORLDPAY_VERIFICATION_REQUIRED');
      }
    }
    await firestore.collection('organisations').doc(organisationId).update({
      ...input,
      ...(requestedPaymentRoute ? {
        defaultPaymentRoute: requestedPaymentRoute,
        worldpayEnabled: requestedPaymentRoute === 'worldpay',
      } : {}),
      updatedAt: timestamp(),
      updatedBy: identity(request).uid,
    });
    invalidateCollectionCache('organisations', organisationId);
    invalidateCache('admin:organisations', 'referral:');
    const record = await getRecord('organisations', organisationId);
    await audit(request, 'organisation.updated', { organisationId, changedFields });
    response.json(record);
  } catch (error) { next(error); }
});

app.post('/v1/portal/admin/organisations/:id/logo/upload-url', requireRole('hhh_admin'), async (request, response, next) => {
  try {
    const organisationId = idSchema.parse(request.params.id);
    await getRecord('organisations', organisationId);
    const input = z.object({
      filename: z.string().trim().min(1).max(180),
      contentType: z.literal(EMAIL_LOGO_CONTENT_TYPE),
      sizeBytes: z.number().int().positive().max(MAX_EMAIL_LOGO_BYTES),
    }).parse(request.body);
    const storagePath = `pharmacy-branding/${organisationId}/email-logo-${randomUUID()}.png`;
    const [uploadUrl] = await storage.bucket().file(storagePath).getSignedUrl({
      version: 'v4',
      action: 'write',
      expires: Date.now() + 15 * 60 * 1000,
      contentType: EMAIL_LOGO_CONTENT_TYPE,
    });
    await audit(request, 'organisation.logo_upload_authorised', { organisationId, storagePath, sourceFilename: input.filename, sizeBytes: input.sizeBytes });
    response.json({ uploadUrl, storagePath, requiredHeaders: { 'Content-Type': EMAIL_LOGO_CONTENT_TYPE } });
  } catch (error) { next(error); }
});

app.post('/v1/portal/admin/organisations/:id/logo/complete', requireRole('hhh_admin'), async (request, response, next) => {
  try {
    const organisationId = idSchema.parse(request.params.id);
    const input = z.object({ storagePath: z.string().min(1).max(500) }).parse(request.body);
    const expectedPrefix = `pharmacy-branding/${organisationId}/email-logo-`;
    if (!input.storagePath.startsWith(expectedPrefix) || !input.storagePath.endsWith('.png')) {
      throw new HttpError(400, 'The logo upload path is invalid.', 'INVALID_LOGO_PATH');
    }
    const organisation = await getRecord('organisations', organisationId);
    const object = storage.bucket().file(input.storagePath);
    const [metadata] = await object.getMetadata();
    const actualSize = Number(metadata.size ?? 0);
    if (metadata.contentType !== EMAIL_LOGO_CONTENT_TYPE || actualSize <= 0 || actualSize > MAX_EMAIL_LOGO_BYTES) {
      await object.delete({ ignoreNotFound: true });
      throw new HttpError(400, 'The uploaded logo is not a valid email PNG.', 'INVALID_LOGO_FILE');
    }
    const [header] = await object.download({ start: 0, end: 23 });
    const pngSignature = header.length >= 24 && header.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
    const width = pngSignature ? header.readUInt32BE(16) : 0;
    const height = pngSignature ? header.readUInt32BE(20) : 0;
    if (!pngSignature || width !== EMAIL_LOGO_WIDTH || height !== EMAIL_LOGO_HEIGHT) {
      await object.delete({ ignoreNotFound: true });
      throw new HttpError(400, `Logos must be normalised to ${EMAIL_LOGO_WIDTH} × ${EMAIL_LOGO_HEIGHT} pixels.`, 'INVALID_LOGO_DIMENSIONS');
    }
    const updatedAt = timestamp();
    await firestore.collection('organisations').doc(organisationId).update({
      emailLogoStoragePath: input.storagePath,
      emailLogoContentType: EMAIL_LOGO_CONTENT_TYPE,
      emailLogoWidth: EMAIL_LOGO_WIDTH,
      emailLogoHeight: EMAIL_LOGO_HEIGHT,
      emailLogoUpdatedAt: updatedAt,
      updatedAt,
      updatedBy: identity(request).uid,
    });
    const previousPath = typeof organisation.emailLogoStoragePath === 'string' ? organisation.emailLogoStoragePath : '';
    if (previousPath && previousPath !== input.storagePath) await storage.bucket().file(previousPath).delete({ ignoreNotFound: true });
    invalidateCollectionCache('organisations', organisationId);
    invalidateCache('admin:organisations', 'referral:');
    await audit(request, 'organisation.logo_updated', { organisationId, storagePath: input.storagePath, width, height, sizeBytes: actualSize });
    response.json(await withEmailLogoUrl(await getRecord('organisations', organisationId)));
  } catch (error) { next(error); }
});

app.delete('/v1/portal/admin/organisations/:id/logo', requireRole('hhh_admin'), async (request, response, next) => {
  try {
    const organisationId = idSchema.parse(request.params.id);
    const organisation = await getRecord('organisations', organisationId);
    const storagePath = typeof organisation.emailLogoStoragePath === 'string' ? organisation.emailLogoStoragePath : '';
    if (storagePath) await storage.bucket().file(storagePath).delete({ ignoreNotFound: true });
    const updatedAt = timestamp();
    await firestore.collection('organisations').doc(organisationId).update({
      emailLogoStoragePath: null,
      emailLogoContentType: null,
      emailLogoWidth: null,
      emailLogoHeight: null,
      emailLogoUpdatedAt: null,
      updatedAt,
      updatedBy: identity(request).uid,
    });
    invalidateCollectionCache('organisations', organisationId);
    invalidateCache('admin:organisations', 'referral:');
    await audit(request, 'organisation.logo_removed', { organisationId, storagePath: storagePath || null });
    response.json(await withEmailLogoUrl(await getRecord('organisations', organisationId)));
  } catch (error) { next(error); }
});

app.get('/v1/portal/admin/staff', requireRole('hhh_admin'), async (request, response, next) => {
  try {
    const organisationId = idSchema.parse(request.query.organisationId);
    await getRecord('organisations', organisationId);
    const records = await cached(`admin:staff:${organisationId}`, 10_000, async () => {
      const snapshot = await firestore.collection('staffUsers').where('organisationId', '==', organisationId).limit(500).get();
      const staff = snapshot.docs
        .map(document => document.data())
        .filter(record => record.role === 'pharmacy_staff' && !record.deletedAt)
        .sort((a, b) => String(a.createdAt ?? '').localeCompare(String(b.createdAt ?? '')));
      const ownerUid = staff.find(record => record.contactRole === 'owner')?.id ?? staff[0]?.id;
      return staff.map(record => ({
        uid: record.id,
        email: record.email,
        displayName: record.displayName,
        role: 'pharmacy_staff',
        organisationId,
        contactRole: record.id === ownerUid ? 'owner' : 'staff',
        status: record.status ?? 'invited',
        createdAt: record.createdAt,
      }));
    });
    response.json(records);
  } catch (error) { next(error); }
});

const patientRegisterFiltersSchema = z.object({
  query: z.string().max(300).default(''),
  organisationId: z.union([idSchema, z.literal('all')]).default('all'),
  status: z.string().max(100).default('all'),
  from: z.iso.date().nullable().default(null),
  to: z.iso.date().nullable().default(null),
});

async function adminPatientRegister(input: z.infer<typeof patientRegisterFiltersSchema>) {
    const [patientSnapshot, submissionSnapshot, organisationSnapshot] = await Promise.all([
      firestore.collection('patients').limit(20_001).get(),
      firestore.collection('eligibilitySubmissions').limit(20_001).get(),
      firestore.collection('organisations').limit(500).get(),
    ]);
    if (patientSnapshot.size > 20_000 || submissionSnapshot.size > 20_000) {
      throw new HttpError(413, 'The patient register is too large for a single CSV export. Narrow the filters and try again.', 'EXPORT_SCOPE_TOO_LARGE');
    }
    const organisations = new Map(organisationSnapshot.docs.map(document => {
      const record = document.data();
      return [document.id, { name: String(record.name ?? ''), tradingName: String(record.tradingName ?? record.name ?? ''), gphcNumber: String(record.gphcNumber ?? '') }];
    }));
    type ExportRow = { id: string; name: string; email: string; mobile: string; dob: string; organisationId: string; pharmacyName: string; gphcNumber: string; stage: string; date: string | null };
    const records = new Map<string, ExportRow>();
    patientSnapshot.docs.forEach(document => {
      const record = document.data();
      const organisationId = String(record.organisationId ?? '');
      const email = String(record.email ?? '');
      if (!organisationId || !email) return;
      const organisation = organisations.get(organisationId);
      const status = record.status === 'active' ? 'HHH approved' : record.status === 'referred' ? 'Referred' : 'Suspended';
      records.set(`${organisationId}:${email.toLowerCase()}`, {
        id: document.id,
        name: `${String(record.firstName ?? '')} ${String(record.surname ?? '')}`.trim(),
        email,
        mobile: String(record.mobile ?? ''),
        dob: String(record.dob ?? ''),
        organisationId,
        pharmacyName: organisation?.tradingName ?? organisation?.name ?? 'Unknown pharmacy',
        gphcNumber: organisation?.gphcNumber ?? '',
        stage: status,
        date: typeof record.updatedAt === 'string' ? record.updatedAt : typeof record.createdAt === 'string' ? record.createdAt : null,
      });
    });
    const submissionStatus: Record<string, string> = { new: 'New', reviewing: 'Under HHH review', approved: 'Approved', declined: 'Declined' };
    submissionSnapshot.docs.forEach(document => {
      const record = document.data();
      const organisationId = String(record.organisationId ?? '');
      const email = String(record.email ?? '');
      if (!organisationId || !email) return;
      const key = `${organisationId}:${email.toLowerCase()}`;
      const existing = records.get(key);
      const organisation = organisations.get(organisationId);
      records.set(key, {
        id: existing?.id ?? `sub-${document.id}`,
        name: `${String(record.firstName ?? '')} ${String(record.surname ?? '')}`.trim(),
        email,
        mobile: String(record.mobile ?? existing?.mobile ?? ''),
        dob: String(record.dob ?? existing?.dob ?? ''),
        organisationId,
        pharmacyName: organisation?.tradingName ?? organisation?.name ?? 'Unknown pharmacy',
        gphcNumber: organisation?.gphcNumber ?? '',
        stage: submissionStatus[String(record.status)] ?? 'New',
        date: typeof record.lastSubmittedAt === 'string' ? record.lastSubmittedAt : typeof record.createdAt === 'string' ? record.createdAt : null,
      });
    });
    const londonKey = (value: string | null) => {
      if (!value) return '';
      const date = new Date(value);
      if (Number.isNaN(date.getTime())) return '';
      const parts = new Intl.DateTimeFormat('en-GB', { timeZone: 'Europe/London', year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(date);
      const part = (type: Intl.DateTimeFormatPartTypes) => parts.find(item => item.type === type)?.value ?? '';
      return `${part('year')}-${part('month')}-${part('day')}`;
    };
    const query = input.query.trim().toLowerCase();
    const rows = [...records.values()].filter(record => {
      if (input.organisationId !== 'all' && record.organisationId !== input.organisationId) return false;
      if (input.status !== 'all' && record.stage !== input.status) return false;
      const date = londonKey(record.date);
      if (input.from && (!date || date < input.from)) return false;
      if (input.to && (!date || date > input.to)) return false;
      const formattedDob = /^\d{4}-\d{2}-\d{2}$/.test(record.dob) ? record.dob.split('-').reverse().join('/') : record.dob;
      return !query || `${record.name} ${record.email} ${record.mobile} ${record.dob} ${formattedDob} ${record.pharmacyName}`.toLowerCase().includes(query);
    }).sort((left, right) => left.name.localeCompare(right.name));
    const recordScopeHash = createHash('sha256').update(rows.map(row => `${row.organisationId}:${row.id}`).sort().join('|')).digest('hex');
    return { rows, resultCount: rows.length, generatedAt: timestamp(), recordScopeHash };
}

app.get('/v1/portal/admin/patient-register', requireRole('hhh_admin'), async (request, response, next) => {
  try {
    const input = patientRegisterFiltersSchema.parse({
      query: request.query.query,
      organisationId: request.query.organisationId,
      status: request.query.status,
      from: request.query.from ?? null,
      to: request.query.to ?? null,
    });
    response.json(await adminPatientRegister(input));
  } catch (error) { next(error); }
});

app.post('/v1/portal/admin/patient-exports', requireRole('hhh_admin'), async (request, response, next) => {
  try {
    const input = patientRegisterFiltersSchema.extend({ expectedScopeHash: z.string().regex(/^[a-f0-9]{64}$/) }).parse(request.body);
    const { expectedScopeHash, ...filters } = input;
    const result = await adminPatientRegister(filters);
    if (result.recordScopeHash !== expectedScopeHash) {
      throw new HttpError(409, 'The patient register changed after it was displayed. Refresh the results before exporting.', 'EXPORT_SCOPE_CHANGED');
    }
    await audit(request, 'patient_register.exported', { ...filters, resultCount: result.resultCount, recordScopeHash: result.recordScopeHash });
    response.json(result);
  } catch (error) { next(error); }
});

app.post('/v1/portal/admin/staff/invitations', requireRole('hhh_admin'), async (request, response, next) => {
  try {
    const input = z.object({
      email: z.email().transform(value => value.toLowerCase()),
      displayName: z.string().trim().min(1).max(200),
      role: z.enum(['hhh_admin', 'pharmacy_staff']),
      organisationId: idSchema.nullable(),
    }).refine(value => value.role === 'hhh_admin' ? value.organisationId === null : Boolean(value.organisationId), { message: 'Pharmacy staff require exactly one organisation.' }).parse(request.body);
    if (input.organisationId) await getRecord('organisations', input.organisationId);

    let user;
    let existingProfile: FirebaseFirestore.DocumentData | undefined;
    try {
      user = await auth.createUser({ email: input.email, displayName: input.displayName, emailVerified: false, disabled: false });
    } catch (error) {
      if (firebaseAuthErrorCode(error) !== 'auth/email-already-exists') throw error;
      user = await auth.getUserByEmail(input.email);
      const profileSnapshot = await firestore.collection('staffUsers').doc(user.uid).get();
      existingProfile = profileSnapshot.data();
      const existingRole = existingProfile?.role ?? user.customClaims?.role;
      const existingOrganisationId = existingProfile?.organisationId ?? user.customClaims?.organisationId;
      if (existingRole !== input.role || existingOrganisationId !== input.organisationId) {
        throw new HttpError(409, 'This email address already belongs to a different HHH account.', 'EMAIL_ALREADY_IN_USE');
      }
      if (existingProfile?.status === 'active') {
        throw new HttpError(409, 'This staff account is already active. Use password reset if they cannot sign in.', 'STAFF_ALREADY_ACTIVE');
      }
    }
    await auth.setCustomUserClaims(user.uid, { role: input.role, organisationId: input.organisationId });
    const createdAt = String(existingProfile?.createdAt ?? timestamp());
    let contactRole: 'owner' | 'staff' | null = null;

    if (input.role === 'pharmacy_staff' && input.organisationId) {
      const existingSnapshot = await firestore.collection('staffUsers').where('organisationId', '==', input.organisationId).limit(500).get();
      const existingStaff = existingSnapshot.docs
        .filter(document => document.data().role === 'pharmacy_staff')
        .sort((a, b) => String(a.data().createdAt ?? '').localeCompare(String(b.data().createdAt ?? '')));
      const organisationRef = firestore.collection('organisations').doc(input.organisationId);
      const staffRef = firestore.collection('staffUsers').doc(user.uid);
      await firestore.runTransaction(async transaction => {
        const organisation = await transaction.get(organisationRef);
        let ownerUid = organisation.data()?.primaryContactUid as string | undefined;
        if (!ownerUid) {
          ownerUid = existingStaff[0]?.id ?? user.uid;
          transaction.set(organisationRef, { primaryContactUid: ownerUid, updatedAt: createdAt }, { merge: true });
          if (existingStaff[0]) transaction.set(existingStaff[0].ref, { contactRole: 'owner', updatedAt: createdAt }, { merge: true });
        }
        contactRole = ownerUid === user.uid ? 'owner' : 'staff';
        transaction.set(staffRef, {
          id: user.uid,
          schemaVersion: 1,
          email: input.email,
          displayName: input.displayName,
          role: input.role,
          organisationId: input.organisationId,
          contactRole,
          status: 'invited',
          preferences: preferencesSchema.parse({ theme: 'light' }),
          createdAt,
          updatedAt: createdAt,
        }, { merge: true });
      });
    } else {
      await firestore.collection('staffUsers').doc(user.uid).set({
        id: user.uid, schemaVersion: 1, email: input.email, displayName: input.displayName, role: input.role,
        organisationId: input.organisationId, contactRole, status: 'invited', preferences: preferencesSchema.parse({ theme: 'light' }), createdAt, updatedAt: createdAt,
      });
    }

    if (input.organisationId) {
      invalidateCache(`admin:staff:${input.organisationId}`);
      invalidateCollectionCache('organisations', input.organisationId);
      invalidateCache('admin:organisations');
    }

    const firebaseLink = await auth.generatePasswordResetLink(input.email, {
      url: new URL('/reset-password', config.PORTAL_APP_ORIGIN).toString(),
      handleCodeInApp: true,
    });
    const actionLink = firstPartyPasswordResetLink(firebaseLink, config.PORTAL_APP_ORIGIN);
    await audit(request, 'staff.invited', { organisationId: input.organisationId, staffUid: user.uid, role: input.role, contactRole, deliveryMode: 'firebase_client' });
    response.status(201).json({ uid: user.uid, email: input.email, displayName: input.displayName, role: input.role, organisationId: input.organisationId, contactRole, status: 'invited', createdAt, invitationQueued: false, actionLink });
  } catch (error) { next(error); }
});

app.delete('/v1/portal/admin/staff/:uid', requireRole('hhh_admin'), async (request, response, next) => {
  try {
    const uid = idSchema.parse(request.params.uid);
    const profileRef = firestore.collection('staffUsers').doc(uid);
    const profileSnapshot = await profileRef.get();
    if (!profileSnapshot.exists) throw new HttpError(404, 'Staff account not found.', 'STAFF_NOT_FOUND');
    const profile = profileSnapshot.data()!;
    if (profile.role !== 'pharmacy_staff' || !profile.organisationId) throw new HttpError(409, 'Only pharmacy staff can be removed here.', 'INVALID_STAFF_ROLE');
    const [organisationSnapshot, staffSnapshot] = await Promise.all([
      firestore.collection('organisations').doc(profile.organisationId).get(),
      firestore.collection('staffUsers').where('organisationId', '==', profile.organisationId).limit(500).get(),
    ]);
    if (!organisationSnapshot.exists) throw new HttpError(404, 'Pharmacy account not found.', 'ORGANISATION_NOT_FOUND');
    const activeStaff = staffSnapshot.docs
      .map(document => document.data())
      .filter(record => record.role === 'pharmacy_staff' && !record.deletedAt)
      .sort((left, right) => String(left.createdAt ?? '').localeCompare(String(right.createdAt ?? '')));
    const canonicalOwnerUid = organisationSnapshot.data()?.primaryContactUid
      ?? activeStaff.find(record => record.contactRole === 'owner')?.id
      ?? activeStaff[0]?.id;
    if (profile.contactRole === 'owner' || canonicalOwnerUid === uid) throw new HttpError(409, 'The pharmacy owner account cannot be removed.', 'OWNER_ACCOUNT_PROTECTED');
    await auth.updateUser(uid, { disabled: true });
    await auth.revokeRefreshTokens(uid);
    await revokeUserSessions(uid, 'staff_disabled');
    await profileRef.update({ status: 'disabled', deletedAt: timestamp(), deletedBy: identity(request).uid, updatedAt: timestamp() });
    invalidateCache(`admin:staff:${profile.organisationId}`);
    await audit(request, 'staff.removed', { organisationId: profile.organisationId, staffUid: uid, retainedForAudit: true });
    response.status(204).send();
  } catch (error) { next(error); }
});

app.post('/v1/portal/admin/staff/:uid/mfa-reset', requireRole('hhh_admin'), async (request, response, next) => {
  try {
    const uid = idSchema.parse(request.params.uid);
    const input = z.object({ verifiedIdentity: z.literal(true), reason: z.string().trim().min(20).max(500) }).parse(request.body);
    const profileRef = firestore.collection('staffUsers').doc(uid);
    const profile = await profileRef.get();
    if (!profile.exists || profile.data()?.status !== 'active') throw new HttpError(404, 'Active staff account not found.', 'STAFF_NOT_FOUND');
    await auth.updateUser(uid, { multiFactor: { enrolledFactors: [] } });
    await auth.revokeRefreshTokens(uid);
    await revokeUserSessions(uid, 'mfa_reset');
    const resetAt = timestamp();
    await profileRef.set({ mfaResetAt: resetAt, mfaResetBy: identity(request).uid, updatedAt: resetAt }, { merge: true });
    await audit(request, 'staff.mfa_reset', { organisationId: profile.data()?.organisationId ?? null, staffUid: uid, identityVerificationRecorded: input.verifiedIdentity, reasonLength: input.reason.length });
    response.status(204).send();
  } catch (error) { next(error); }
});

app.use((error: unknown, request: Request, response: Response, _next: NextFunction) => {
  if ((request as Request & { securityDenial?: string }).securityDenial === 'tenant_mismatch') void securityEvent(request, 'auth.tenant_mismatch');
  if (error instanceof z.ZodError) return response.status(400).json({ code: 'VALIDATION_ERROR', message: 'The request data is invalid.', issues: error.issues });
  if (error instanceof HttpError) {
    if (error instanceof CuraleafRequestError) {
      if (error.retryAfterSeconds !== null) response.setHeader('Retry-After', String(error.retryAfterSeconds));
      for (const [name, value] of Object.entries(error.rateLimit)) response.setHeader(name, value);
    }
    return response.status(error.status).json({ code: error.code, message: error.message, reconciliationRequired: error instanceof CuraleafRequestError ? error.ambiguousWrite : undefined });
  }
  console.error('Unhandled API error', { requestId: request.get('x-request-id') ?? null, errorType: error instanceof Error ? error.name : 'unknown' });
  response.status(500).json({ code: 'INTERNAL_ERROR', message: 'Internal server error.' });
});
