import { queueEmailToRecipients } from '../notifications/email-outbox.js';
import { keyContact } from '../notifications/key-contacts.js';
import { emailAliasDomain } from '../notifications/email-catalog.js';
import type { NotificationRepositoryPort } from '../../repositories/ports/notification.port.js';
import type { PharmacyOnboardingRequestRecord } from '../../domain/pharmacy-onboarding/request.js';

export const PHARMACY_ONBOARDING_PORTAL_URL = 'https://portal.holistichealthhub.live/admin/pharmacy-requests';

export const FILLED_FORM_PATH_KEY = 'filledFormStoragePath';
export const LICENCE_PATH_KEY = 'licenceStoragePath';
export const LICENCE_TYPE_KEY = 'licenceContentType';
export const LICENCE_NAME_KEY = 'licenceFilename';

function partnerSuccessAddress() {
  const address = keyContact('healius').emails[0]?.address;
  if (!address) throw new Error('Partner success has no email address.');
  return address;
}

/**
 * The filled Curaleaf form goes to the HHH admin inbox, not to Curaleaf, until HHH
 * has checked submissions for duplicates and false details (decided 16 Nov 2026).
 */
export function onboardingAdminInbox() {
  return `admin@${emailAliasDomain()}`;
}

export async function queuePharmacyOnboardingSubmitted(
  notificationRepo: NotificationRepositoryPort,
  request: PharmacyOnboardingRequestRecord,
) {
  const shared = {
    pharmacyName: request.pharmacyName,
    gphcNumber: request.gphcNumber,
    pharmacistName: request.pharmacistName,
    pharmacyEmail: request.pharmacyEmail,
  };
  await queueEmailToRecipients(
    notificationRepo,
    [{ email: request.pharmacyEmail, displayName: request.pharmacyName }],
    'pharmacy_onboarding_submitted',
    shared,
    ['pharmacy-onboarding-submitted', request.id],
  );
  await queueEmailToRecipients(
    notificationRepo,
    [
      { email: partnerSuccessAddress(), displayName: 'Shaylen Patel' },
      { email: onboardingAdminInbox(), displayName: 'Holistic Health Hub admin' },
    ],
    'admin_pharmacy_onboarding_request',
    {
      ...shared,
      [FILLED_FORM_PATH_KEY]: request.filledFormStoragePath,
      ...(request.licenceStoragePath ? {
        [LICENCE_PATH_KEY]: request.licenceStoragePath,
        [LICENCE_TYPE_KEY]: request.licenceContentType,
        [LICENCE_NAME_KEY]: request.licenceFilename,
      } : {}),
    },
    ['pharmacy-onboarding-notice', request.id],
  );
}

export async function queuePharmacyOnboardingDeclined(
  notificationRepo: NotificationRepositoryPort,
  request: PharmacyOnboardingRequestRecord,
  reason: string,
) {
  await queueEmailToRecipients(
    notificationRepo,
    [{ email: request.pharmacyEmail, displayName: request.pharmacyName }],
    'pharmacy_onboarding_declined',
    {
      pharmacyName: request.pharmacyName,
      declineReason: reason,
    },
    ['pharmacy-onboarding-declined', request.id],
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
