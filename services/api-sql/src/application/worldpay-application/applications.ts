import { HttpError } from '../../domain/common/errors.js';
import {
  applicationWebsite,
  usesHhhWebsite,
  WORLDPAY_APPLICATION_DEFAULTS,
  withoutSensitive,
  worldpayAnswersDraftSchema,
  worldpayDeclarationSchema,
  worldpayProblems,
  type WorldpayAnswers,
} from '../../domain/worldpay-application/answers.js';
import {
  mergeSubject,
  mergeTemplate,
  WORLDPAY_CONTENT_KEYS,
  worldpayContentFrom,
  type WorldpayContent,
} from '../../domain/worldpay-application/content.js';
import type {
  PlatformContentRepository,
  WorldpayApplicationRecord,
  WorldpayApplicationRepository,
  WorldpayApplicationStatus,
  WorldpayApplicationSummaryFields,
} from '../../repositories/ports/worldpay-application.port.js';
import type { ImmediateEmail } from '../workers/deliver-messages.js';
import { applicationFileBase, renderApplicationPdf, renderApplicationXlsx } from './documents.js';

/**
 * The Worldpay merchant application (spec 01). A branch, or an onboarding request
 * before its branch exists, has at most one live application. It is saved as a
 * draft while it is filled in, submitted once, emailed to Worldpay's route (WP-01),
 * then moved through its statuses by admin. The pharmacy gets no email about it (WP-02
 * was dropped, 19 Nov 2026): the onboarding emails mention it where it matters.
 *
 * Nothing here writes answers into logs, ClickUp or email bodies: emails carry only
 * names, the reference and the contact, and the answers travel only as attachments.
 */

export type WorldpayOwner =
  | { kind: 'branch'; organisationId: string; gphcNumber: string }
  | { kind: 'request'; onboardingRequestId: string; gphcNumber: string };

export interface WorldpayStorage {
  saveObject(path: string, bytes: Buffer, contentType: string): Promise<unknown>;
  downloadFile(path: string): Promise<{ bytes: Buffer; contentType: string | null }>;
  deleteFile(path: string): Promise<unknown>;
}

export interface WorldpayHooks {
  /** ClickUp, checklist and audit. Best effort: never throws into the submission. */
  submitted?(record: WorldpayApplicationRecord): Promise<void>;
  statusChanged?(record: WorldpayApplicationRecord, from: WorldpayApplicationStatus): Promise<void>;
}

export interface WorldpayDeps {
  repo: WorldpayApplicationRepository;
  content: PlatformContentRepository;
  storage: WorldpayStorage;
  sendEmail: (email: ImmediateEmail) => Promise<void>;
  hooks?: WorldpayHooks;
  now?: () => Date;
}

/** What the platform already knows, used to start a new application. */
export interface WorldpayPrefill {
  legalName?: string | null;
  tradingName?: string | null;
  gphcNumber?: string | null;
  tradingAddress?: string | null;
  landline?: string | null;
  businessEmail?: string | null;
  contactName?: string | null;
  contactPosition?: string | null;
  contactPhone?: string | null;
  contactEmail?: string | null;
}

export async function readWorldpayContent(content: PlatformContentRepository): Promise<WorldpayContent> {
  return worldpayContentFrom(await content.read(Object.values(WORLDPAY_CONTENT_KEYS)));
}

const text = (value: string | null | undefined) => value?.trim() ?? '';

export function startingAnswers(prefill: WorldpayPrefill, content: WorldpayContent): WorldpayAnswers {
  const d = WORLDPAY_APPLICATION_DEFAULTS;
  return worldpayAnswersDraftSchema.parse({
    business: {
      businessType: d.businessType,
      legalName: text(prefill.legalName),
      natureOfBusiness: d.natureOfBusiness,
      businessDescription: d.businessDescription,
      tradingName: text(prefill.tradingName),
      gphcNumber: text(prefill.gphcNumber),
      tradingAddress: text(prefill.tradingAddress),
      landline: text(prefill.landline),
      businessEmail: text(prefill.businessEmail),
      contactName: text(prefill.contactName),
      contactPosition: text(prefill.contactPosition),
      contactPhone: text(prefill.contactPhone),
      contactEmail: text(prefill.contactEmail),
    },
    financials: {
      expectedCardPayments: d.expectedCardPayments,
      averageTransaction: d.averageTransaction,
      accountName: text(prefill.legalName),
    },
    transactions: {
      terminalConnection: d.terminalConnection,
      faceToFace: d.faceToFace,
      phone: d.phone,
      internet: d.internet,
      immediate: d.immediate,
      oneToThreeDays: d.oneToThreeDays,
      threeToFiveDays: d.threeToFiveDays,
      fivePlusDays: d.fivePlusDays,
    },
    scheme: { ...content.schemeAnswers },
  });
}

function summaryOf(answers: WorldpayAnswers): WorldpayApplicationSummaryFields {
  const lookup = answers.companyLookup;
  const lookedUpAt = lookup?.lookedUpAt && !Number.isNaN(Date.parse(lookup.lookedUpAt)) ? new Date(lookup.lookedUpAt).toISOString() : null;
  return {
    legalName: answers.business.legalName.trim(),
    tradingName: answers.business.tradingName.trim(),
    usesHhhWebsite: usesHhhWebsite(answers),
    companyNumber: lookup?.companyNumber || null,
    companyStatus: lookup?.status || null,
    companyLookedUpAt: lookedUpAt,
    companyName: lookup?.companyName || null,
  };
}

async function findFor(repo: WorldpayApplicationRepository, owner: WorldpayOwner) {
  return owner.kind === 'branch' ? repo.findForOrganisation(owner.organisationId) : repo.findForRequest(owner.onboardingRequestId);
}

/** What the pharmacy sees for its application. */
export interface WorldpayApplicationView {
  id: string | null;
  status: WorldpayApplicationStatus | null;
  version: number;
  reference: string | null;
  answers: WorldpayAnswers;
  submittedAt: string | null;
  statusNote: string | null;
  statusChangedAt: string | null;
  /** Who Worldpay will contact, for the pharmacy's status line (B-16, and B-19 or B-13). */
  contactName: string;
  contactEmail: string;
  content: { pricingPanel: WorldpayContent['pricingPanel']; s04Note: string };
}

function viewOf(record: WorldpayApplicationRecord | null, answers: WorldpayAnswers, content: WorldpayContent): WorldpayApplicationView {
  // Notes are shown to the pharmacy only for the statuses that carry one.
  const noteShown = record && (record.status === 'QUERY' || record.status === 'WITHDRAWN' || record.status === 'DECLINED');
  return {
    id: record?.id ?? null,
    status: record?.status ?? null,
    version: record?.version ?? 0,
    reference: record?.reference ?? null,
    answers,
    submittedAt: record?.submittedAt ?? null,
    statusNote: noteShown ? record.statusNote : null,
    statusChangedAt: record?.statusChangedAt ?? null,
    contactName: answers.business.contactName,
    contactEmail: answers.business.contactEmail || answers.business.businessEmail,
    content: { pricingPanel: content.pricingPanel, s04Note: content.s04Note },
  };
}

export async function loadWorldpayApplication(deps: WorldpayDeps, owner: WorldpayOwner, prefill: WorldpayPrefill): Promise<WorldpayApplicationView> {
  const [record, content] = await Promise.all([findFor(deps.repo, owner), readWorldpayContent(deps.content)]);
  return viewOf(record, record ? record.answers : startingAnswers(prefill, content), content);
}

export async function saveWorldpayDraft(
  deps: WorldpayDeps,
  owner: WorldpayOwner,
  input: { id: string | null; version: number; answers: unknown },
): Promise<{ id: string; version: number }> {
  const answers = worldpayAnswersDraftSchema.parse(input.answers);
  const existing = await findFor(deps.repo, owner);
  if (!existing) {
    const id = await deps.repo.create({
      organisationId: owner.kind === 'branch' ? owner.organisationId : null,
      onboardingRequestId: owner.kind === 'request' ? owner.onboardingRequestId : null,
      gphcNumber: owner.gphcNumber,
      answers,
      ...summaryOf(answers),
    });
    return { id, version: 1 };
  }
  if (input.id && input.id !== existing.id) {
    throw new HttpError(409, 'This pharmacy already has a Worldpay application. Reload to continue it.', 'WORLDPAY_APPLICATION_CONFLICT');
  }
  if (existing.status !== 'DRAFT') {
    throw new HttpError(409, 'This Worldpay application has already been sent, so it can no longer be changed.', 'WORLDPAY_APPLICATION_SUBMITTED');
  }
  const saved = await deps.repo.saveDraft(existing.id, input.version, answers, summaryOf(answers));
  if (!saved) {
    throw new HttpError(409, 'Someone else at your pharmacy saved this application since you opened it. Reload to see their changes.', 'WORLDPAY_DRAFT_CONFLICT');
  }
  return { id: existing.id, version: input.version + 1 };
}

function londonYear(date: Date) {
  return Number(new Intl.DateTimeFormat('en-GB', { timeZone: 'Europe/London', year: 'numeric' }).format(date));
}

export async function nextReference(repo: WorldpayApplicationRepository, now: Date) {
  const prefix = `HHH-WP-${londonYear(now)}-`;
  const last = await repo.lastReference(prefix);
  const number = last ? Number(last.slice(prefix.length)) + 1 : 1;
  return `${prefix}${String(Number.isFinite(number) ? number : 1).padStart(4, '0')}`;
}

function firstName(name: string) {
  return name.trim().split(/\s+/)[0] ?? '';
}

function mergeFields(record: WorldpayApplicationRecord) {
  const b = record.answers.business;
  return {
    'legal name': b.legalName,
    'trading name': b.tradingName,
    'HHH reference': record.reference ?? '',
    'GPhC number': b.gphcNumber,
    'B-09': b.gphcNumber,
    'contact name': b.contactName,
    position: b.contactPosition,
    phone: b.contactPhone,
    'contact email': b.contactEmail || b.businessEmail,
    URL: applicationWebsite(record.answers),
    'submitter first name': firstName(record.submitterName ?? '') || 'there',
  };
}

/**
 * WP-01: the application, emailed to the HHH admin inbox to forward to Worldpay, with
 * the PDF, the spreadsheet and, for a pharmacy with no website of its own, the service
 * information PDF. Records the send
 * or the failure; a failure leaves the application Submitted for admin to Resend.
 */
export async function sendApplicationToWorldpay(deps: WorldpayDeps, record: WorldpayApplicationRecord, attempt = 'first'): Promise<boolean> {
  const now = deps.now?.() ?? new Date();
  const content = await readWorldpayContent(deps.content);
  try {
    if (!record.pdfStoragePath || !record.xlsxStoragePath) throw new Error('The application files have been deleted under the retention rules.');
    const fields = mergeFields(record);
    const noWebsite = usesHhhWebsite(record.answers);
    const base = applicationFileBase(record.answers, record.reference ?? record.id);
    const [pdf, xlsx] = await Promise.all([deps.storage.downloadFile(record.pdfStoragePath), deps.storage.downloadFile(record.xlsxStoragePath)]);
    const attachments = [
      { filename: `${base}.pdf`, content: pdf.bytes, contentType: 'application/pdf' },
      { filename: `${base}.xlsx`, content: xlsx.bytes, contentType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' },
    ];
    if (noWebsite) {
      if (!content.servicePdf) throw new Error('No service information PDF is uploaded in admin, and this pharmacy has no website. Upload it, then press Resend.');
      const pack = await deps.storage.downloadFile(content.servicePdf.storagePath);
      attachments.push({ filename: content.servicePdf.filename, content: pack.bytes, contentType: 'application/pdf' });
    }
    await deps.sendEmail({
      templateCode: 'worldpay_application_to_worldpay',
      to: content.recipients.to,
      cc: content.recipients.cc,
      payload: {
        subject: mergeSubject(content.wp01.subject, fields),
        paragraphs: mergeTemplate(content.wp01.body, fields, { 'own website': !noWebsite, 'no website': noWebsite }),
      },
      attachments,
      idempotencyKey: `worldpay-application:${record.id}:${attempt}`,
    });
    await deps.repo.recordDelivery(record.id, { sentAt: now.toISOString() });
    return true;
  } catch (error) {
    // The message names what failed, never the answers.
    const reason = error instanceof Error ? error.message : 'The email could not be sent.';
    await deps.repo.recordDelivery(record.id, { deliveryError: reason });
    return false;
  }
}

export async function submitWorldpayApplication(
  deps: WorldpayDeps,
  owner: WorldpayOwner,
  input: { id: string; version: number; answers: unknown; declaration: unknown; submitter: { uid: string | null; name: string; email: string } },
): Promise<WorldpayApplicationRecord> {
  const now = deps.now?.() ?? new Date();
  const answers = worldpayAnswersDraftSchema.parse(input.answers);
  const declaration = worldpayDeclarationSchema.parse(input.declaration);
  const existing = await findFor(deps.repo, owner);
  if (!existing || existing.id !== input.id) throw new HttpError(404, 'This Worldpay application could not be found. Reload the page.', 'WORLDPAY_APPLICATION_NOT_FOUND');
  if (existing.status !== 'DRAFT') return existing;
  if (answers.existingAccount === 'online') {
    throw new HttpError(409, 'This pharmacy already takes online payments with Worldpay, so there is nothing to send. Enter your API keys in Settings → Payments.', 'WORLDPAY_EXISTING_ACCOUNT');
  }
  const problems = worldpayProblems(answers, now);
  if (problems.length) {
    throw new HttpError(422, 'Some answers need attention before the application can be sent.', 'WORLDPAY_APPLICATION_INCOMPLETE', problems);
  }
  // Save the final answers first, so the version moves on and a stale tab cannot submit older ones.
  const saved = await deps.repo.saveDraft(existing.id, input.version, answers, summaryOf(answers));
  if (!saved) throw new HttpError(409, 'Someone else at your pharmacy saved this application since you opened it. Reload, check it, then send it.', 'WORLDPAY_DRAFT_CONFLICT');
  const version = input.version + 1;

  let submitted = false;
  let reference = '';
  for (let attempt = 0; attempt < 3 && !submitted; attempt += 1) {
    reference = await nextReference(deps.repo, now);
    const meta = { reference, submittedAt: now, signerName: declaration.signerName, signerPosition: declaration.signerPosition };
    const base = applicationFileBase(answers, reference);
    const pdfPath = `worldpay-applications/${existing.id}/${base}.pdf`;
    const xlsxPath = `worldpay-applications/${existing.id}/${base}.xlsx`;
    const [pdf, xlsx] = await Promise.all([renderApplicationPdf(answers, meta), renderApplicationXlsx(answers, meta)]);
    await Promise.all([
      deps.storage.saveObject(pdfPath, pdf, 'application/pdf'),
      deps.storage.saveObject(xlsxPath, xlsx, 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'),
    ]);
    try {
      submitted = await deps.repo.markSubmitted(existing.id, version, {
        reference,
        answers,
        submittedAt: now.toISOString(),
        submittedByUid: input.submitter.uid,
        submitterName: input.submitter.name.trim() || declaration.signerName,
        submitterEmail: input.submitter.email.trim(),
        signerName: declaration.signerName,
        signerPosition: declaration.signerPosition,
        pdfStoragePath: pdfPath,
        xlsxStoragePath: xlsxPath,
        ...summaryOf(answers),
      });
      if (!submitted) break;
    } catch (error) {
      // Two submissions took the same reference at once: the unique key refused one. Try the next number.
      await Promise.all([deps.storage.deleteFile(pdfPath), deps.storage.deleteFile(xlsxPath)]).catch(() => undefined);
      if (attempt === 2) throw error;
    }
  }
  const record = await deps.repo.findById(existing.id);
  if (!record) throw new HttpError(404, 'This Worldpay application could not be found. Reload the page.', 'WORLDPAY_APPLICATION_NOT_FOUND');
  if (!submitted) return record;

  // WP-01 goes to the HHH admin inbox. Admin forwards it to Worldpay and then marks it With Worldpay.
  await sendApplicationToWorldpay(deps, record);
  const latest = (await deps.repo.findById(record.id)) ?? record;
  await deps.hooks?.submitted?.(latest).catch(() => undefined);
  return latest;
}

const ADMIN_STATUSES: WorldpayApplicationStatus[] = ['WITH_WORLDPAY', 'QUERY', 'ACCOUNT_OPEN', 'WITHDRAWN', 'DECLINED', 'SUBMITTED'];

export async function setWorldpayApplicationStatus(
  deps: WorldpayDeps,
  id: string,
  input: { status: WorldpayApplicationStatus; note: string | null; byUid: string | null },
) {
  if (!ADMIN_STATUSES.includes(input.status)) throw new HttpError(400, 'That status cannot be set by hand.', 'WORLDPAY_STATUS_INVALID');
  const record = await deps.repo.findById(id);
  if (!record) throw new HttpError(404, 'Worldpay application not found.', 'WORLDPAY_APPLICATION_NOT_FOUND');
  if (record.status === 'DRAFT') throw new HttpError(409, 'A draft has not been sent yet, so its status cannot change.', 'WORLDPAY_APPLICATION_DRAFT');
  if (input.status === 'QUERY' && !input.note?.trim()) throw new HttpError(400, 'Write the query for the pharmacy.', 'WORLDPAY_QUERY_NOTE_REQUIRED');
  const at = (deps.now?.() ?? new Date()).toISOString();
  await deps.repo.setStatus(id, input.status, { note: input.note?.trim() || null, byUid: input.byUid, at });
  const updated = (await deps.repo.findById(id)) ?? record;
  await deps.hooks?.statusChanged?.(updated, record.status).catch(() => undefined);
  return updated;
}

/** Account open or connected, set automatically from Settings → Payments. Only moves an application forward. */
export async function markWorldpayAccount(deps: WorldpayDeps, organisationId: string, status: 'ACCOUNT_OPEN' | 'CONNECTED') {
  const record = await deps.repo.findForOrganisation(organisationId);
  if (!record || record.status === 'DRAFT' || record.status === status || record.status === 'CONNECTED') return null;
  if (status === 'ACCOUNT_OPEN' && record.status === 'ACCOUNT_OPEN') return null;
  const at = (deps.now?.() ?? new Date()).toISOString();
  await deps.repo.setStatus(record.id, status, { note: null, byUid: null, at });
  const updated = (await deps.repo.findById(record.id)) ?? record;
  await deps.hooks?.statusChanged?.(updated, record.status).catch(() => undefined);
  return updated;
}

export async function resendWorldpayApplication(deps: WorldpayDeps, id: string) {
  const record = await deps.repo.findById(id);
  if (!record) throw new HttpError(404, 'Worldpay application not found.', 'WORLDPAY_APPLICATION_NOT_FOUND');
  if (record.status === 'DRAFT') throw new HttpError(409, 'A draft has not been submitted yet.', 'WORLDPAY_APPLICATION_DRAFT');
  if (record.sensitiveDeletedAt) throw new HttpError(410, 'This application has been cleared under the retention rules, so it cannot be resent.', 'WORLDPAY_APPLICATION_CLEARED');
  const sent = await sendApplicationToWorldpay(deps, record, `resend-${Date.now()}`);
  const updated = (await deps.repo.findById(id)) ?? record;
  if (!sent) throw new HttpError(502, updated.deliveryError ?? 'The email could not be sent.', 'WORLDPAY_SEND_FAILED');
  return updated;
}

export const CLOSED_RETENTION_DAYS = 30;
export const DRAFT_RETENTION_DAYS = 90;

/**
 * 30 days after an application reaches Account open, Connected, Withdrawn or Declined,
 * empty the principals and bank fields and delete the files; delete drafts untouched
 * for 90 days. Failures are counted, not thrown, like the other retention steps.
 */
export async function applyWorldpayRetention(deps: Pick<WorldpayDeps, 'repo' | 'storage' | 'now'>) {
  const now = deps.now?.() ?? new Date();
  const day = 24 * 60 * 60 * 1000;
  const records = await deps.repo.listForRetention(new Date(now.getTime() - CLOSED_RETENTION_DAYS * day).toISOString(), new Date(now.getTime() - DRAFT_RETENTION_DAYS * day).toISOString());
  const result = { cleared: 0, draftsDeleted: 0, failed: 0 };
  for (const record of records) {
    try {
      if (record.status === 'DRAFT') {
        await deps.repo.deleteDraft(record.id);
        result.draftsDeleted += 1;
        continue;
      }
      await Promise.all([record.pdfStoragePath, record.xlsxStoragePath].filter((path): path is string => Boolean(path)).map(path => deps.storage.deleteFile(path)));
      await deps.repo.clearSensitive(record.id, withoutSensitive(record.answers), now.toISOString());
      result.cleared += 1;
    } catch {
      result.failed += 1;
    }
  }
  return result;
}
