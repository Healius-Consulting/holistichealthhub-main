import { randomUUID } from 'node:crypto';
import { HttpError } from '../../domain/common/errors.js';
import { compactGphcNumber } from '../../domain/pharmacy-onboarding/request.js';
import type { WorldpayForm, WorldpaySubmissionNote } from '../../domain/pharmacy-onboarding/worldpay.js';
import type { ImmediateEmail } from '../workers/deliver-messages.js';
import { worldpayFormRecipients } from './onboarding-config.js';
import { renderWorldpayPdf } from './worldpay-pdf.js';

export type WorldpayNoteRepository = {
  findWorldpaySubmissionByIdempotencyKey(idempotencyKey: string): Promise<WorldpaySubmissionNote | null>;
  insertWorldpaySubmission(note: WorldpaySubmissionNote): Promise<void>;
  hasAcceptedTermsForGphc(gphcNumber: string): Promise<boolean>;
  /** Portal only: Terms accepted from the branch's own portal carry its id and no request. */
  findTermsAcceptancesForOrganisation?(organisationId: string): Promise<Array<{ id: string }>>;
};

/** An activated branch sending the form from its portal. Its GPhC comes from the account, not the form. */
export type WorldpayBranch = { organisationId: string; gphcNumber: string };

export const WORLDPAY_BEFORE_TERMS_MESSAGE = 'Send the Curaleaf account form and accept the Partner Terms first. The Worldpay form opens after that.';

/** Accepted against an onboarding request for this GPhC, or (portal) by the branch itself. */
async function termsAccepted(repo: WorldpayNoteRepository, gphcNumber: string, branch?: WorldpayBranch) {
  if (await repo.hasAcceptedTermsForGphc(gphcNumber)) return true;
  if (!branch || !repo.findTermsAcceptancesForOrganisation) return false;
  return (await repo.findTermsAcceptancesForOrganisation(branch.organisationId)).length > 0;
}

function fileSlug(name: string) {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 60) || 'pharmacy';
}

/**
 * Emails the Worldpay form as a PDF and keeps only a note that it was sent.
 * The answers live in memory for this request and nowhere else. The email goes
 * first: if the note then fails, a retry with the same key reaches Resend's
 * idempotency check instead of sending a second copy.
 */
export async function submitWorldpayForm(
  repo: WorldpayNoteRepository,
  sendEmail: (email: ImmediateEmail) => Promise<void>,
  form: WorldpayForm,
  now: Date = new Date(),
  branch?: WorldpayBranch,
): Promise<WorldpaySubmissionNote> {
  const gphcNumber = compactGphcNumber(branch?.gphcNumber ?? form.gphcNumber);
  if (!gphcNumber) throw new HttpError(400, 'Enter the GPhC number.', 'INVALID_INPUT');
  const existing = await repo.findWorldpaySubmissionByIdempotencyKey(form.idempotencyKey);
  if (existing) return existing;
  // The order is Curaleaf form, then Partner Terms, then Worldpay.
  if (!(await termsAccepted(repo, gphcNumber, branch))) {
    throw new HttpError(409, WORLDPAY_BEFORE_TERMS_MESSAGE, 'ONBOARDING_TERMS_REQUIRED');
  }

  const pdf = await renderWorldpayPdf({ ...form, gphcNumber }, now);
  await sendEmail({
    templateCode: 'admin_worldpay_form_submitted',
    to: worldpayFormRecipients(),
    payload: { tradingName: form.tradingName, gphcNumber, contactName: form.contactName },
    attachments: [{ filename: `worldpay-${fileSlug(form.tradingName)}.pdf`, content: pdf, contentType: 'application/pdf' }],
    idempotencyKey: `worldpay-${form.idempotencyKey}`,
  });

  const note: WorldpaySubmissionNote = {
    id: randomUUID(),
    gphcNumber,
    tradingName: form.tradingName,
    submittedAt: now.toISOString(),
    idempotencyKey: form.idempotencyKey,
    ...(branch ? { organisationId: branch.organisationId } : {}),
  };
  await repo.insertWorldpaySubmission(note);
  return note;
}
