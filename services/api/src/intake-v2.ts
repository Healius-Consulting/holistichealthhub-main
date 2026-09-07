import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { Router, type NextFunction, type Request, type Response } from 'express';
import { rateLimit } from 'express-rate-limit';
import JSZip from 'jszip';
import QRCode from 'qrcode';
import { z } from 'zod';
import { audit } from './audit.js';
import { identity, requireRole, tenantFor } from './auth.js';
import { invalidateCache } from './cache.js';
import { config } from './config.js';
import { appCheck, firestore, storage } from './firebase.js';
import { canAcceptPublicIntake, isExplicitCuraleafTestAccount } from './go-live.js';
import { HttpError, nowIso } from './http.js';
import { completeReferral } from './patient-finance.js';
import { protectedLegacyTokenPolicy } from './tokens.js';

type RecordMap = Record<string, unknown> & { id: string };
type DirectoryProfile = RecordMap & {
  organisationId: string;
  tradingName: string;
  gphcNumber: string;
  postcode: string;
  latitude: number;
  longitude: number;
  lifecycle: 'draft' | 'ready_for_review' | 'published' | 'paused' | 'unpublished';
  intakeState: 'available' | 'limited' | 'full';
  acceptingNewPatients: boolean;
};

const idSchema = z.string().min(1).max(128).regex(/^[A-Za-z0-9_-]+$/);
const tokenSchema = z.string().trim().min(12).max(160).regex(/^[A-Za-z0-9_-]+$/);
const assignmentStatusSchema = z.enum(['awaiting_hhh_allocation', 'provisional', 'reassignment_pending', 'confirmed']);
const followUpStatusSchema = z.enum(['not_started', 'due', 'attempted', 'in_progress', 'completed', 'unable_to_contact']);
const reviewStatusSchema = z.enum(['not_opened', 'opened', 'reviewing', 'eligible', 'ineligible', 'needs_information', 'completed']);
const outcomeStatusSchema = z.enum(['open', 'completed', 'declined', 'withdrawn']);
const conditionIdSchema = z.string().trim().min(1).max(80);
const tokenHash = (token: string) => createHash('sha256').update(token).digest('hex');
const consentText = {
  'general-public-v2.0': 'I consent to Holistic Health Hub reviewing this eligibility application and, when I select a pharmacy, sharing it provisionally with that pharmacy. HHH may confirm a different suitable pharmacy after speaking with me.',
  'pharmacy-qr-v2.0': 'I consent to Holistic Health Hub reviewing this eligibility application and sharing it with the pharmacy named on this referral page. HHH may reassign it to another suitable pharmacy after speaking with me.',
  'general-public-v2.1': 'I consent to Holistic Health Hub reviewing this eligibility application. My selected pharmacy is a preference only. HHH will share my application with a pharmacy only after completing its referral review and confirming the destination with me.',
  'pharmacy-qr-v2.1': 'I consent to Holistic Health Hub reviewing this eligibility application and, only after HHH completes its referral review, sharing it with the pharmacy named on this referral page. The pharmacy destination for this dedicated link will not be changed.',
} as const;

const publicLimiter = rateLimit({ windowMs: 15 * 60_000, limit: 45, standardHeaders: true, legacyHeaders: false });
const publicSubmissionLimiter = rateLimit({ windowMs: 60 * 60_000, limit: 12, standardHeaders: true, legacyHeaders: false });

function record(document: FirebaseFirestore.DocumentSnapshot): RecordMap | null {
  return document.exists ? { id: document.id, ...document.data()! } : null;
}

export function normaliseUkPostcode(value: string) {
  const compact = value.toUpperCase().replace(/[^A-Z0-9]/g, '');
  if (!/^(GIR0AA|(?:[A-Z][0-9][0-9A-Z]?|[A-Z][A-Z][0-9][0-9A-Z]?)[0-9][A-Z]{2})$/.test(compact)) {
    throw new HttpError(400, 'Enter a valid UK postcode.', 'INVALID_POSTCODE');
  }
  return `${compact.slice(0, -3)} ${compact.slice(-3)}`;
}

export function haversineMiles(from: { latitude: number; longitude: number }, to: { latitude: number; longitude: number }) {
  const radians = (degrees: number) => degrees * Math.PI / 180;
  const earthRadiusMiles = 3958.7613;
  const latitudeDelta = radians(to.latitude - from.latitude);
  const longitudeDelta = radians(to.longitude - from.longitude);
  const a = Math.sin(latitudeDelta / 2) ** 2
    + Math.cos(radians(from.latitude)) * Math.cos(radians(to.latitude)) * Math.sin(longitudeDelta / 2) ** 2;
  return earthRadiusMiles * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

export function topFiveNearest<T extends { latitude: number; longitude: number }>(origin: { latitude: number; longitude: number }, candidates: T[]) {
  return candidates.map(candidate => ({ profile: candidate, miles: haversineMiles(origin, candidate) }))
    .sort((left, right) => left.miles - right.miles)
    .slice(0, 5);
}

export function expectedConsentVersion(sourceType: 'general_hhh_website' | 'future_pharmacy_qr') {
  return sourceType === 'general_hhh_website' ? 'general-public-v2.1' as const : 'pharmacy-qr-v2.1' as const;
}

export function isDedicatedSourceType(sourceType: unknown) {
  return sourceType === 'future_pharmacy_qr' || sourceType === 'legacy_pharmacy_qr';
}

export function canPharmacyAccessCase(recordValue: Record<string, unknown>, isV2 = true) {
  // New HHH-first cases are activated directly as pharmacy patients and never
  // enter a pharmacy eligibility-review queue. Legacy records keep their
  // established compatibility behaviour.
  void recordValue;
  return !isV2;
}

export function assignmentEventFields(input: {
  caseId: string; previousOrganisationId: string | null; newOrganisationId: string | null; action: string; reasonCode: string;
  actorUid: string | null; occurredAt: string; pharmacyReviewStarted: boolean; previousAssignmentVersion: number; newAssignmentVersion: number; notePresent: boolean;
}) {
  return { schemaVersion: 2, ...input };
}

export function pharmacyDisplayStatus(recordValue: Record<string, unknown>) {
  const assignment = assignmentStatusSchema.catch('awaiting_hhh_allocation').parse(recordValue.assignmentStatus);
  const review = reviewStatusSchema.catch('not_opened').parse(recordValue.pharmacyReviewStatus);
  if ((recordValue.schemaVersion === 2 || recordValue.intakeVersion === 'v2') && recordValue.pharmacyAccessStatus !== 'activated') return 'Awaiting HHH referral';
  if (assignment !== 'confirmed') return 'Pending HHH allocation review';
  if (review === 'not_opened') return 'Assignment confirmed';
  return 'Under pharmacy review';
}

function isDirectoryReady(profile: Record<string, unknown>, organisation: Record<string, unknown>, requirePublished = true) {
  return (!requirePublished || profile.lifecycle === 'published')
    && profile.lifecycle !== 'paused'
    && profile.intakeState !== 'full'
    && profile.acceptingNewPatients === true
    && typeof profile.latitude === 'number'
    && typeof profile.longitude === 'number'
    && organisation.status === 'live'
    && !isExplicitCuraleafTestAccount(organisation)
    && profile.realClassification === 'real'
    && profile.gdprEvidenceState === 'verified'
    && profile.curaleafIntegrationState === 'production_verified';
}

export function directoryPublicationIssues(profile: Record<string, unknown>, organisation: Record<string, unknown>) {
  const issues: string[] = [];
  if (isExplicitCuraleafTestAccount(organisation) || profile.realClassification !== 'real') issues.push('TRAINING_OR_NON_REAL_ORGANISATION');
  if (organisation.status !== 'live') issues.push('ORGANISATION_NOT_LIVE');
  if (profile.acceptingNewPatients !== true) issues.push('NOT_ACCEPTING_NEW_PATIENTS');
  if (profile.intakeState === 'full') issues.push('INTAKE_FULL');
  if (typeof profile.latitude !== 'number' || typeof profile.longitude !== 'number') issues.push('COORDINATES_REQUIRED');
  if (profile.gdprEvidenceState !== 'verified') issues.push('GDPR_EVIDENCE_REQUIRED');
  if (profile.curaleafIntegrationState !== 'production_verified') issues.push('PRODUCTION_INTEGRATION_REQUIRED');
  for (const field of ['tradingName', 'gphcNumber', 'addressLine1', 'postcode', 'locality', 'publicEmail']) {
    if (!String(profile[field] ?? '').trim()) issues.push(`MISSING_${field.replace(/([A-Z])/g, '_$1').toUpperCase()}`);
  }
  return issues;
}

async function requirePublicAppCheck(request: Request, _response: Response, next: NextFunction) {
  if (config.REQUIRE_APP_CHECK !== 'true') return next();
  try {
    const token = request.get('x-firebase-appcheck');
    if (!token) throw new Error('missing');
    await appCheck.verifyToken(token);
    next();
  } catch {
    next(new HttpError(401, 'App attestation is required.', 'APP_CHECK_REQUIRED'));
  }
}

type GeocodeResult = { status: 'matched'; postcode: string; latitude: number; longitude: number; provider: 'postcodes_io' }
  | { status: 'not_found' | 'provider_unavailable'; postcode: string; provider: 'postcodes_io' };

let postcodeProviderFailures = 0;
let postcodeProviderOpenUntil = 0;

function recordProviderMetric(outcome: GeocodeResult['status'], startedAt: number, attempts: number) {
  void firestore.collection('providerMetrics').add({ provider: 'postcodes_io', operation: 'postcode_geocode', outcome, durationMs: Date.now() - startedAt, attempts, occurredAt: nowIso() }).catch(() => undefined);
}

export function isNorthernIrelandPostcode(postcodeValue: string) {
  return normaliseUkPostcode(postcodeValue).startsWith('BT');
}

async function geocodePostcode(postcodeValue: string): Promise<GeocodeResult> {
  const startedAt = Date.now();
  const postcode = normaliseUkPostcode(postcodeValue);
  // Commercial use of the Northern Ireland postcode dataset requires a separate
  // licence. Keep BT cases on the valid HHH manual-allocation path until approved.
  if (isNorthernIrelandPostcode(postcode) || postcodeProviderOpenUntil > Date.now()) {
    const result = { status: 'provider_unavailable' as const, postcode, provider: 'postcodes_io' as const };
    recordProviderMetric(result.status, startedAt, 0);
    return result;
  }
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 2_500);
    try {
      const response = await fetch('https://api.postcodes.io/postcodes?filter=postcode,longitude,latitude', {
        method: 'POST',
        headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
        body: JSON.stringify({ postcodes: [postcode] }),
        signal: controller.signal,
      });
      if (response.status === 404) {
        const result = { status: 'not_found' as const, postcode, provider: 'postcodes_io' as const };
        postcodeProviderFailures = 0;
        recordProviderMetric(result.status, startedAt, attempt + 1);
        return result;
      }
      if (!response.ok) throw new Error(`provider_${response.status}`);
      const payload = await response.json() as {
        result?: Array<{ query?: string; result?: { postcode?: string; latitude?: number; longitude?: number } | null }>;
      };
      const result = payload.result?.[0]?.result;
      if (!result || typeof result.latitude !== 'number' || typeof result.longitude !== 'number') {
        const outcome = { status: 'not_found' as const, postcode, provider: 'postcodes_io' as const };
        postcodeProviderFailures = 0;
        recordProviderMetric(outcome.status, startedAt, attempt + 1);
        return outcome;
      }
      const outcome = {
        status: 'matched' as const,
        postcode: normaliseUkPostcode(result.postcode ?? postcode),
        latitude: result.latitude,
        longitude: result.longitude,
        provider: 'postcodes_io' as const,
      };
      postcodeProviderFailures = 0;
      recordProviderMetric(outcome.status, startedAt, attempt + 1);
      return outcome;
    } catch {
      if (attempt === 1) {
        postcodeProviderFailures += 1;
        if (postcodeProviderFailures >= 5) postcodeProviderOpenUntil = Date.now() + 30_000;
        const result = { status: 'provider_unavailable' as const, postcode, provider: 'postcodes_io' as const };
        recordProviderMetric(result.status, startedAt, attempt + 1);
        return result;
      }
    } finally {
      clearTimeout(timeout);
    }
  }
  const result = { status: 'provider_unavailable' as const, postcode, provider: 'postcodes_io' as const };
  recordProviderMetric(result.status, startedAt, 2);
  return result;
}

async function eligibleDirectoryProfiles() {
  const snapshot = await firestore.collection('pharmacyDirectoryProfiles').where('lifecycle', '==', 'published').limit(500).get();
  const profiles = snapshot.docs.map(record).filter((item): item is RecordMap => Boolean(item));
  const organisations = new Map<string, RecordMap>();
  await Promise.all(profiles.map(async profile => {
    const organisationId = String(profile.organisationId ?? profile.id);
    const organisation = record(await firestore.collection('organisations').doc(organisationId).get());
    if (organisation) organisations.set(organisationId, organisation);
  }));
  return profiles.filter(profile => {
    const organisation = organisations.get(String(profile.organisationId ?? profile.id));
    return organisation && isDirectoryReady(profile, organisation, true);
  }) as DirectoryProfile[];
}

async function validatedDirectoryReadiness(organisation: RecordMap) {
  let gdprRecord: Record<string, unknown> = organisation;
  if (typeof organisation.orgId === 'string') {
    const company = record(await firestore.collection('companies').doc(organisation.orgId).get());
    if (company) gdprRecord = company;
  } else if (typeof organisation.companyNumber === 'string' && organisation.companyNumber) {
    const company = await firestore.collection('companies').where('companyNumber', '==', organisation.companyNumber).limit(1).get();
    if (!company.empty) gdprRecord = company.docs[0]!.data();
  }
  const gdprVerified = gdprRecord.gdprConfirmed === true
    && (gdprRecord.gdprEvidenceMethod === 'manual_receipt' || /^https:\/\/(drive|docs)\.google\.com\//.test(String(gdprRecord.gdprDocUrl ?? '')));
  const curaleaf = organisation.curaleafLiveValidation as Record<string, unknown> | undefined;
  const productionVerified = ['production', 'live'].includes(String(curaleaf?.environment ?? '').toLowerCase())
    && typeof curaleaf?.validatedAt === 'string'
    && typeof organisation.curaleafLiveSecretStoredAt === 'string';
  return { gdprEvidenceState: gdprVerified ? 'verified' as const : 'missing' as const, curaleafIntegrationState: productionVerified ? 'production_verified' as const : 'not_checked' as const };
}

async function resolveReferralToken(rawToken: string) {
  const hash = tokenHash(rawToken);
  const protectedPolicy = protectedLegacyTokenPolicy(hash);
  const snapshot = await firestore.collection('referralTokens').where('tokenHash', '==', hash).where('revokedAt', '==', null).limit(1).get();
  const token = snapshot.docs[0] ? record(snapshot.docs[0]) : null;
  if (!token) throw new HttpError(404, 'Pharmacy link not found.', 'NOT_FOUND');
  const organisationId = String(token.organisationId ?? '');
  if (protectedPolicy && protectedPolicy.organisationId !== organisationId) throw new HttpError(404, 'Pharmacy link not found.', 'NOT_FOUND');
  const organisation = record(await firestore.collection('organisations').doc(organisationId).get());
  if (!organisation || !['intake_live', 'live'].includes(String(organisation.status))) throw new HttpError(404, 'Pharmacy link not found.', 'NOT_FOUND');
  const profile = record(await firestore.collection('pharmacyDirectoryProfiles').doc(organisationId).get());
  const profileReady = Boolean(profile && isDirectoryReady(profile, organisation, true));
  const stableV2TokenReady = token.intakeVersion === 'v2'
    && profile?.referralTokenId === token.id
    && profile.qrState === 'active'
    && profileReady;
  const protectedFixedSourceReady = protectedPolicy?.migrationMode === 'v2_fixed_source'
    && canAcceptPublicIntake(organisation);
  const future = stableV2TokenReady || protectedFixedSourceReady;
  return {
    token,
    organisation,
    profile,
    fixedSource: stableV2TokenReady || protectedFixedSourceReady,
    intakeVersion: future ? 'v2' as const : 'v1' as const,
  };
}

const answersSchema = z.object({
  firstName: z.string().trim().min(1).max(100),
  surname: z.string().trim().min(1).max(100),
  dob: z.iso.date(),
  mobile: z.string().trim().min(7).max(30),
  email: z.email().max(254),
  postcode: z.string().trim().min(2).max(16),
  conditions: z.array(conditionIdSchema).min(1).max(3),
  primaryCondition: conditionIdSchema,
  tried2: z.boolean(),
  psychExclusion: z.boolean(),
  consentReferral: z.literal(true),
  consentShare: z.literal(true),
  marketing: z.boolean().default(false),
  heardAbout: z.string().trim().max(100).default(''),
  consentVersion: z.enum(['general-public-v2.0', 'pharmacy-qr-v2.0', 'general-public-v2.1', 'pharmacy-qr-v2.1']),
  idempotencyKey: z.string().uuid(),
});
const intakeSchema = z.discriminatedUnion('type', [
  answersSchema.extend({ type: z.literal('general_hhh_website'), searchId: idSchema, selectedDirectoryProfileId: idSchema.nullable() }),
  answersSchema.extend({ type: z.literal('future_pharmacy_qr'), referralToken: tokenSchema }),
]).refine(input => input.conditions.includes(input.primaryCondition), { path: ['primaryCondition'], message: 'Primary condition must be selected.' })
  .refine(input => input.consentVersion === expectedConsentVersion(input.type)
    || input.type === 'general_hhh_website' && input.consentVersion === 'general-public-v2.0'
    || input.type === 'future_pharmacy_qr' && input.consentVersion === 'pharmacy-qr-v2.0',
  { path: ['consentVersion'], message: 'Consent version does not match intake source.' });

function caseReference() {
  const day = nowIso().slice(0, 10).replaceAll('-', '');
  return `HHH-${day}-${randomBytes(4).toString('hex').toUpperCase()}`;
}

async function effectiveCase(caseId: string) {
  const submission = record(await firestore.collection('eligibilitySubmissions').doc(caseId).get());
  if (!submission) throw new HttpError(404, 'The requested record was not found.', 'NOT_FOUND');
  const overlay = record(await firestore.collection('eligibilityAllocationOverlays').doc(caseId).get());
  const isV2 = submission.schemaVersion === 2 || submission.intakeVersion === 'v2';
  const assignedOrganisationId = isV2
    ? (typeof submission.assignedOrganisationId === 'string' ? submission.assignedOrganisationId : null)
    : (typeof overlay?.assignedOrganisationId === 'string' ? overlay.assignedOrganisationId : String(submission.organisationId ?? ''));
  const assignmentStatus = isV2
    ? assignmentStatusSchema.catch('awaiting_hhh_allocation').parse(submission.assignmentStatus)
    : assignmentStatusSchema.catch('confirmed').parse(overlay?.assignmentStatus ?? 'confirmed');
  return { submission, overlay, isV2, assignedOrganisationId, assignmentStatus, workflow: isV2 ? submission : (overlay ?? submission) };
}

function pharmacySummary(caseId: string, item: Awaited<ReturnType<typeof effectiveCase>>) {
  const source = item.submission;
  return {
    id: caseId,
    caseReference: String(source.caseReference ?? `LEGACY-${caseId.slice(-8).toUpperCase()}`),
    patientDisplayName: `${String(source.firstName ?? '').trim()} ${String(source.surname ?? '').trim()}`.trim(),
    submittedAt: String(source.submittedAt ?? source.createdAt ?? source.lastSubmittedAt ?? ''),
    displayStatus: pharmacyDisplayStatus({ ...source, ...item.workflow, assignmentStatus: item.assignmentStatus }),
    assignmentStatus: item.assignmentStatus,
    pharmacyReviewStatus: String(item.workflow.pharmacyReviewStatus ?? (source.status === 'new' ? 'not_opened' : 'reviewing')),
    outcomeStatus: String(item.workflow.outcomeStatus ?? 'open'),
    version: Number(item.workflow.assignmentVersion ?? 0),
    legacy: !item.isV2,
  };
}

function adminProjection(caseId: string, item: Awaited<ReturnType<typeof effectiveCase>>) {
  const source = item.submission;
  const workflow = item.workflow;
  return {
    ...pharmacySummary(caseId, item),
    sourceType: String(source.sourceType ?? 'legacy_pharmacy_qr'),
    sourceOrganisationId: source.sourceOrganisationId ?? source.organisationId ?? null,
    assignedOrganisationId: item.assignedOrganisationId,
    firstName: source.firstName,
    surname: source.surname,
    mobile: source.mobile,
    email: source.email,
    postcode: source.postcode,
    locationPreferenceOrganisationId: source.locationPreferenceOrganisationId ?? null,
    locationPreferenceDistanceMetres: source.locationPreferenceDistanceMetres ?? null,
    followUpStatus: workflow.followUpStatus ?? 'not_started',
    attemptCount: workflow.followUpAttemptCount ?? 0,
    nextFollowUpAt: workflow.nextFollowUpAt ?? null,
    pharmacyOpened: !['not_opened', undefined].includes(workflow.pharmacyReviewStatus as undefined),
    pharmacyActivated: !item.isV2 || workflow.pharmacyAccessStatus === 'activated',
    destinationLocked: isDedicatedSourceType(source.sourceType ?? 'legacy_pharmacy_qr'),
    requirements: workflow.allocationRequirements ?? {},
  };
}

function pharmacyDetail(item: Awaited<ReturnType<typeof effectiveCase>>) {
  const source = item.submission;
  return {
    ...pharmacySummary(source.id, item),
    firstName: source.firstName,
    surname: source.surname,
    dob: source.dob,
    mobile: source.mobile,
    email: source.email,
    postcode: source.postcode,
    conditions: source.conditions ?? [],
    primaryCondition: source.primaryCondition ?? null,
    triedTwoTreatments: source.triedTwoTreatments,
    psychosisExclusion: source.psychosisExclusion,
    marketingConsent: source.marketingConsent,
    reviewNotes: item.workflow.pharmacyReviewNotes ?? null,
    assignmentStatus: item.assignmentStatus,
    pharmacyReviewStatus: item.workflow.pharmacyReviewStatus ?? 'not_opened',
    outcomeStatus: item.workflow.outcomeStatus ?? 'open',
  };
}

const publicRouter = Router();
publicRouter.use(publicLimiter, requirePublicAppCheck);

export function projectDirectoryMapPositions(
  origin: { latitude: number; longitude: number },
  destinations: Array<{ latitude: number; longitude: number }>,
) {
  const vectors = destinations.map(destination => {
    const averageLatitudeRadians = ((origin.latitude + destination.latitude) / 2) * Math.PI / 180;
    return {
      x: (destination.longitude - origin.longitude) * Math.cos(averageLatitudeRadians),
      y: destination.latitude - origin.latitude,
    };
  });
  const furthest = Math.max(0.0001, ...vectors.map(vector => Math.hypot(vector.x, vector.y)));
  return vectors.map(vector => ({
    xPercent: Math.round((50 + (vector.x / furthest) * 36) * 10) / 10,
    yPercent: Math.round((50 - (vector.y / furthest) * 36) * 10) / 10,
  }));
}

publicRouter.post('/postcode-searches', async (request, response, next) => {
  try {
    if (config.V2_PUBLIC_INTAKE_ENABLED !== 'true') throw new HttpError(404, 'Not found.', 'NOT_FOUND');
    const { postcode } = z.object({ postcode: z.string().trim().min(2).max(16) }).parse(request.body);
    const geocode = await geocodePostcode(postcode);
    const profiles = geocode.status === 'matched' ? await eligibleDirectoryProfiles() : [];
    const matches = geocode.status === 'matched'
      ? topFiveNearest(geocode, profiles)
      : [];
    const status = geocode.status !== 'matched' ? geocode.status : matches.length ? 'matched' : 'no_match';
    const searchId = randomUUID();
    const createdAt = nowIso();
    const expiresAt = new Date(Date.now() + 30 * 60_000).toISOString();
    await firestore.collection('postcodeSearchSessions').doc(searchId).set({
      schemaVersion: 2, postcode: geocode.postcode, status, provider: geocode.provider,
      latitude: geocode.status === 'matched' ? geocode.latitude : null,
      longitude: geocode.status === 'matched' ? geocode.longitude : null,
      resultProfileIds: matches.map(match => match.profile.id), createdAt, expiresAt,
    });
    const mapPositions = geocode.status === 'matched'
      ? projectDirectoryMapPositions(geocode, matches.map(match => match.profile))
      : [];
    response.json({ searchId, expiresAt, status, postcode: geocode.postcode, mapOrigin: { xPercent: 50, yPercent: 50 }, results: matches.map(({ profile, miles }, index) => ({
      id: profile.id,
      tradingName: profile.tradingName,
      gphcNumber: profile.gphcNumber,
      addressSummary: [profile.addressLine1, profile.locality, profile.postcode].filter(Boolean).join(', '),
      approximateMiles: Math.round(miles * 10) / 10,
      deliveryCapability: profile.deliveryCapability ?? 'none',
      collectionAvailable: profile.collectionAvailable === true,
      deliverySummary: profile.deliverySummary ?? null,
      intakeAvailability: profile.intakeState,
      mapPosition: mapPositions[index],
    })) });
  } catch (error) { next(error); }
});

publicRouter.post('/referral-tokens/resolve', async (request, response, next) => {
  try {
    const { token } = z.object({ token: tokenSchema }).parse(request.body);
    const resolved = await resolveReferralToken(token);
    response.json({
      type: resolved.intakeVersion === 'v2' ? 'future_pharmacy_qr' : 'legacy_pharmacy_qr',
      intakeVersion: resolved.intakeVersion,
      pharmacy: {
        id: resolved.organisation.id,
        name: resolved.organisation.name,
        tradingName: resolved.profile?.tradingName ?? resolved.organisation.tradingName,
        logoText: resolved.organisation.logoText,
        gphcNumber: resolved.profile?.gphcNumber ?? resolved.organisation.gphcNumber,
        superintendent: resolved.organisation.superintendent,
        address: resolved.profile ? [resolved.profile.addressLine1, resolved.profile.locality, resolved.profile.postcode].filter(Boolean).join(', ') : resolved.organisation.address,
        primaryColour: resolved.organisation.primaryColour,
      },
    });
  } catch (error) { next(error); }
});

publicRouter.post('/intakes', publicSubmissionLimiter, async (request, response, next) => {
  try {
    if (config.V2_PUBLIC_INTAKE_ENABLED !== 'true') throw new HttpError(404, 'Not found.', 'NOT_FOUND');
    const input = intakeSchema.parse(request.body);
    const existing = await firestore.collection('eligibilitySubmissions').where('idempotencyKeyHash', '==', tokenHash(input.idempotencyKey)).limit(1).get();
    if (!existing.empty) {
      const item = record(existing.docs[0]!)!;
      return response.json({ caseReference: item.caseReference, submittedAt: item.submittedAt, assignmentStatus: item.assignmentStatus, provisionalPharmacyName: item.provisionalPharmacyName ?? null });
    }

    let sourceOrganisationId: string | null = null;
    let sourceReferralTokenId: string | null = null;
    let assignedOrganisationId: string | null = null;
    let locationPreferenceOrganisationId: string | null = null;
    let locationPreferenceDistanceMetres: number | null = null;
    let postcodeLookupStatus: string;
    let postcodeProvider: GeocodeResult['provider'] = 'postcodes_io';
    let postcodeLatitude: number | null = null;
    let postcodeLongitude: number | null = null;
    let provisionalPharmacyName: string | null = null;
    let warning: 'SELECTED_PHARMACY_UNAVAILABLE' | null = null;
    let fixedSource = false;

    if (input.type === 'future_pharmacy_qr') {
      const resolved = await resolveReferralToken(input.referralToken);
      if (resolved.intakeVersion !== 'v2' || !resolved.fixedSource) throw new HttpError(409, 'This link requires the legacy eligibility form.', 'LEGACY_INTAKE_REQUIRED');
      sourceOrganisationId = resolved.organisation.id;
      sourceReferralTokenId = resolved.token.id;
      assignedOrganisationId = resolved.organisation.id;
      provisionalPharmacyName = String(resolved.profile?.tradingName ?? resolved.organisation.tradingName);
      fixedSource = true;
      const geocode = await geocodePostcode(input.postcode);
      postcodeLookupStatus = geocode.status;
      postcodeProvider = geocode.provider;
      if (geocode.status === 'matched') { postcodeLatitude = geocode.latitude; postcodeLongitude = geocode.longitude; }
    } else {
      const search = record(await firestore.collection('postcodeSearchSessions').doc(input.searchId).get());
      if (!search || Date.parse(String(search.expiresAt ?? '')) <= Date.now()) throw new HttpError(409, 'The postcode search has expired. Search again.', 'SEARCH_EXPIRED');
      if (normaliseUkPostcode(input.postcode) !== search.postcode) throw new HttpError(409, 'The postcode changed. Search again.', 'SEARCH_POSTCODE_MISMATCH');
      postcodeLookupStatus = String(search.status);
      postcodeLatitude = typeof search.latitude === 'number' ? search.latitude : null;
      postcodeLongitude = typeof search.longitude === 'number' ? search.longitude : null;
      if (input.selectedDirectoryProfileId) {
        if (!Array.isArray(search.resultProfileIds) || !search.resultProfileIds.includes(input.selectedDirectoryProfileId)) throw new HttpError(400, 'Select a pharmacy from the current search.', 'INVALID_SELECTION');
        locationPreferenceOrganisationId = input.selectedDirectoryProfileId;
        const profile = record(await firestore.collection('pharmacyDirectoryProfiles').doc(input.selectedDirectoryProfileId).get());
        const organisation = profile ? record(await firestore.collection('organisations').doc(String(profile.organisationId ?? profile.id)).get()) : null;
        if (profile && organisation && isDirectoryReady(profile, organisation, true)) {
          provisionalPharmacyName = String(profile.tradingName);
          if (postcodeLatitude !== null && postcodeLongitude !== null) {
            locationPreferenceDistanceMetres = Math.round(haversineMiles({ latitude: postcodeLatitude, longitude: postcodeLongitude }, profile as DirectoryProfile) * 1609.344);
          }
        } else warning = 'SELECTED_PHARMACY_UNAVAILABLE';
      }
    }

    const submittedAt = nowIso();
    const reference = caseReference();
    const caseId = randomUUID();
    const assignmentStatus = 'awaiting_hhh_allocation';
    const emailHash = tokenHash(input.email.trim().toLowerCase());
    const duplicates = await firestore.collection('eligibilitySubmissions').where('emailHash', '==', emailHash).limit(20).get();
    const consentRendered = consentText[input.consentVersion].replace('the pharmacy named on this referral page', provisionalPharmacyName ?? 'the pharmacy named on this referral page');
    const fields = {
      schemaVersion: 2,
      intakeVersion: 'v2',
      caseReference: reference,
      sourceType: input.type,
      sourceOrganisationId,
      sourceReferralTokenId,
      locationPreferenceOrganisationId,
      locationPreferenceDistanceMetres,
      assignedOrganisationId,
      organisationId: assignedOrganisationId,
      assignmentStatus,
      pharmacyAccessStatus: 'withheld',
      destinationLocked: fixedSource,
      followUpStatus: 'not_started',
      pharmacyReviewStatus: 'not_opened',
      outcomeStatus: 'open',
      assignmentVersion: 1,
      operationalStartedAt: null,
      firstName: input.firstName,
      surname: input.surname,
      dob: input.dob,
      mobile: input.mobile,
      email: input.email.toLowerCase(),
      emailHash,
      postcode: normaliseUkPostcode(input.postcode),
      postcodeLatitude,
      postcodeLongitude,
      postcodeProvider,
      postcodeLookupStatus,
      postcodeGeocodedAt: postcodeLatitude !== null ? submittedAt : null,
      conditions: input.conditions,
      primaryCondition: input.primaryCondition,
      triedTwoTreatments: input.tried2,
      psychosisExclusion: input.psychExclusion,
      consentReferral: input.consentReferral,
      consentShare: input.consentShare,
      marketingConsent: input.marketing,
      source: input.heardAbout,
      consentVersion: input.consentVersion,
      consentCapturedAt: submittedAt,
      consentSourceType: input.type,
      consentDisplayedOrganisationId: sourceOrganisationId ?? locationPreferenceOrganisationId,
      consentTextHash: tokenHash(consentRendered),
      idempotencyKeyHash: tokenHash(input.idempotencyKey),
      possibleDuplicate: !duplicates.empty,
      duplicateIndicatorCount: duplicates.size,
      fixedSource,
      trainingSubmission: false,
      provisionalPharmacyName,
      submittedAt,
      createdAt: submittedAt,
      updatedAt: submittedAt,
    };
    await firestore.runTransaction(async transaction => {
      transaction.create(firestore.collection('eligibilitySubmissions').doc(caseId), fields);
      transaction.create(firestore.collection('eligibilityAssignmentEvents').doc(), assignmentEventFields({
        caseId, previousOrganisationId: null, newOrganisationId: assignedOrganisationId,
        action: fixedSource ? 'dedicated_intake_received_hhh_only' : 'general_intake_received_hhh_only', reasonCode: input.type,
        actorUid: null, occurredAt: submittedAt, pharmacyReviewStarted: false, previousAssignmentVersion: 0, newAssignmentVersion: 1, notePresent: false,
      }));
    });
    invalidateCache('list:eligibilitySubmissions:', `record:eligibilitySubmissions:${caseId}`);
    await audit(request, 'intake_v2.submitted', { recordId: caseId, sourceType: input.type, assigned: Boolean(assignedOrganisationId) });
    response.status(201).json({ caseReference: reference, submittedAt, assignmentStatus, provisionalPharmacyName, warning });
  } catch (error) { next(error); }
});

const portalRouter = Router();

async function adminQueue(source: 'general' | 'pharmacy') {
  const snapshot = await firestore.collection('eligibilitySubmissions').orderBy('createdAt', 'asc').limit(500).get();
  const rows = await Promise.all(snapshot.docs.map(async document => ({ caseId: document.id, item: await effectiveCase(document.id) })));
  return rows.filter(({ item }) => {
    // Schema-v1 cases stay exclusively in the preserved compatibility workflow.
    // Every protected link now creates v2, so there is no need to duplicate old
    // cases across the new HHH workspace and the legacy admin queue.
    if (!item.isV2) return false;
    const outcome = String(item.workflow.outcomeStatus ?? 'open');
    const legacyStatus = String(item.submission.status ?? '').toLowerCase();
    const referral = item.submission.referral as Record<string, unknown> | undefined;
    const closed = ['completed', 'declined', 'withdrawn'].includes(outcome)
      || ['approved', 'declined', 'rejected'].includes(legacyStatus)
      || referral?.status === 'completed';
    if (closed) return false;
    return source === 'general'
      ? item.submission.sourceType === 'general_hhh_website'
      : item.submission.sourceType !== 'general_hhh_website';
  })
    .map(({ caseId, item }) => adminProjection(caseId, item))
    .sort((left, right) => String(left.nextFollowUpAt ?? left.submittedAt).localeCompare(String(right.nextFollowUpAt ?? right.submittedAt)));
}

function queuePage(records: ReturnType<typeof adminProjection>[], request: Request) {
  const { cursor, limit } = z.object({ cursor: z.string().max(500).optional(), limit: z.coerce.number().int().min(1).max(100).default(50) }).parse(request.query);
  let offset = 0;
  if (cursor) {
    try {
      const decoded = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8')) as { id?: string };
      const position = records.findIndex(item => item.id === decoded.id);
      offset = position >= 0 ? position + 1 : 0;
    } catch { throw new HttpError(400, 'The queue cursor is invalid.', 'INVALID_CURSOR'); }
  }
  const page = records.slice(offset, offset + limit);
  const hasMore = offset + page.length < records.length;
  return { records: page, nextCursor: hasMore && page.length ? Buffer.from(JSON.stringify({ id: page.at(-1)!.id })).toString('base64url') : null };
}

portalRouter.get('/admin/intake/general', requireRole('hhh_admin'), async (request, response, next) => {
  try { response.json(queuePage(await adminQueue('general'), request)); } catch (error) { next(error); }
});
portalRouter.get('/admin/intake/pharmacy-referrals', requireRole('hhh_admin'), async (request, response, next) => {
  try { response.json(queuePage(await adminQueue('pharmacy'), request)); } catch (error) { next(error); }
});
portalRouter.get('/admin/intake/:caseId', requireRole('hhh_admin'), async (request, response, next) => {
  try {
    const caseId = idSchema.parse(request.params.caseId);
    const item = await effectiveCase(caseId);
    const sourceOrganisationId = String(item.submission.sourceOrganisationId ?? item.submission.organisationId ?? '');
    const preferenceOrganisationId = String(item.submission.locationPreferenceOrganisationId ?? '');
    const assignedOrganisationId = item.assignedOrganisationId ?? '';
    const ids = [...new Set([sourceOrganisationId, preferenceOrganisationId, assignedOrganisationId].filter(Boolean))];
    const organisations = await Promise.all(ids.map(async id => record(await firestore.collection('organisations').doc(id).get())));
    const names = Object.fromEntries(organisations.filter(Boolean).map(organisation => [organisation!.id, String(organisation!.tradingName ?? organisation!.name ?? organisation!.id)]));
    response.json({
      ...item.submission,
      ...item.workflow,
      effectiveAssignedOrganisationId: item.assignedOrganisationId,
      sourceOrganisationName: sourceOrganisationId ? names[sourceOrganisationId] ?? null : null,
      locationPreferenceOrganisationName: preferenceOrganisationId ? names[preferenceOrganisationId] ?? null : null,
      assignedOrganisationName: assignedOrganisationId ? names[assignedOrganisationId] ?? null : null,
      destinationLocked: isDedicatedSourceType(item.submission.sourceType ?? 'legacy_pharmacy_qr'),
      id: caseId,
    });
  } catch (error) { next(error); }
});

const requirementsSchema = z.object({
  expectedVersion: z.number().int().nonnegative(),
  followUpStatus: followUpStatusSchema.optional(),
  deliveryRequirement: z.boolean().nullable().optional(),
  collectionPreference: z.string().trim().max(200).nullable().optional(),
  mobilityAccessibilityRequirement: z.string().trim().max(500).nullable().optional(),
  geographicRestrictions: z.string().trim().max(500).nullable().optional(),
  otherNonClinicalRequirements: z.string().trim().max(1000).nullable().optional(),
  preferredContactMethod: z.enum(['phone', 'email', 'sms', 'no_preference']).nullable().optional(),
  bestTimeToContact: z.string().trim().max(200).nullable().optional(),
  recommendedDestinationOrganisationId: idSchema.nullable().optional(),
});

portalRouter.patch('/admin/intake/:caseId/follow-up', requireRole('hhh_admin'), async (request, response, next) => {
  try {
    const caseId = idSchema.parse(request.params.caseId);
    const input = requirementsSchema.parse(request.body);
    const item = await effectiveCase(caseId);
    const currentVersion = Number(item.workflow.assignmentVersion ?? 0);
    if (currentVersion !== input.expectedVersion) throw new HttpError(409, 'This case changed. Refresh before saving.', 'VERSION_CONFLICT');
    const target = item.isV2 ? firestore.collection('eligibilitySubmissions').doc(caseId) : firestore.collection('eligibilityAllocationOverlays').doc(caseId);
    const { expectedVersion: _expectedVersion, followUpStatus, ...requirements } = input;
    await target.set({
      ...(item.isV2 ? {} : { sourceOrganisationId: item.submission.organisationId, assignedOrganisationId: item.assignedOrganisationId, assignmentStatus: item.assignmentStatus }),
      assignmentVersion: currentVersion + 1,
      followUpStatus: followUpStatus ?? item.workflow.followUpStatus ?? 'not_started',
      allocationRequirements: { ...(item.workflow.allocationRequirements as Record<string, unknown> ?? {}), ...requirements },
      updatedAt: nowIso(),
    }, { merge: true });
    invalidateCache('list:eligibilitySubmissions:', `record:eligibilitySubmissions:${caseId}`);
    await audit(request, 'intake_v2.follow_up_updated', { recordId: caseId, fields: Object.keys(requirements) });
    response.json({ id: caseId, assignmentVersion: currentVersion + 1 });
  } catch (error) { next(error); }
});

portalRouter.post('/admin/intake/:caseId/follow-up-attempts', requireRole('hhh_admin'), async (request, response, next) => {
  try {
    const caseId = idSchema.parse(request.params.caseId);
    const input = z.object({
      expectedVersion: z.number().int().nonnegative(),
      contactMethod: z.enum(['phone', 'email', 'sms', 'other']),
      outcome: followUpStatusSchema,
      reachedPatient: z.boolean(),
      note: z.string().trim().max(2000).nullable(),
      nextFollowUpAt: z.iso.datetime().nullable(),
    }).parse(request.body);
    const item = await effectiveCase(caseId);
    const target = item.isV2 ? firestore.collection('eligibilitySubmissions').doc(caseId) : firestore.collection('eligibilityAllocationOverlays').doc(caseId);
    const attemptedAt = nowIso();
    await firestore.runTransaction(async transaction => {
      const snapshot = await transaction.get(target);
      const current = snapshot.data() ?? {};
      const currentVersion = Number(current.assignmentVersion ?? item.workflow.assignmentVersion ?? 0);
      if (currentVersion !== input.expectedVersion) throw new HttpError(409, 'This case changed. Refresh before saving.', 'VERSION_CONFLICT');
      const previousTimeline = Array.isArray(current.followUpTimeline)
        ? current.followUpTimeline.slice(-99)
        : Array.isArray(item.workflow.followUpTimeline) ? item.workflow.followUpTimeline.slice(-99) : [];
      const attempt = {
        id: randomUUID(), occurredAt: attemptedAt, contactMethod: input.contactMethod,
        outcome: input.outcome, reachedPatient: input.reachedPatient, note: input.note,
        nextFollowUpAt: input.nextFollowUpAt, actorUid: identity(request).uid,
      };
      transaction.set(target, {
        ...(!item.isV2 && !snapshot.exists ? { sourceOrganisationId: item.submission.organisationId, assignedOrganisationId: item.assignedOrganisationId, assignmentStatus: item.assignmentStatus } : {}),
        assignmentVersion: currentVersion + 1, followUpStatus: input.outcome,
        followUpAttemptCount: Number(current.followUpAttemptCount ?? item.workflow.followUpAttemptCount ?? 0) + 1,
        followUpTimeline: [...previousTimeline, attempt],
        lastFollowUpAttemptAt: attemptedAt, nextFollowUpAt: input.nextFollowUpAt, updatedAt: attemptedAt,
      }, { merge: true });
    });
    invalidateCache('list:eligibilitySubmissions:', `record:eligibilitySubmissions:${caseId}`);
    await audit(request, 'intake_v2.follow_up_attempted', { recordId: caseId, outcome: input.outcome, contactMethod: input.contactMethod, reachedPatient: input.reachedPatient, notePresent: Boolean(input.note) });
    response.json({ id: caseId, attemptedAt, assignmentVersion: input.expectedVersion + 1 });
  } catch (error) { next(error); }
});

portalRouter.get('/admin/intake/:caseId/assignment-candidates', requireRole('hhh_admin'), async (request, response, next) => {
  try {
    const caseId = idSchema.parse(request.params.caseId);
    const query = z.string().trim().max(100).catch('').parse(request.query.q);
    const item = await effectiveCase(caseId);
    if (isDedicatedSourceType(item.submission.sourceType ?? 'legacy_pharmacy_qr')) {
      const sourceOrganisationId = String(item.submission.sourceOrganisationId ?? item.submission.organisationId ?? '');
      const source = sourceOrganisationId ? record(await firestore.collection('organisations').doc(sourceOrganisationId).get()) : null;
      return response.json({ records: [], destinationLocked: true, lockedDestination: source ? { id: source.id, tradingName: source.tradingName ?? source.name } : null });
    }
    const latitude = typeof item.submission.postcodeLatitude === 'number' ? item.submission.postcodeLatitude : null;
    const longitude = typeof item.submission.postcodeLongitude === 'number' ? item.submission.postcodeLongitude : null;
    const candidates = (await eligibleDirectoryProfiles()).filter(profile => !query || `${profile.tradingName} ${profile.gphcNumber} ${profile.postcode}`.toLowerCase().includes(query.toLowerCase()));
    response.json({ records: candidates.map(profile => ({
      id: profile.id, tradingName: profile.tradingName, gphcNumber: profile.gphcNumber,
      approximateMiles: latitude !== null && longitude !== null ? Math.round(haversineMiles({ latitude, longitude }, profile) * 10) / 10 : null,
      deliveryCapability: profile.deliveryCapability, collectionAvailable: profile.collectionAvailable,
      deliveryCoverage: profile.deliveryCoverage, intakeState: profile.intakeState, serviceTags: profile.serviceTags ?? [], restrictions: profile.restrictions ?? [], warnings: [],
    })) });
  } catch (error) { next(error); }
});

const assignmentSchema = z.object({
  destinationOrganisationId: idSchema,
  reasonCode: z.string().trim().min(2).max(100),
  note: z.string().trim().max(1500).nullable().optional(),
  expectedVersion: z.number().int().nonnegative(),
  acknowledgeReviewStarted: z.boolean().default(false),
});

async function assignCase(request: Request, caseId: string, input: z.infer<typeof assignmentSchema>, action: 'confirmed' | 'reassigned') {
  const destinationProfileRef = firestore.collection('pharmacyDirectoryProfiles').doc(input.destinationOrganisationId);
  const destinationOrgRef = firestore.collection('organisations').doc(input.destinationOrganisationId);
  const submissionRef = firestore.collection('eligibilitySubmissions').doc(caseId);
  const overlayRef = firestore.collection('eligibilityAllocationOverlays').doc(caseId);
  const eventRef = firestore.collection('eligibilityAssignmentEvents').doc();
  const occurredAt = nowIso();
  let previousOrganisationId: string | null = null;
  await firestore.runTransaction(async transaction => {
    const [submissionSnapshot, overlaySnapshot, profileSnapshot, organisationSnapshot] = await Promise.all([
      transaction.get(submissionRef), transaction.get(overlayRef), transaction.get(destinationProfileRef), transaction.get(destinationOrgRef),
    ]);
    if (!submissionSnapshot.exists) throw new HttpError(404, 'The requested record was not found.', 'NOT_FOUND');
    const submission = submissionSnapshot.data()!;
    const overlay = overlaySnapshot.data() ?? {};
    const isV2 = submission.schemaVersion === 2 || submission.intakeVersion === 'v2';
    const workflow = isV2 ? submission : overlay;
    const sourceType = String(submission.sourceType ?? 'legacy_pharmacy_qr');
    const dedicatedSource = isDedicatedSourceType(sourceType);
    const sourceOrganisationId = String(submission.sourceOrganisationId ?? submission.organisationId ?? '');
    const currentVersion = Number(workflow.assignmentVersion ?? 0);
    if (currentVersion !== input.expectedVersion) throw new HttpError(409, 'This case changed. Refresh before assigning it.', 'VERSION_CONFLICT');
    if (workflow.followUpStatus !== 'completed') throw new HttpError(409, 'Complete the HHH follow-up before referring this patient to a pharmacy.', 'FOLLOW_UP_REQUIRED');
    if (dedicatedSource && action === 'reassigned') throw new HttpError(409, 'This dedicated-link referral is permanently tied to its source pharmacy.', 'DEDICATED_DESTINATION_LOCKED');
    if (dedicatedSource && input.destinationOrganisationId !== sourceOrganisationId) throw new HttpError(409, 'This dedicated-link referral must remain with its source pharmacy.', 'DEDICATED_DESTINATION_LOCKED');
    const patientId = typeof submission.patientId === 'string' ? submission.patientId : null;
    const operationalQueries = await Promise.all([
      ...(patientId ? [
        transaction.get(firestore.collection('orders').where('patientId', '==', patientId).limit(1)),
        transaction.get(firestore.collection('payments').where('patientId', '==', patientId).limit(1)),
        transaction.get(firestore.collection('prescriptions').where('patientId', '==', patientId).limit(1)),
        transaction.get(firestore.collection('curaleafOperations').where('patientId', '==', patientId).limit(1)),
      ] : []),
      transaction.get(firestore.collection('notificationOutbox').where('referralSubmissionId', '==', caseId).where('status', '==', 'pending').limit(1)),
    ]);
    if (submission.operationalStartedAt || overlay.operationalStartedAt || operationalQueries.some(snapshot => !snapshot.empty)) {
      throw new HttpError(409, 'Operational activity has started, so this case cannot be reassigned.', 'OPERATIONAL_ACTIVITY_STARTED');
    }
    const patientRef = patientId ? firestore.collection('patients').doc(patientId) : null;
    const patientSnapshot = patientRef ? await transaction.get(patientRef) : null;
    const profile = profileSnapshot.data();
    const organisation = organisationSnapshot.data();
    const dedicatedDestinationReady = dedicatedSource
      && organisation
      && canAcceptPublicIntake(organisation);
    if (dedicatedSource ? !dedicatedDestinationReady : !profile || !organisation || !isDirectoryReady(profile, organisation, true)) {
      throw new HttpError(409, 'The selected pharmacy is not available for referral.', 'DESTINATION_UNAVAILABLE');
    }
    const reviewStarted = !['not_opened', undefined].includes(workflow.pharmacyReviewStatus);
    if (reviewStarted && !input.acknowledgeReviewStarted) throw new HttpError(409, 'Pharmacy review has started. Confirm that you understand before reassigning.', 'REVIEW_STARTED_CONFIRMATION_REQUIRED');
    previousOrganisationId = isV2 ? (submission.assignedOrganisationId as string | null ?? null) : (overlay.assignedOrganisationId as string | null ?? String(submission.organisationId ?? ''));
    const update = {
      assignedOrganisationId: input.destinationOrganisationId,
      organisationId: input.destinationOrganisationId,
      assignmentStatus: 'confirmed', assignmentVersion: currentVersion + 1,
      pharmacyAccessStatus: 'withheld',
      finalDestinationOrganisationId: input.destinationOrganisationId,
      assignmentReason: input.reasonCode, privateAllocationNote: input.note ?? null,
      allocationCompletedBy: identity(request).uid, allocationCompletedAt: occurredAt, updatedAt: occurredAt,
    };
    if (isV2) transaction.update(submissionRef, update);
    else transaction.set(overlayRef, {
      schemaVersion: 2, sourceOrganisationId: submission.organisationId ?? null,
      assignedOrganisationId: input.destinationOrganisationId, assignmentStatus: 'confirmed', assignmentVersion: currentVersion + 1,
      pharmacyAccessStatus: 'withheld',
      finalDestinationOrganisationId: input.destinationOrganisationId, assignmentReason: input.reasonCode,
      privateAllocationNote: input.note ?? null, allocationCompletedBy: identity(request).uid, allocationCompletedAt: occurredAt,
      createdAt: overlay.createdAt ?? occurredAt, updatedAt: occurredAt,
    }, { merge: true });
    transaction.create(eventRef, assignmentEventFields({
      caseId, previousOrganisationId, newOrganisationId: input.destinationOrganisationId,
      action, reasonCode: input.reasonCode, actorUid: identity(request).uid, occurredAt,
      pharmacyReviewStarted: reviewStarted, previousAssignmentVersion: currentVersion, newAssignmentVersion: currentVersion + 1,
      notePresent: Boolean(input.note),
    }));
    if (patientId && patientRef && patientSnapshot?.exists) {
        const patient = patientSnapshot.data()!;
        const identityKey = (organisationId: string) => createHash('sha256')
          .update(`${organisationId}:${String(patient.email ?? submission.email ?? '').trim().toLowerCase()}:${String(patient.dob ?? submission.dob ?? '')}`)
          .digest('hex');
        if (previousOrganisationId) transaction.delete(firestore.collection('patientIdentities').doc(identityKey(previousOrganisationId)));
        transaction.set(firestore.collection('patientIdentities').doc(identityKey(input.destinationOrganisationId)), {
          id: identityKey(input.destinationOrganisationId), schemaVersion: 1, organisationId: input.destinationOrganisationId,
          patientId, normalisedEmail: String(patient.email ?? submission.email ?? '').trim().toLowerCase(), dob: patient.dob ?? submission.dob,
          createdAt: occurredAt, updatedAt: occurredAt,
        }, { merge: true });
        transaction.set(patientRef, { organisationId: input.destinationOrganisationId, updatedAt: occurredAt }, { merge: true });
    }
  });
  invalidateCache(
    'eligibility-v2:', 'admin:intake:', 'list:eligibilitySubmissions:',
    `record:eligibilitySubmissions:${caseId}`,
    `tenant:${previousOrganisationId}:`, `tenant:${input.destinationOrganisationId}:`,
  );
  await audit(request, `intake_v2.assignment_${action}`, { recordId: caseId, previousOrganisationId, newOrganisationId: input.destinationOrganisationId, reasonCode: input.reasonCode, notePresent: Boolean(input.note) });
  return { id: caseId, assignedOrganisationId: input.destinationOrganisationId, assignmentStatus: 'confirmed', assignmentVersion: input.expectedVersion + 1, occurredAt };
}

portalRouter.post('/admin/intake/:caseId/confirm-assignment', requireRole('hhh_admin'), async (request, response, next) => {
  try {
    const caseId = idSchema.parse(request.params.caseId);
    const item = await effectiveCase(caseId);
    if (!item.assignedOrganisationId) throw new HttpError(409, 'Choose a destination before confirming.', 'DESTINATION_REQUIRED');
    const input = assignmentSchema.parse({ ...request.body, destinationOrganisationId: item.assignedOrganisationId });
    response.json(await assignCase(request, caseId, input, 'confirmed'));
  } catch (error) { next(error); }
});
portalRouter.post('/admin/intake/:caseId/reassign', requireRole('hhh_admin'), async (request, response, next) => {
  try { response.json(await assignCase(request, idSchema.parse(request.params.caseId), assignmentSchema.parse(request.body), 'reassigned')); } catch (error) { next(error); }
});

portalRouter.post('/admin/intake/:caseId/programme-onboarding', requireRole('hhh_admin'), async (request, response, next) => {
  try {
    const caseId = idSchema.parse(request.params.caseId);
    const input = z.object({ expectedVersion: z.number().int().nonnegative(), decision: z.enum(['approved', 'declined']), notes: z.string().trim().max(1500).nullable() }).parse(request.body);
    const item = await effectiveCase(caseId);
    if (!item.isV2) throw new HttpError(409, 'Use the legacy referral workflow for this case.', 'LEGACY_INTAKE_REQUIRED');
    const currentVersion = Number(item.workflow.assignmentVersion ?? 0);
    if (currentVersion !== input.expectedVersion) throw new HttpError(409, 'This case changed. Refresh before recording the onboarding decision.', 'VERSION_CONFLICT');
    if (input.decision === 'approved') {
      if (item.assignmentStatus !== 'confirmed' || !item.assignedOrganisationId) throw new HttpError(409, 'Confirm the pharmacy assignment before programme onboarding.', 'ASSIGNMENT_NOT_CONFIRMED');
      if (item.workflow.followUpStatus !== 'completed') throw new HttpError(409, 'Complete the HHH follow-up before programme onboarding.', 'FOLLOW_UP_REQUIRED');
      const completedAt = nowIso();
      await firestore.collection('eligibilitySubmissions').doc(caseId).set({
        recordsCheck: { status: 'completed', notes: input.notes, completedAt, completedBy: identity(request).uid },
        assignmentVersion: currentVersion + 1, updatedAt: completedAt,
      }, { merge: true });
      const patient = await completeReferral(caseId, identity(request).uid, input.notes);
      invalidateCache('list:eligibilitySubmissions:', `record:eligibilitySubmissions:${caseId}`);
      await audit(request, 'intake_v2.programme_onboarding_approved', { recordId: caseId, organisationId: item.assignedOrganisationId });
      return response.json({ id: caseId, decision: 'approved', patientId: patient.patientId, assignmentVersion: currentVersion + 1 });
    }
    const decidedAt = nowIso();
    await firestore.collection('eligibilitySubmissions').doc(caseId).set({
      status: 'declined', outcomeStatus: 'declined', assignmentVersion: currentVersion + 1,
      programmeOnboardingDecision: 'declined', programmeOnboardingDecidedAt: decidedAt, programmeOnboardingDecidedBy: identity(request).uid,
      privateOnboardingNote: input.notes, updatedAt: decidedAt,
    }, { merge: true });
    invalidateCache('list:eligibilitySubmissions:', `record:eligibilitySubmissions:${caseId}`);
    await audit(request, 'intake_v2.programme_onboarding_declined', { recordId: caseId, organisationId: item.assignedOrganisationId });
    response.json({ id: caseId, decision: 'declined', assignmentVersion: currentVersion + 1 });
  } catch (error) { next(error); }
});

const profileSchema = z.object({
  tradingName: z.string().trim().min(1).max(200), gphcNumber: z.string().trim().min(1).max(50),
  addressLine1: z.string().trim().min(1).max(250), addressLine2: z.string().trim().max(250).default(''),
  locality: z.string().trim().min(1).max(120), postcode: z.string().trim().min(2).max(16),
  publicEmail: z.email().max(254), publicPhone: z.string().trim().max(50).default(''),
  // Controller identity and data-protection contacts, published to patients at
  // selection and in every message (Privacy 1.1 and 1.5). Optional so an existing
  // profile can still be saved while the pharmacy is chasing its own details.
  icoRegistrationNumber: z.string().trim().max(50).default(''),
  privacyContactEmail: z.union([z.email().max(254), z.literal('')]).default(''),
  dataProtectionOfficer: z.string().trim().max(200).default(''),
  complaintsContactEmail: z.union([z.email().max(254), z.literal('')]).default(''),
  complaintsContactPhone: z.string().trim().max(50).default(''),
  deliveryCapability: z.enum(['none', 'nationwide', 'postcode_areas', 'radius_miles']),
  deliveryCoverage: z.object({ postcodeAreas: z.array(z.string().trim().max(4)).max(100).default([]), radiusMiles: z.number().positive().max(1000).nullable().default(null) }),
  deliverySummary: z.string().trim().max(400).default(''), collectionAvailable: z.boolean(),
  serviceTags: z.array(z.string().trim().min(1).max(80)).max(30).default([]), restrictions: z.array(z.string().trim().min(1).max(200)).max(30).default([]),
  intakeState: z.enum(['available', 'limited', 'full']), weeklyCapacity: z.number().int().positive().max(10000).nullable(), acceptingNewPatients: z.boolean(),
  gdprEvidenceState: z.enum(['missing', 'pending', 'verified']), curaleafIntegrationState: z.enum(['not_checked', 'test_verified', 'production_verified']),
  realClassification: z.enum(['real', 'training']),
});

function requireDirectoryEnabled() {
  if (config.V2_DIRECTORY_ADMIN_ENABLED !== 'true') throw new HttpError(404, 'Not found.', 'NOT_FOUND');
}

async function generateDirectoryQrPack(organisationId: string, profile: RecordMap, referralUrl: string) {
  const zip = new JSZip();
  const safeName = String(profile.tradingName ?? organisationId).replace(/[^A-Za-z0-9 _-]/g, '').trim() || 'pharmacy';
  const qrSvg = await QRCode.toString(referralUrl, { type: 'svg', width: 1024, margin: 4, errorCorrectionLevel: 'H', color: { dark: '#12372d', light: '#ffffff' } });
  zip.file('README.txt', `Holistic Health Hub v2 referral content pack for ${safeName}\n\nThis stable QR link opens the centrally hosted eligibility form and preserves immutable source attribution. Do not edit the token, proxy the form, embed it in an iframe or share it with another organisation. HHH must approve patient-facing copy before publication.\n`);
  zip.file('eligibility-link.txt', `${referralUrl}\n`);
  zip.file('website-copy.txt', `Suggested heading:\nCould specialist care be right for you?\n\nSuggested button:\nCheck my eligibility\n\nExact destination:\n${referralUrl}\n`);
  zip.file('qr-usage-notes.txt', 'Keep a clear white margin around eligibility-qr.svg. Do not crop, distort or recolour the code. Test the final digital and printed artwork before use.\n');
  zip.file('eligibility-qr.svg', qrSvg);
  const content = await zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' });
  const storagePath = `directory-qr-packs/${organisationId}/v2-content-pack.zip`;
  await storage.bucket().file(storagePath).save(content, {
    resumable: false,
    contentType: 'application/zip',
    metadata: { cacheControl: 'private, no-store', metadata: { organisationId, generatedAt: nowIso(), schemaVersion: '2' } },
  });
  return { storagePath, size: content.length };
}

portalRouter.get('/admin/directory-profiles', requireRole('hhh_admin'), async (_request, response, next) => {
  try { requireDirectoryEnabled(); const snapshot = await firestore.collection('pharmacyDirectoryProfiles').limit(500).get(); response.json({ records: snapshot.docs.map(record) }); } catch (error) { next(error); }
});
portalRouter.put('/admin/directory-profiles/:organisationId', requireRole('hhh_admin'), async (request, response, next) => {
  try {
    requireDirectoryEnabled();
    const organisationId = idSchema.parse(request.params.organisationId);
    const input = profileSchema.parse(request.body);
    const organisation = record(await firestore.collection('organisations').doc(organisationId).get());
    if (!organisation) throw new HttpError(404, 'Pharmacy account not found.', 'ORGANISATION_NOT_FOUND');
    if (isExplicitCuraleafTestAccount(organisation) || input.realClassification !== 'real') throw new HttpError(409, 'Training pharmacies cannot have a public directory profile.', 'TRAINING_DIRECTORY_FORBIDDEN');
    const readiness = await validatedDirectoryReadiness(organisation);
    const existing = record(await firestore.collection('pharmacyDirectoryProfiles').doc(organisationId).get());
    const geocode = await geocodePostcode(input.postcode);
    const updatedAt = nowIso();
    const payload = {
      schemaVersion: 2, organisationId, ...input, ...readiness, realClassification: 'real', postcode: normaliseUkPostcode(input.postcode),
      latitude: geocode.status === 'matched' ? geocode.latitude : null,
      longitude: geocode.status === 'matched' ? geocode.longitude : null,
      geocodingProvider: geocode.provider, geocodingStatus: geocode.status, geocodedAt: geocode.status === 'matched' ? updatedAt : null,
      lifecycle: existing?.lifecycle ?? 'draft', qrState: existing?.qrState ?? 'inactive', referralTokenId: existing?.referralTokenId ?? null,
      createdAt: existing?.createdAt ?? updatedAt, updatedAt,
    };
    await firestore.collection('pharmacyDirectoryProfiles').doc(organisationId).set(payload);
    await audit(request, 'directory_v2.profile_saved', { organisationId, geocodingStatus: geocode.status });
    response.json({ id: organisationId, ...payload, publicationIssues: directoryPublicationIssues(payload, organisation) });
  } catch (error) { next(error); }
});

async function directoryLifecycleAction(request: Request, organisationId: string, action: 'submit-review' | 'publish' | 'pause' | 'unpublish') {
  requireDirectoryEnabled();
  const profileRef = firestore.collection('pharmacyDirectoryProfiles').doc(organisationId);
  const [profileSnapshot, organisationSnapshot] = await Promise.all([profileRef.get(), firestore.collection('organisations').doc(organisationId).get()]);
  if (!profileSnapshot.exists || !organisationSnapshot.exists) throw new HttpError(404, 'Directory profile not found.', 'NOT_FOUND');
  const profile = profileSnapshot.data()!;
  const organisation = organisationSnapshot.data()!;
  if (action === 'publish') {
    const issues = directoryPublicationIssues(profile, organisation);
    if (issues.length) throw new HttpError(409, `This profile is not ready to publish: ${issues.join(', ')}`, 'DIRECTORY_NOT_READY');
    if (profile.lifecycle !== 'ready_for_review') throw new HttpError(409, 'Submit this profile for review before publishing.', 'DIRECTORY_REVIEW_REQUIRED');
  }
  const lifecycle = action === 'submit-review' ? 'ready_for_review' : action === 'publish' ? 'published' : action === 'pause' ? 'paused' : 'unpublished';
  const changedAt = nowIso();
  await profileRef.set({ lifecycle, [`${action.replace('-', '')}At`]: changedAt, [`${action.replace('-', '')}By`]: identity(request).uid, updatedAt: changedAt }, { merge: true });
  invalidateCache('directory-v2:');
  await audit(request, `directory_v2.${action}`, { organisationId });
  return { id: organisationId, lifecycle, updatedAt: changedAt };
}

for (const action of ['submit-review', 'publish', 'pause', 'unpublish'] as const) {
  portalRouter.post(`/admin/directory-profiles/:organisationId/${action}`, requireRole('hhh_admin'), async (request, response, next) => {
    try { response.json(await directoryLifecycleAction(request, idSchema.parse(request.params.organisationId), action)); } catch (error) { next(error); }
  });
}

portalRouter.post('/admin/directory-profiles/:organisationId/qr/:action', requireRole('hhh_admin'), async (request, response, next) => {
  try {
    requireDirectoryEnabled();
    const organisationId = idSchema.parse(request.params.organisationId);
    const action = z.enum(['activate', 'pause']).parse(request.params.action);
    const profileRef = firestore.collection('pharmacyDirectoryProfiles').doc(organisationId);
    const profile = record(await profileRef.get());
    if (!profile || profile.lifecycle !== 'published') throw new HttpError(409, 'Publish the profile before activating its QR link.', 'DIRECTORY_NOT_PUBLISHED');
    let referralTokenId = typeof profile.referralTokenId === 'string' ? profile.referralTokenId : null;
    let rawToken: string | null = null;
    let generatedPack: { storagePath: string; size: number } | null = null;
    if (action === 'activate' && !referralTokenId) {
      rawToken = randomBytes(32).toString('base64url');
      referralTokenId = randomUUID();
      const referralUrl = `${config.PUBLIC_APP_ORIGIN}/eligibility?token=${rawToken}`;
      generatedPack = await generateDirectoryQrPack(organisationId, profile, referralUrl);
      const batch = firestore.batch();
      batch.create(firestore.collection('referralTokens').doc(referralTokenId), { schemaVersion: 2, organisationId, tokenHash: tokenHash(rawToken), intakeVersion: 'v2', createdAt: nowIso(), revokedAt: null });
      batch.set(profileRef, { referralTokenId, qrPackStoragePath: generatedPack.storagePath, qrPackSize: generatedPack.size, qrPackGeneratedAt: nowIso() }, { merge: true });
      await batch.commit();
    }
    const qrState = action === 'activate' ? 'active' : 'paused';
    await profileRef.set({ qrState, updatedAt: nowIso() }, { merge: true });
    await audit(request, `directory_v2.qr_${action}`, { organisationId, referralTokenId });
    response.json({ organisationId, referralTokenId, qrState, referralUrl: rawToken ? `${config.PUBLIC_APP_ORIGIN}/eligibility?token=${rawToken}` : null, tokenShownOnce: Boolean(rawToken) });
  } catch (error) { next(error); }
});

portalRouter.get('/admin/directory-profiles/:organisationId/qr-pack', requireRole('hhh_admin'), async (request, response, next) => {
  try {
    requireDirectoryEnabled();
    const organisationId = idSchema.parse(request.params.organisationId);
    const profile = record(await firestore.collection('pharmacyDirectoryProfiles').doc(organisationId).get());
    if (!profile || typeof profile.qrPackStoragePath !== 'string') throw new HttpError(404, 'QR content pack not found.', 'NOT_FOUND');
    const [content] = await storage.bucket().file(profile.qrPackStoragePath).download();
    const filename = `${String(profile.tradingName ?? 'pharmacy').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'pharmacy'}-hhh-v2-content-pack.zip`;
    response.setHeader('Content-Type', 'application/zip');
    response.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    response.setHeader('Cache-Control', 'private, no-store');
    response.send(content);
  } catch (error) { next(error); }
});

portalRouter.get('/eligibility-submissions', requireRole('pharmacy_staff'), async (request, response, next) => {
  try {
    const organisationId = tenantFor(request);
    const [direct, overlays] = await Promise.all([
      firestore.collection('eligibilitySubmissions').where('organisationId', '==', organisationId).limit(500).get(),
      firestore.collection('eligibilityAllocationOverlays').where('assignedOrganisationId', '==', organisationId).limit(500).get(),
    ]);
    const ids = new Set([...direct.docs.map(document => document.id), ...overlays.docs.map(document => document.id)]);
    const records = (await Promise.all([...ids].map(async caseId => {
      const item = await effectiveCase(caseId);
      return item.assignedOrganisationId === organisationId && canPharmacyAccessCase(item.workflow, item.isV2) ? pharmacySummary(caseId, item) : null;
    }))).filter(Boolean);
    response.json({ records: records.sort((left, right) => String(right!.submittedAt).localeCompare(String(left!.submittedAt))) });
  } catch (error) { next(error); }
});

portalRouter.get('/eligibility-submissions/:caseId', requireRole('pharmacy_staff'), async (request, response, next) => {
  try {
    const item = await effectiveCase(idSchema.parse(request.params.caseId));
    if (item.assignedOrganisationId !== tenantFor(request) || !canPharmacyAccessCase(item.workflow, item.isV2)) throw new HttpError(404, 'The requested record was not found.', 'NOT_FOUND');
    response.json(pharmacyDetail(item));
  } catch (error) { next(error); }
});

portalRouter.patch('/eligibility-submissions/:caseId/review', requireRole('pharmacy_staff'), async (request, response, next) => {
  try {
    const caseId = idSchema.parse(request.params.caseId);
    const input = z.object({ expectedVersion: z.number().int().nonnegative(), reviewStatus: reviewStatusSchema, outcomeStatus: outcomeStatusSchema, notes: z.string().trim().max(2000).nullable() }).parse(request.body);
    const item = await effectiveCase(caseId);
    const organisationId = tenantFor(request);
    if (item.assignedOrganisationId !== organisationId || !canPharmacyAccessCase(item.workflow, item.isV2)) throw new HttpError(404, 'The requested record was not found.', 'NOT_FOUND');
    if (item.assignmentStatus !== 'confirmed' && (input.outcomeStatus !== 'open' || !['opened', 'reviewing', 'needs_information'].includes(input.reviewStatus))) {
      throw new HttpError(409, 'HHH must confirm allocation before the pharmacy can complete or decide this review.', 'ASSIGNMENT_NOT_CONFIRMED');
    }
    const target = item.isV2 ? firestore.collection('eligibilitySubmissions').doc(caseId) : firestore.collection('eligibilityAllocationOverlays').doc(caseId);
    await firestore.runTransaction(async transaction => {
      const snapshot = await transaction.get(target);
      const current = snapshot.data() ?? {};
      const version = Number(current.assignmentVersion ?? item.workflow.assignmentVersion ?? 0);
      if (version !== input.expectedVersion) throw new HttpError(409, 'This case changed. Refresh before saving.', 'VERSION_CONFLICT');
      transaction.set(target, {
        ...(!item.isV2 && !snapshot.exists ? { sourceOrganisationId: item.submission.organisationId, assignedOrganisationId: organisationId, assignmentStatus: 'confirmed' } : {}),
        assignmentVersion: version + 1, pharmacyReviewStatus: input.reviewStatus, outcomeStatus: input.outcomeStatus,
        pharmacyReviewNotes: input.notes, pharmacyReviewStartedAt: current.pharmacyReviewStartedAt ?? nowIso(),
        pharmacyReviewUpdatedBy: identity(request).uid, pharmacyReviewUpdatedAt: nowIso(), updatedAt: nowIso(),
      }, { merge: true });
    });
    invalidateCache('list:eligibilitySubmissions:', `record:eligibilitySubmissions:${caseId}`);
    await audit(request, 'intake_v2.pharmacy_review_updated', { organisationId, recordId: caseId, reviewStatus: input.reviewStatus, outcomeStatus: input.outcomeStatus });
    response.json({ id: caseId, assignmentVersion: input.expectedVersion + 1, reviewStatus: input.reviewStatus, outcomeStatus: input.outcomeStatus });
  } catch (error) { next(error); }
});

export { publicRouter as publicIntakeV2Router, portalRouter as portalIntakeV2Router, effectiveCase as resolveEffectiveEligibilityCase };
