import type { IdentityRepositoryPort } from '../../repositories/ports/identity.port.js';
import type { NotificationRepositoryPort } from '../../repositories/ports/notification.port.js';
import type { OrganisationRepositoryPort } from '../../repositories/ports/organisation.port.js';
import { listPharmacyRecipients, pharmacyEmailContext, queueEmailToRecipients } from './email-outbox.js';

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
  const recipients = await listPharmacyRecipients(input.organisationId, {
    identityRepo: input.identityRepo,
    organisationRepo: input.organisationRepo,
  });
  if (!recipients.length) return { queued: 0, suppressed: 0 };
  const templateCode = input.event === 'declined' ? 'pharmacy_enquiry_declined' : 'pharmacy_new_enquiry_assigned';
  const keyPrefix = input.event === 'declined' ? 'pharmacy-enquiry-declined' : 'pharmacy-enquiry-assigned';
  return queueEmailToRecipients(
    input.notificationRepo,
    recipients,
    templateCode,
    {
      caseReference: input.caseReference,
      ...pharmacyEmailContext(organisation),
    },
    [keyPrefix, input.submissionId, input.organisationId, input.assignmentVersion ?? 1],
    { organisationId: input.organisationId },
  );
}
