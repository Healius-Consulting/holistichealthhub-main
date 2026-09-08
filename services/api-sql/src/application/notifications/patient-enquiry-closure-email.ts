import type { IdentityRepositoryPort } from '../../repositories/ports/identity.port.js';
import type { NotificationRepositoryPort } from '../../repositories/ports/notification.port.js';
import type { OrganisationRepositoryPort } from '../../repositories/ports/organisation.port.js';
import { dispatchEmailEvent } from './email-dispatch.js';
import { pharmacyEmailContext } from './email-outbox.js';
import type { EnquiryClosureVariant } from './email-catalog.js';

/**
 * PT-00. Tells a patient their enquiry is closed, in the pharmacy's name where one
 * was assigned. The pharmacy's own notification is queued separately, so it is
 * skipped here — dispatching the event twice would otherwise send it twice.
 */
export async function queuePatientEnquiryClosureEmail(input: {
  notificationRepo: NotificationRepositoryPort;
  identityRepo: IdentityRepositoryPort;
  organisationRepo: OrganisationRepositoryPort;
  organisationId: string | null | undefined;
  submissionId: string;
  assignmentVersion: number;
  email: string | null | undefined;
  firstName: string | null | undefined;
  variant: EnquiryClosureVariant;
}) {
  const recipient = String(input.email || '').trim();
  if (!recipient) return { queued: 0, suppressed: 0 };
  const organisation = input.organisationId
    ? await input.organisationRepo.findOrganisationById(input.organisationId)
    : null;
  return dispatchEmailEvent(input.variant === 'withdrawn' ? 'enquiry.withdrawn' : 'enquiry.declined', {
    notificationRepo: input.notificationRepo,
    identityRepo: input.identityRepo,
    organisationRepo: input.organisationRepo,
    organisationId: input.organisationId ?? null,
    mails: {
      pharmacy_enquiry_declined: { skip: true },
      patient_enquiry_declined: {
        to: { email: recipient, displayName: input.firstName || null },
        payload: {
          firstName: input.firstName || 'there',
          variant: input.variant,
          ...pharmacyEmailContext(organisation),
        },
        keyParts: ['patient-enquiry-closed', input.submissionId, input.assignmentVersion],
      },
    },
  });
}
