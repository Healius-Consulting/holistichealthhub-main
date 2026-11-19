import type { PartnerTermsAcceptanceRecord } from '../../domain/pharmacy-onboarding/terms.js';
import type { PartnerTermsRepository } from '../../repositories/ports/partner-terms.port.js';
import type { NotificationRepositoryPort } from '../../repositories/ports/notification.port.js';
import { queueSharedEmail } from '../notifications/email-outbox.js';
import { SIGNED_TERMS_NAME_KEY, SIGNED_TERMS_PATH_KEY } from './emails.js';
import { recordPromptSigned } from './partner-terms.service.js';
import { signerRoleLabel, stampSignedCopy, ukDateTime } from './signed-terms-copy.js';

/**
 * Everything after a Partner Terms signature, at sign-up or at the login prompt: the
 * branch's prompt is marked signed, the signed copy (the Terms PDF plus a stamped
 * signature page) is stored, and the confirmation email goes with it attached.
 * None of it can undo the signature: a failure is logged and the rest carries on.
 */

export type TermsSigningDeps = {
  storage: { downloadFile(path: string): Promise<{ bytes: Buffer }>; saveObject(path: string, bytes: Buffer, contentType: string): Promise<unknown> };
  terms: Pick<PartnerTermsRepository, 'findDocument' | 'findPrompt' | 'savePrompt'>;
  acceptances: { setTermsSignedCopy(id: string, path: string): Promise<void> };
  notifications: Pick<NotificationRepositoryPort, 'enqueue'>;
  now?: () => Date;
  warn?: (message: string, details: Record<string, unknown>) => void;
};

export type SignedPharmacy = {
  organisationId: string | null;
  onboardingRequestId: string | null;
  pharmacyName: string;
  gphcNumber: string | null;
  pharmacyEmail: string | null;
};

export function signedCopyPath(acceptance: Pick<PartnerTermsAcceptanceRecord, 'id'>, pharmacy: Pick<SignedPharmacy, 'organisationId' | 'onboardingRequestId'>) {
  const owner = pharmacy.organisationId ?? `request-${pharmacy.onboardingRequestId ?? 'unknown'}`;
  return `partner-terms/signed/${owner}/${acceptance.id}.pdf`;
}

export function signedCopyFilename(version: string, pharmacyName: string) {
  const clean = (text: string) => text.replace(/[^A-Za-z0-9 ._-]/g, '').trim().replace(/\s+/g, '-').slice(0, 60);
  return `Partner-Terms-${clean(version) || 'signed'}-${clean(pharmacyName) || 'pharmacy'}.pdf`;
}

export async function afterTermsSigned(deps: TermsSigningDeps, acceptance: PartnerTermsAcceptanceRecord, pharmacy: SignedPharmacy) {
  const now = deps.now?.() ?? new Date();
  const warn = deps.warn ?? ((message, details) => console.warn(message, details));
  if (!acceptance.documentId) return { signedCopyPath: null };

  if (pharmacy.organisationId) {
    await recordPromptSigned(deps.terms, pharmacy.organisationId, acceptance.documentId, now)
      .catch(error => warn('Partner Terms prompt not marked signed', { error: error instanceof Error ? error.message : 'unknown' }));
  }

  let path: string | null = acceptance.signedCopyPath ?? null;
  // A retry of the same signature reuses the copy already made.
  if (!path) try {
    const document = await deps.terms.findDocument(acceptance.documentId);
    if (!document) throw new Error('Terms version not found');
    const original = await deps.storage.downloadFile(document.storagePath);
    const stamped = await stampSignedCopy(new Uint8Array(original.bytes), {
      pharmacyName: pharmacy.pharmacyName,
      registeredCompanyName: acceptance.registeredCompanyName,
      gphcPremisesNumber: pharmacy.gphcNumber,
      signerName: acceptance.signerName,
      signerRole: signerRoleLabel(acceptance.signerRole, acceptance.signerRoleOther),
      signerGphcNumber: acceptance.signerGphcNumber,
      signerEmail: acceptance.signerEmail,
      signedAt: acceptance.acceptedAt,
      termsVersion: acceptance.termsVersion,
      acceptanceId: acceptance.id,
    });
    path = signedCopyPath(acceptance, pharmacy);
    await deps.storage.saveObject(path, Buffer.from(stamped), 'application/pdf');
    await deps.acceptances.setTermsSignedCopy(acceptance.id, path);
  } catch (error) {
    warn('Partner Terms signed copy not made', { acceptanceId: acceptance.id, error: error instanceof Error ? error.message : 'unknown' });
    path = null;
  }

  try {
    const to = [pharmacy.pharmacyEmail, acceptance.signerEmail].filter((address): address is string => Boolean(address?.trim()));
    if (to.length) {
      await queueSharedEmail(deps.notifications, {
        to,
        templateCode: 'pharmacy_partner_terms_signed',
        organisationId: pharmacy.organisationId,
        keyParts: ['partner-terms-signed', acceptance.id],
        payload: {
          organisationId: pharmacy.organisationId ?? '',
          pharmacyName: pharmacy.pharmacyName,
          termsVersion: acceptance.termsVersion,
          signerName: acceptance.signerName,
          signedOn: ukDateTime(acceptance.acceptedAt),
          ...(path ? { [SIGNED_TERMS_PATH_KEY]: path, [SIGNED_TERMS_NAME_KEY]: signedCopyFilename(acceptance.termsVersion, pharmacy.pharmacyName) } : {}),
        },
      });
    }
  } catch (error) {
    warn('Partner Terms confirmation email not queued', { acceptanceId: acceptance.id, error: error instanceof Error ? error.message : 'unknown' });
  }
  return { signedCopyPath: path };
}
