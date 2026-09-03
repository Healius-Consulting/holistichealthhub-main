import type { IdentityRepositoryPort } from '../../repositories/ports/identity.port.js';
import type { NotificationRepositoryPort } from '../../repositories/ports/notification.port.js';
import type { OrganisationRepositoryPort } from '../../repositories/ports/organisation.port.js';
import { dispatchEmailEvent } from './email-dispatch.js';
import { pharmacyEmailContext } from './email-outbox.js';

type EnquiryEmailEvent = 'assigned' | 'declined';

export async function queuePharmacyEnquiryEmail(input: {
  notificationRepo: NotificationRepositoryPort;
  identityRepo: IdentityRepositoryPort;
  organisationRepo: OrganisationRepositoryPort;
  organisationId: string | null | undefined;
  submissionId: string;
  caseReference: string;
  assignmentVersion?: number;
  event: EnquiryEmailEvent;
}) {
  if (!input.organisationId) return { queued: 0, suppressed: 0 };
  const organisation = await input.organisationRepo.findOrganisationById(input.organisationId);
  if (!organisation) return { queued: 0, suppressed: 0 };
  const event = input.event === 'declined' ? 'enquiry.declined' : 'enquiry.reassigned';
  const keyPrefix = input.event === 'declined' ? 'pharmacy-enquiry-declined' : 'pharmacy-enquiry-assigned';
  return dispatchEmailEvent(event, {
    notificationRepo: input.notificationRepo,
    identityRepo: input.identityRepo,
    organisationRepo: input.organisationRepo,
    organisationId: input.organisationId,
    payload: {
      caseReference: input.caseReference,
      ...pharmacyEmailContext(organisation),
    },
    keyParts: [keyPrefix, input.submissionId, input.organisationId, input.assignmentVersion ?? 1],
  });
}
