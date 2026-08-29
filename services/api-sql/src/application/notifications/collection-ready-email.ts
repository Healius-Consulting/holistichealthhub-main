import type { NotificationRepositoryPort } from '../../repositories/ports/notification.port.js';
import type { OrganisationRepositoryPort } from '../../repositories/ports/organisation.port.js';
import type { PatientRepositoryPort } from '../../repositories/ports/patient.port.js';
import { pharmacyEmailContext, queueEmailToRecipients } from './email-outbox.js';
import { collectionEmailDelayUntil } from './collection-email-schedule.js';

/**
 * Queues the patient's ready-to-collect email.
 *
 * Goods-in and explicit readiness routes go through here with the same scope key.
 * A consignment can therefore notify once even if both endpoints are called.
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
    readyPacks?: number;
    totalPacks?: number;
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
      readyPacks: input.readyPacks ?? null,
      totalPacks: input.totalPacks ?? null,
      partialReady: Number(input.readyPacks || 0) > 0
        && Number(input.totalPacks || 0) > Number(input.readyPacks || 0),
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
