import { queueEmailToRecipients, queueSharedEmail } from '../notifications/email-outbox.js';
import type { NotificationRepositoryPort } from '../../repositories/ports/notification.port.js';
import type { PharmacyOnboardingRequestRecord } from '../../domain/pharmacy-onboarding/request.js';
import { curaleafApplicationCc, curaleafApplicationTo } from './onboarding-config.js';

export const PHARMACY_ONBOARDING_PORTAL_URL = 'https://portal.holistichealthhub.live/admin/pharmacy-requests';

export const FILLED_FORM_PATH_KEY = 'filledFormStoragePath';
export const LICENCE_PATH_KEY = 'licenceStoragePath';
export const LICENCE_TYPE_KEY = 'licenceContentType';
export const LICENCE_NAME_KEY = 'licenceFilename';

/**
 * Queued when the pharmacy accepts the Partner Terms, never at Curaleaf form submission
 * alone: the pharmacy is told its request arrived, and Curaleaf gets the filled form as
 * one email (To Curaleaf, CC partner success). Each has one idempotency key, so a retried
 * acceptance never sends either twice.
 */
export async function queuePharmacyApplicationEmails(
  notificationRepo: NotificationRepositoryPort,
  request: PharmacyOnboardingRequestRecord,
  acceptedAt: string,
) {
  await queueEmailToRecipients(
    notificationRepo,
    [{ email: request.pharmacyEmail, displayName: request.pharmacyName }],
    'pharmacy_onboarding_submitted',
    {
      pharmacyName: request.pharmacyName,
      gphcNumber: request.gphcNumber,
      pharmacistName: request.pharmacistName,
      pharmacyEmail: request.pharmacyEmail,
    },
    ['pharmacy-onboarding-submitted', request.id],
  );
  await queueSharedEmail(notificationRepo, {
    to: curaleafApplicationTo(),
    cc: curaleafApplicationCc(),
    templateCode: 'curaleaf_new_account_application',
    payload: {
      branchName: request.pharmacyName,
      gphcNumber: request.gphcNumber,
      // When the Curaleaf form was submitted, the date it carries; the acceptance time if unknown.
      submittedAt: request.createdAt || acceptedAt,
      [FILLED_FORM_PATH_KEY]: request.filledFormStoragePath,
      ...(request.licenceStoragePath ? {
        [LICENCE_PATH_KEY]: request.licenceStoragePath,
        [LICENCE_TYPE_KEY]: request.licenceContentType,
        [LICENCE_NAME_KEY]: request.licenceFilename,
      } : {}),
    },
    keyParts: ['curaleaf-new-account-application', request.id],
  });
}

/** Tells the pharmacy its request is on hold. The admin's reason is never sent. */
export async function queuePharmacyOnboardingHeld(
  notificationRepo: NotificationRepositoryPort,
  request: Pick<PharmacyOnboardingRequestRecord, 'id' | 'pharmacyName' | 'pharmacyEmail' | 'decidedAt'>,
) {
  await queueEmailToRecipients(
    notificationRepo,
    [{ email: request.pharmacyEmail, displayName: request.pharmacyName }],
    'pharmacy_onboarding_held',
    { pharmacyName: request.pharmacyName },
    // A request can be held again after Unhold, so each hold gets its own key.
    ['pharmacy-onboarding-held', request.id, request.decidedAt ?? ''],
  );
}

export async function queuePharmacyOnboardingActivated(
  notificationRepo: NotificationRepositoryPort,
  request: Pick<PharmacyOnboardingRequestRecord, 'id' | 'pharmacyName' | 'pharmacyEmail'>,
) {
  await queueEmailToRecipients(
    notificationRepo,
    [{ email: request.pharmacyEmail, displayName: request.pharmacyName }],
    'pharmacy_onboarding_activated',
    { pharmacyName: request.pharmacyName },
    ['pharmacy-onboarding-activated', request.id],
  );
}

/** The decline email for a pharmacy that was created on submit and then declined. */
export async function queuePharmacyDeclinedEmail(
  notificationRepo: NotificationRepositoryPort,
  input: { email: string; pharmacyName: string; reason: string; key: string },
) {
  await queueEmailToRecipients(
    notificationRepo,
    [{ email: input.email, displayName: input.pharmacyName }],
    'pharmacy_onboarding_declined',
    { pharmacyName: input.pharmacyName, declineReason: input.reason },
    ['pharmacy-onboarding-declined', input.key],
  );
}
