import type { NotificationRepositoryPort } from '../../repositories/ports/notification.port.js';
import type { OrganisationRepositoryPort } from '../../repositories/ports/organisation.port.js';
import type { PatientRepositoryPort } from '../../repositories/ports/patient.port.js';
import { pharmacyEmailContext, queueEmailToRecipients } from './email-outbox.js';
import { collectionEmailDelayUntil } from './collection-email-schedule.js';

/**
 * Queues the patient's ready-to-collect email.
 *
 * Both the order-level and the shipment-level ready-for-collection routes go
 * through here. They used to diverge: the shipment route recorded the state but
 * never queued anything, so marking a single consignment ready told the patient
 * nothing. The idempotency key still distinguishes the two, so a consignment and
 * a whole order can each notify once.
 */
export async function queueCollectionReadyEmail(
  deps: {
    notificationRepo: NotificationRepositoryPort;
    patientRepo: PatientRepositoryPort;
    organisationRepo: OrganisationRepositoryPort;
  },
  input: {
    organisationId: string;
    orderId: string;
    patientId: string | null | undefined;
    orderNumber?: string | number | null;
    /** Distinguishes a consignment notice from a whole-order one. */
    scopeKey: string;
    now?: Date;
  },
) {
  if (!input.patientId) return { queued: false as const, reason: 'no-patient' as const };
  const patient = await deps.patientRepo.findPatientById(input.organisationId, input.patientId).catch(() => null);
  if (!patient?.email) return { queued: false as const, reason: 'no-email' as const };

  const organisation = await deps.organisationRepo.findOrganisationById(input.organisationId).catch(() => null);
  const nextAttemptAt = collectionEmailDelayUntil(input.now ?? new Date());

  await queueEmailToRecipients(
    deps.notificationRepo,
    [{ email: patient.email, displayName: patient.firstName || null }],
    'patient_ready_for_collection',
    {
      firstName: patient.firstName || 'Patient',
      orderNumber: input.orderNumber ?? null,
      ...pharmacyEmailContext(organisation),
    },
    ['patient-ready-for-collection', input.orderId, input.scopeKey],
    {
      organisationId: input.organisationId,
      patientId: input.patientId,
      orderId: input.orderId,
      nextAttemptAt,
    },
  );

  return { queued: true as const, nextAttemptAt };
}
