import { HttpError } from '../../domain/common/errors.js';
import { mergeSubject, mergeTemplate } from '../../domain/common/content-template.js';
import type { GoLiveChecklistView } from '../../domain/organisation/go-live-checklist.js';
import { worldpayValidatedAt } from '../../domain/organisation/go-live-checklist.js';
import {
  HOLD_REASON_FLAG,
  ONBOARDING_EMAIL_KINDS,
  ONBOARDING_HOLD_REASONS,
  partnerTermsLink,
  type OnboardingContent,
  type OnboardingEmailKind,
  type OnboardingHoldReason,
} from '../../domain/pharmacy-onboarding/content.js';
import { londonCalendarDate, type PharmacyOnboardingRequestRecord } from '../../domain/pharmacy-onboarding/request.js';
import type { PartnerTermsAcceptanceRecord } from '../../domain/pharmacy-onboarding/terms.js';
import type { IntegrationConnectionRecord } from '../../repositories/ports/integration.port.js';
import type { NotificationOutboxRecord, NotificationRepositoryPort } from '../../repositories/ports/notification.port.js';
import type { OrganisationRecord } from '../../repositories/ports/organisation.port.js';
import type { PlatformContentRepository, WorldpayApplicationRepository } from '../../repositories/ports/worldpay-application.port.js';
import { SqlGoLiveChecklistRepository } from '../../repositories/sql/go-live-checklist.sql.js';
import { SqlIntegrationRepository } from '../../repositories/sql/integration.sql.js';
import { SqlNotificationRepository } from '../../repositories/sql/notification.sql.js';
import { SqlOrganisationRepository } from '../../repositories/sql/organisation.sql.js';
import { SqlPharmacyOnboardingRepository } from '../../repositories/sql/pharmacy-onboarding.sql.js';
import { SqlPlatformContentRepository, SqlWorldpayApplicationRepository } from '../../repositories/sql/worldpay-application.sql.js';
import { messageIdempotencyKey, type EmailTemplateCode } from '../notifications/email-catalog.js';
import { queueSharedEmail } from '../notifications/email-outbox.js';
import { loadGoLiveChecklist } from '../organisation/go-live-checklist.js';
import { isDemoGphc } from './demo-pharmacies.js';
import {
  FILLED_FORM_NAME_KEY,
  FILLED_FORM_PATH_KEY,
  LICENCE_NAME_KEY,
  LICENCE_PATH_KEY,
  LICENCE_TYPE_KEY,
} from './emails.js';
import { curaleafApplicationCc, curaleafApplicationTo } from './onboarding-config.js';
import { readOnboardingContent } from './onboarding-content.js';
import type { OnboardingEmailLogEntry, OnboardingEmails } from './onboarding-emails.js';

/** The outbox template each onboarding email is queued as. */
export const ONBOARDING_EMAIL_TEMPLATE: Record<OnboardingEmailKind, EmailTemplateCode> = {
  sent: 'pharmacy_onboarding_submitted',
  curaleafApplication: 'curaleaf_new_account_application',
  activation: 'pharmacy_onboarding_activated',
  hold: 'pharmacy_onboarding_held',
  live: 'pharmacy_onboarding_live',
};

const KIND_BY_TEMPLATE = new Map<string, OnboardingEmailKind>(
  ONBOARDING_EMAIL_KINDS.map(kind => [ONBOARDING_EMAIL_TEMPLATE[kind], kind]),
);

export const DEMO_SUBJECT_PREFIX = 'DEMO, not sent to Curaleaf: ';

/** What the onboarding emails read. Narrow on purpose, so tests can fake it. */
export interface OnboardingEmailsDeps {
  notifications: Pick<NotificationRepositoryPort, 'enqueue' | 'findByIdempotencyKey'>;
  content: Pick<PlatformContentRepository, 'read'>;
  requests: {
    findById(id: string): Promise<PharmacyOnboardingRequestRecord | null>;
    findByOrganisationId(organisationId: string): Promise<PharmacyOnboardingRequestRecord | null>;
    findTermsAcceptances(onboardingRequestId: string): Promise<PartnerTermsAcceptanceRecord[]>;
    findTermsAcceptancesForOrganisation(organisationId: string): Promise<PartnerTermsAcceptanceRecord[]>;
  };
  findOrganisation(organisationId: string): Promise<OrganisationRecord | null>;
  worldpayApplications: Pick<WorldpayApplicationRepository, 'findForRequest' | 'findForOrganisation'>;
  findConnection(organisationId: string, integration: 'CURALEAF' | 'WORLDPAY'): Promise<IntegrationConnectionRecord | null>;
  goLiveChecklist(organisationId: string): Promise<GoLiveChecklistView>;
  isDemoGphc(gphcNumber: string): Promise<boolean>;
  /** Curaleaf's new-accounts addresses and the HHH copy (config). */
  curaleafRecipients?: () => { to: string[]; cc: string[] };
  now?: () => Date;
  warn?: (message: string, details: Record<string, unknown>) => void;
}

type Built = {
  to: string[];
  cc: string[];
  payload: Record<string, unknown>;
  organisationId: string | null;
  onboardingRequestId: string | null;
};

function londonDate(iso: string | null | undefined) {
  const at = iso ? new Date(iso) : null;
  if (!at || Number.isNaN(at.getTime())) return '';
  return new Intl.DateTimeFormat('en-GB', { timeZone: 'Europe/London', day: 'numeric', month: 'long', year: 'numeric' }).format(at);
}

function londonTime(iso: string | null | undefined) {
  const at = iso ? new Date(iso) : null;
  if (!at || Number.isNaN(at.getTime())) return '';
  return new Intl.DateTimeFormat('en-GB', { timeZone: 'Europe/London', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(at);
}

function firstWord(name: string | null | undefined) {
  return String(name ?? '').trim().split(/\s+/)[0] ?? '';
}

const EMAIL_SHAPE = /^[^\s@<>,;"]+@[^\s@<>,;"]+\.[^\s@<>,;"]+$/;

/** Lower-cased, valid, each address once: one email when the signer and the branch share an address. */
export function uniqueAddresses(addresses: Array<string | null | undefined>) {
  const out: string[] = [];
  for (const raw of addresses) {
    const address = String(raw ?? '').trim().toLowerCase();
    if (!address || !EMAIL_SHAPE.test(address) || out.includes(address)) continue;
    out.push(address);
  }
  return out;
}

/**
 * The attachment name Curaleaf asked for:
 * `Curaleaf-new-account_[GPhC premises no.]_[Branch name]_[YYYY-MM-DD].pdf`, the date being
 * the submission date in UK time, with characters unsafe in filenames taken out of the name.
 */
export function curaleafFormFilename(gphcNumber: string, branchName: string, submittedAt: string | null | undefined) {
  const safe = (value: string) => value
    .normalize('NFKC')
    .replace(/[\u0000-\u001f\u007f/\\:*?"<>|]/g, '')
    .replace(/\s+/g, ' ')
    .replace(/^[.\s]+|[.\s]+$/g, '')
    .slice(0, 80);
  const at = submittedAt ? new Date(submittedAt) : null;
  const date = londonCalendarDate(at && !Number.isNaN(at.getTime()) ? at : new Date());
  return `Curaleaf-new-account_${safe(gphcNumber) || 'unknown'}_${safe(branchName) || 'Pharmacy'}_${date}.pdf`;
}

function latestAcceptance(acceptances: PartnerTermsAcceptanceRecord[]) {
  return [...acceptances].sort((a, b) => String(b.acceptedAt).localeCompare(String(a.acceptedAt)))[0] ?? null;
}

/** "- item" lines for the Live email. Platform live is the news itself, never an open item. */
function outstanding(view: GoLiveChecklistView, section: 'required' | 'optional') {
  return view.items
    .filter(item => item.section === section && !item.done && item.key !== 'platform_live')
    .map(item => `- ${item.label}`);
}

/**
 * The OnboardingEmails port over narrow dependencies. Lifecycle methods never throw and
 * send each email once (idempotency keys below); `resend` is admin's own action, so it
 * reports what it cannot do (HttpError) and lets a failed queue write surface.
 */
export function createOnboardingEmails(deps: OnboardingEmailsDeps): OnboardingEmails {
  const now = () => deps.now?.() ?? new Date();
  const warn = deps.warn ?? ((message, details) => console.warn(message, details));
  const curaleafRecipients = deps.curaleafRecipients ?? (() => ({ to: curaleafApplicationTo(), cc: curaleafApplicationCc() }));

  async function signerFor(request: PharmacyOnboardingRequestRecord | null, organisationId: string | null) {
    const forRequest = request ? latestAcceptance(await deps.requests.findTermsAcceptances(request.id)) : null;
    if (forRequest || !organisationId) return forRequest;
    return latestAcceptance(await deps.requests.findTermsAcceptancesForOrganisation(organisationId));
  }

  async function worldpaySubmitted(requestId: string | null, organisationId: string | null) {
    const [forRequest, forBranch] = await Promise.all([
      requestId ? deps.worldpayApplications.findForRequest(requestId) : Promise.resolve(null),
      organisationId ? deps.worldpayApplications.findForOrganisation(organisationId) : Promise.resolve(null),
    ]);
    return [forRequest, forBranch].some(record => Boolean(record && record.status !== 'DRAFT'));
  }

  function pharmacyPayload(content: OnboardingContent, template: { subject: string; body: string }, fields: Record<string, string>, flags: Record<string, boolean>) {
    return {
      subject: mergeSubject(template.subject, fields),
      paragraphs: mergeTemplate(template.body, fields, flags),
      fromName: content.addresses.displayName,
      replyTo: content.addresses.pharmacyReplyTo,
    };
  }

  async function buildSent(request: PharmacyOnboardingRequestRecord): Promise<Built> {
    const [content, signer, worldpay] = await Promise.all([
      readOnboardingContent(deps.content),
      signerFor(request, null),
      worldpaySubmitted(request.id, request.organisationId),
    ]);
    const termsLink = partnerTermsLink(content);
    const fields = {
      'Branch name': request.pharmacyName,
      'Signer first name': firstWord(signer?.signerName) || firstWord(request.pharmacistName),
      'Signer full name': signer?.signerName?.trim() || request.pharmacistName,
      'Registered company name': signer?.registeredCompanyName?.trim() || request.registeredCompanyName,
      // The day the application went to Curaleaf, which is when the Terms were accepted.
      'Submission date': londonDate(signer?.acceptedAt ?? request.createdAt),
      'Terms version': signer?.termsVersion ?? content.partnerTerms.version,
      'Acceptance date': londonDate(signer?.acceptedAt),
      'Partner Terms link': termsLink,
    };
    return {
      to: uniqueAddresses([signer?.signerEmail, request.pharmacyEmail]),
      cc: [],
      payload: pharmacyPayload(content, content.sent, fields, {
        'no worldpay': !worldpay,
        'worldpay submitted': worldpay,
        'terms link': Boolean(termsLink),
      }),
      organisationId: request.organisationId,
      onboardingRequestId: request.id,
    };
  }

  async function buildCuraleaf(request: PharmacyOnboardingRequestRecord, demo: boolean): Promise<Built> {
    const content = await readOnboardingContent(deps.content);
    const submittedAt = request.createdAt || now().toISOString();
    const fields = {
      'Branch name': request.pharmacyName,
      'GPhC premises no.': request.gphcNumber,
      'Submission date': londonDate(submittedAt),
      'Submission time': londonTime(submittedAt),
    };
    const recipients = curaleafRecipients();
    const subject = mergeSubject(content.curaleafApplication.subject, fields);
    return {
      // A demo pharmacy's application goes to HHH only, never to Curaleaf.
      to: demo ? uniqueAddresses(recipients.cc) : uniqueAddresses(recipients.to),
      cc: demo ? [] : uniqueAddresses(recipients.cc),
      payload: {
        ...(demo ? { demo: true } : {}),
        subject: `${demo ? DEMO_SUBJECT_PREFIX : ''}${subject}`,
        paragraphs: mergeTemplate(content.curaleafApplication.body, fields, {}),
        fromName: content.addresses.displayName,
        replyTo: content.addresses.curaleafReplyTo,
        branchName: request.pharmacyName,
        gphcNumber: request.gphcNumber,
        submittedAt,
        [FILLED_FORM_PATH_KEY]: request.filledFormStoragePath,
        [FILLED_FORM_NAME_KEY]: curaleafFormFilename(request.gphcNumber, request.pharmacyName, submittedAt),
        ...(request.licenceStoragePath ? {
          [LICENCE_PATH_KEY]: request.licenceStoragePath,
          [LICENCE_TYPE_KEY]: request.licenceContentType,
          [LICENCE_NAME_KEY]: request.licenceFilename,
        } : {}),
      },
      organisationId: request.organisationId,
      onboardingRequestId: request.id,
    };
  }

  async function buildActivation(request: PharmacyOnboardingRequestRecord, organisationId: string): Promise<Built> {
    const [content, signer, worldpay] = await Promise.all([
      readOnboardingContent(deps.content),
      signerFor(request, organisationId),
      worldpaySubmitted(request.id, organisationId),
    ]);
    const training = content.links.trainingBookingUrl.trim();
    const fields = {
      'Branch name': request.pharmacyName,
      'Signer first name': firstWord(signer?.signerName) || firstWord(request.pharmacistName),
      'Training booking link': training,
    };
    return {
      to: uniqueAddresses([signer?.signerEmail, request.pharmacyEmail]),
      cc: [],
      payload: pharmacyPayload(content, content.activation, fields, {
        'training link': Boolean(training),
        'no training link': !training,
        'no worldpay': !worldpay,
        'worldpay submitted': worldpay,
      }),
      organisationId,
      onboardingRequestId: request.id,
    };
  }

  async function buildHold(request: PharmacyOnboardingRequestRecord, reason: OnboardingHoldReason): Promise<Built> {
    const [content, signer, worldpay] = await Promise.all([
      readOnboardingContent(deps.content),
      signerFor(request, request.organisationId),
      worldpaySubmitted(request.id, request.organisationId),
    ]);
    const fields = {
      'Branch name': request.pharmacyName,
      'Signer first name': firstWord(signer?.signerName) || firstWord(request.pharmacistName),
    };
    // Only the chosen reason's block: every reason flag is set, true for one.
    const flags: Record<string, boolean> = Object.fromEntries(
      ONBOARDING_HOLD_REASONS.map(each => [HOLD_REASON_FLAG[each], each === reason]),
    );
    flags['worldpay submitted'] = worldpay;
    return {
      to: uniqueAddresses([signer?.signerEmail, request.pharmacyEmail]),
      cc: [],
      payload: pharmacyPayload(content, content.hold, fields, flags),
      organisationId: request.organisationId,
      onboardingRequestId: request.id,
    };
  }

  async function buildLive(organisationId: string): Promise<Built> {
    const [organisation, request] = await Promise.all([
      deps.findOrganisation(organisationId),
      deps.requests.findByOrganisationId(organisationId),
    ]);
    if (!organisation) throw new HttpError(404, 'Pharmacy record not found.', 'NOT_FOUND');
    const [content, signer, curaleaf, worldpay, checklist] = await Promise.all([
      readOnboardingContent(deps.content),
      signerFor(request, organisationId),
      deps.findConnection(organisationId, 'CURALEAF'),
      deps.findConnection(organisationId, 'WORLDPAY'),
      deps.goLiveChecklist(organisationId),
    ]);
    const required = outstanding(checklist, 'required');
    const optional = outstanding(checklist, 'optional');
    const validated = Boolean(worldpayValidatedAt(worldpay));
    const fields = {
      'Branch name': organisation.name || request?.pharmacyName || '',
      'Signer first name': firstWord(signer?.signerName) || firstWord(request?.pharmacistName) || firstWord(organisation.mainContactName),
      // The Curaleaf customer id only. The API key is a secret and is never read here.
      'PHAR code': curaleaf?.externalCustomerId?.trim() ?? '',
      'Outstanding required items': required.join('\n'),
      'Outstanding optional items': optional.join('\n'),
    };
    // A branch with no onboarding request (set up before it existed) uses its own inbox.
    const branchAddress = request ? request.pharmacyEmail : (organisation.pharmacyEmail || organisation.mainContactEmail);
    return {
      to: uniqueAddresses([signer?.signerEmail, branchAddress]),
      cc: [],
      payload: pharmacyPayload(content, content.live, fields, {
        'worldpay validated': validated,
        'worldpay not validated': !validated,
        'required outstanding': required.length > 0,
        'optional outstanding': optional.length > 0,
      }),
      organisationId,
      onboardingRequestId: request?.id ?? null,
    };
  }

  async function queue(kind: OnboardingEmailKind, built: Built, keyParts: Array<string | null | undefined>) {
    if (built.to.length === 0) {
      warn('Onboarding email has no recipient', { kind, onboardingRequestId: built.onboardingRequestId });
      return false;
    }
    const outcome = await queueSharedEmail(deps.notifications, {
      to: built.to,
      cc: built.cc,
      templateCode: ONBOARDING_EMAIL_TEMPLATE[kind],
      payload: built.payload,
      keyParts,
      organisationId: built.organisationId,
      onboardingRequestId: built.onboardingRequestId,
    });
    return outcome.queued;
  }

  /** Once-only: skip the reads when this key was queued before, then queue. Never throws. */
  async function once(kind: OnboardingEmailKind, keyParts: Array<string | null | undefined>, build: () => Promise<Built>, context: Record<string, unknown>) {
    try {
      if (await deps.notifications.findByIdempotencyKey(messageIdempotencyKey(keyParts))) return;
      await queue(kind, await build(), keyParts);
    } catch (error) {
      // Never blocks the state change that triggered it; admin can resend from the send log.
      warn('Onboarding email could not be queued', {
        kind,
        ...context,
        reason: error instanceof Error ? error.message.slice(0, 160) : 'unknown',
      });
    }
  }

  return {
    async applicationReceived({ request, demo }) {
      const context = { onboardingRequestId: request.id };
      await once('sent', ['onboarding-sent', request.id], () => buildSent(request), context);
      await once('curaleafApplication', ['curaleaf-new-account-application', request.id], () => buildCuraleaf(request, demo), context);
    },

    async activated({ request, organisationId }) {
      await once('activation', ['onboarding-activation', request.id], () => buildActivation(request, organisationId), { onboardingRequestId: request.id });
    },

    async held({ request, reason, heldAt }) {
      await once('hold', ['onboarding-hold', request.id, heldAt], () => buildHold(request, reason), { onboardingRequestId: request.id, reason });
    },

    async wentLive({ organisationId }) {
      await once('live', ['onboarding-live', organisationId], () => buildLive(organisationId), { organisationId });
    },

    async resend({ requestId, kind }) {
      const request = await deps.requests.findById(requestId);
      if (!request) throw new HttpError(404, 'Onboarding request not found.', 'NOT_FOUND');
      const resend = ['resend', now().toISOString()];
      const notYet = (message: string) => new HttpError(409, message, 'ONBOARDING_EMAIL_NOT_APPLICABLE');
      // Sent and the application to Curaleaf go only once the Partner Terms are accepted, resent or not.
      if ((kind === 'sent' || kind === 'curaleafApplication') && (await deps.requests.findTermsAcceptances(request.id)).length === 0) {
        throw notYet('The pharmacy has not accepted the Partner Terms, so this email has not been sent yet.');
      }
      let built: Built;
      let keyParts: Array<string | null | undefined>;
      switch (kind) {
        case 'sent':
          built = await buildSent(request);
          keyParts = ['onboarding-sent', request.id, ...resend];
          break;
        case 'curaleafApplication':
          built = await buildCuraleaf(request, await deps.isDemoGphc(request.gphcNumber));
          keyParts = ['curaleaf-new-account-application', request.id, ...resend];
          break;
        case 'activation':
          if (!request.organisationId) throw notYet('This request has not been activated, so there is no activation email to resend.');
          built = await buildActivation(request, request.organisationId);
          keyParts = ['onboarding-activation', request.id, ...resend];
          break;
        case 'hold': {
          const { holdReason, heldAt } = request;
          if (request.status !== 'ON_HOLD' || !holdReason || !ONBOARDING_HOLD_REASONS.includes(holdReason)) {
            throw notYet('This request is not on hold, so there is no hold email to resend.');
          }
          built = await buildHold(request, holdReason);
          keyParts = ['onboarding-hold', request.id, heldAt ?? '', ...resend];
          break;
        }
        case 'live': {
          const organisation = request.organisationId ? await deps.findOrganisation(request.organisationId) : null;
          if (!organisation || organisation.status !== 'LIVE') throw notYet('This branch is not live, so there is no live email to resend.');
          built = await buildLive(organisation.id);
          keyParts = ['onboarding-live', organisation.id, ...resend];
          break;
        }
        default:
          throw new HttpError(404, 'Unknown onboarding email.', 'NOT_FOUND');
      }
      if (built.to.length === 0) throw notYet('There is no address to send this email to.');
      await queue(kind, built, keyParts);
    },
  };
}

function logStatus(record: NotificationOutboxRecord): OnboardingEmailLogEntry['status'] {
  if (record.status === 'SENT') return 'SENT';
  if (record.status === 'FAILED' || record.status === 'CANCELLED') return 'FAILED';
  return 'PENDING';
}

/** A request's send log for admin, newest first: which email, to whom, and how it went. */
export async function onboardingEmailLog(
  repo: Pick<NotificationRepositoryPort, 'listForOnboardingRequest'>,
  onboardingRequestId: string,
): Promise<OnboardingEmailLogEntry[]> {
  const rows = (await repo.listForOnboardingRequest?.(onboardingRequestId)) ?? [];
  const entries: OnboardingEmailLogEntry[] = [];
  for (const row of rows) {
    const kind = KIND_BY_TEMPLATE.get(row.templateCode);
    if (!kind) continue;
    const recipients = row.toRecipients?.length
      ? [...row.toRecipients, ...(row.ccRecipients ?? [])]
      : [row.encryptedRecipient].filter((address): address is string => Boolean(address));
    entries.push({
      id: row.id,
      kind,
      recipients,
      status: logStatus(row),
      queuedAt: row.createdAt,
      sentAt: row.sentAt ?? null,
      failedAt: row.failedAt ?? null,
      failureCode: row.status === 'CANCELLED' ? (row.failureCode || 'CANCELLED') : row.failureCode ?? null,
    });
  }
  return entries.sort((a, b) => String(b.queuedAt).localeCompare(String(a.queuedAt)));
}

let shared: OnboardingEmails | null = null;

/** The SQL-backed OnboardingEmails (outbox + PlatformContent). */
export function sqlOnboardingEmails(): OnboardingEmails {
  if (shared) return shared;
  const requests = new SqlPharmacyOnboardingRepository();
  const organisations = new SqlOrganisationRepository();
  const integrations = new SqlIntegrationRepository();
  const content = new SqlPlatformContentRepository();
  const checklistRepo = new SqlGoLiveChecklistRepository();
  shared = createOnboardingEmails({
    notifications: new SqlNotificationRepository(),
    content,
    requests,
    findOrganisation: id => organisations.findOrganisationById(id),
    worldpayApplications: new SqlWorldpayApplicationRepository(),
    findConnection: (id, integration) => integrations.findConnection(id, integration),
    goLiveChecklist: id => loadGoLiveChecklist({
      findOrganisation: orgId => organisations.findOrganisationById(orgId),
      checklistRepo,
      findWorldpayConnection: orgId => integrations.findConnection(orgId, 'WORLDPAY'),
      // Reading the checklist never reports progress to ClickUp.
      clickup: { checklistProgress: async () => undefined },
    }, id),
    isDemoGphc: gphc => isDemoGphc(content, gphc),
  });
  return shared;
}
