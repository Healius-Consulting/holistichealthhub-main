import { z } from 'zod';
import {
  emptyPrompt,
  PROMPTED_BRANCH_STATUSES,
  type PartnerTermsDocumentRecord,
  type PartnerTermsPromptRecord,
} from '../../domain/pharmacy-onboarding/partner-terms.js';
import type { PartnerTermsAcceptanceRecord } from '../../domain/pharmacy-onboarding/terms.js';
import type { PartnerTermsRepository } from '../../repositories/ports/partner-terms.port.js';
import type { PlatformContentRepository } from '../../repositories/ports/worldpay-application.port.js';

/**
 * The one place that decides whether the Partner Terms are switched on, which version
 * is current, and whether a pharmacy still owes a signature for it.
 *
 * Off (the default, and the state a pre-file row reads as): sign-up has no Terms step,
 * the Curaleaf form sends the Curaleaf application itself, Worldpay opens straight
 * after it, and nobody is prompted. On: new sign-ups must sign before the application
 * goes; every activated branch is asked at login to sign the current version.
 */

export const PARTNER_TERMS_SETTINGS_KEY = 'onboarding.partnerTerms';

export const partnerTermsSettingsSchema = z.object({
  enabled: z.boolean(),
  currentDocumentId: z.uuid().nullable(),
});
export type PartnerTermsSettings = z.infer<typeof partnerTermsSettingsSchema>;

export const PARTNER_TERMS_SETTINGS_DEFAULT: PartnerTermsSettings = { enabled: false, currentDocumentId: null };

export type PartnerTermsState = {
  settings: PartnerTermsSettings;
  /** The current published, unwithdrawn version, if any. */
  document: PartnerTermsDocumentRecord | null;
  /** Switched on, with a current version to sign. */
  on: boolean;
};

export type PartnerTermsStateDeps = {
  content: Pick<PlatformContentRepository, 'read'>;
  repo: Pick<PartnerTermsRepository, 'findDocument'>;
};

export async function readPartnerTermsSettings(content: Pick<PlatformContentRepository, 'read'>): Promise<PartnerTermsSettings> {
  const stored = await content.read([PARTNER_TERMS_SETTINGS_KEY]);
  const parsed = partnerTermsSettingsSchema.safeParse(stored[PARTNER_TERMS_SETTINGS_KEY]);
  // The text-era row ({published, version, text}) fails this and reads as off.
  return parsed.success ? parsed.data : PARTNER_TERMS_SETTINGS_DEFAULT;
}

export function isLiveDocument(document: PartnerTermsDocumentRecord | null | undefined): document is PartnerTermsDocumentRecord {
  return Boolean(document?.publishedAt && !document.withdrawnAt);
}

export async function partnerTermsState(deps: PartnerTermsStateDeps): Promise<PartnerTermsState> {
  const settings = await readPartnerTermsSettings(deps.content);
  const found = settings.currentDocumentId ? await deps.repo.findDocument(settings.currentDocumentId) : null;
  const document = isLiveDocument(found) ? found : null;
  return { settings, document, on: settings.enabled && document !== null };
}

/** Whether these acceptances include one for the current version. */
export function signedCurrent(state: PartnerTermsState, acceptances: Pick<PartnerTermsAcceptanceRecord, 'documentId'>[]) {
  return Boolean(state.document && acceptances.some(row => row.documentId === state.document!.id));
}

/** An activated branch that can log in, while the Terms are on, without a signature for the current version. */
export function owesSignature(
  state: PartnerTermsState,
  branch: { status: string },
  acceptances: Pick<PartnerTermsAcceptanceRecord, 'documentId'>[],
) {
  return state.on && PROMPTED_BRANCH_STATUSES.has(branch.status) && !signedCurrent(state, acceptances);
}

/** The version a new acceptance records: the current document's. */
export function acceptanceTerms(state: PartnerTermsState): { version: string; documentId: string } | null {
  return state.on && state.document ? { version: state.document.version, documentId: state.document.id } : null;
}

// ---------------------------------------------------------------------------
// The login prompt: views, skips and the signature, per branch and version.

type PromptRepo = Pick<PartnerTermsRepository, 'findPrompt' | 'savePrompt'>;

export async function recordPromptViewed(repo: PromptRepo, organisationId: string, documentId: string, viewer: { uid: string; email: string | null }, now: Date) {
  const prompt = await repo.findPrompt(organisationId, documentId) ?? emptyPrompt(organisationId, documentId);
  const at = now.toISOString();
  const next: PartnerTermsPromptRecord = {
    ...prompt,
    firstViewedAt: prompt.firstViewedAt ?? at,
    firstViewedByUid: prompt.firstViewedByUid ?? viewer.uid,
    firstViewedByEmail: prompt.firstViewedByEmail ?? viewer.email,
    lastViewedAt: at,
    viewCount: prompt.viewCount + 1,
  };
  await repo.savePrompt(next);
  return next;
}

export async function recordPromptSkipped(repo: PromptRepo, organisationId: string, documentId: string, uid: string, now: Date) {
  const prompt = await repo.findPrompt(organisationId, documentId) ?? emptyPrompt(organisationId, documentId);
  const at = now.toISOString();
  const next: PartnerTermsPromptRecord = {
    ...prompt,
    // A skip without a recorded view still starts the 7-day clock.
    firstViewedAt: prompt.firstViewedAt ?? at,
    firstViewedByUid: prompt.firstViewedByUid ?? uid,
    skipCount: prompt.skipCount + 1,
    lastSkippedAt: at,
    lastSkippedByUid: uid,
  };
  await repo.savePrompt(next);
  return next;
}

export async function recordPromptSigned(repo: PromptRepo, organisationId: string, documentId: string, now: Date) {
  const prompt = await repo.findPrompt(organisationId, documentId) ?? emptyPrompt(organisationId, documentId);
  if (prompt.signedAt) return prompt;
  const next = { ...prompt, signedAt: now.toISOString() };
  await repo.savePrompt(next);
  return next;
}
