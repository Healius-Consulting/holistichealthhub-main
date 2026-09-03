import { collectionEmailDelayUntil } from './collection-email-schedule.js';
import {
  EMAILS,
  templatesForEvent,
  type EmailAudience,
  type EmailEventName,
  type EmailTemplateCode,
} from './email-catalog.js';
import {
  listPharmacyRecipients,
  listPlatformAdminRecipients,
  queueEmailToRecipients,
} from './email-outbox.js';
import type { IdentityRepositoryPort } from '../../repositories/ports/identity.port.js';
import type { NotificationRepositoryPort } from '../../repositories/ports/notification.port.js';
import type { OrganisationRepositoryPort } from '../../repositories/ports/organisation.port.js';

export type EmailRecipient = {
  email: string;
  displayName?: string | null;
};

export type EmailDispatchMail = {
  payload?: unknown;
  keyParts?: Array<string | number | null | undefined>;
  to?: EmailRecipient | null;
  skip?: boolean;
  nextAttemptAt?: Date | string | null;
};

export type DispatchEmailEventInput = {
  notificationRepo: NotificationRepositoryPort;
  identityRepo?: IdentityRepositoryPort;
  organisationRepo?: OrganisationRepositoryPort;
  organisationId?: string | null;
  patientId?: string | null;
  orderId?: string | null;
  now?: Date;
  to?: EmailRecipient | null;
  payload?: unknown;
  keyParts?: Array<string | number | null | undefined>;
  nextAttemptAt?: Date | string | null;
  mails?: Partial<Record<EmailTemplateCode, EmailDispatchMail>>;
};

async function recipientsFor(
  audience: EmailAudience,
  input: DispatchEmailEventInput,
  to: EmailRecipient | null | undefined,
): Promise<EmailRecipient[]> {
  if (audience === 'patient' || audience === 'staff') {
    const email = String(to?.email || '').trim();
    return email ? [{ email, displayName: to?.displayName ?? null }] : [];
  }
  if (audience === 'admin') {
    if (!input.identityRepo) return [];
    return listPlatformAdminRecipients(input.identityRepo);
  }
  const organisationId = String(input.organisationId || '').trim();
  if (!organisationId || !input.identityRepo || !input.organisationRepo) return [];
  return listPharmacyRecipients(organisationId, {
    identityRepo: input.identityRepo,
    organisationRepo: input.organisationRepo,
  });
}

/**
 * Queue every catalog template bound to `event`. Callers pass payload and
 * idempotency key parts; recipient lists come from each template's audience.
 */
export async function dispatchEmailEvent(event: EmailEventName, input: DispatchEmailEventInput) {
  let queued = 0;
  let suppressed = 0;
  for (const code of templatesForEvent(event)) {
    const override = input.mails?.[code];
    if (override?.skip) continue;
    const payload = override?.payload ?? input.payload ?? {};
    const keyParts = override?.keyParts ?? input.keyParts ?? [event, code];
    const to = override && 'to' in override ? override.to : input.to;
    const recipients = await recipientsFor(EMAILS[code].audience, input, to);
    if (!recipients.length) continue;

    let nextAttemptAt = override?.nextAttemptAt ?? input.nextAttemptAt ?? null;
    if (EMAILS[code].schedule === 'collection_hours' && nextAttemptAt == null) {
      nextAttemptAt = collectionEmailDelayUntil(input.now ?? new Date());
    }

    const result = await queueEmailToRecipients(
      input.notificationRepo,
      recipients,
      code,
      payload,
      keyParts,
      {
        organisationId: input.organisationId ?? null,
        patientId: input.patientId ?? null,
        orderId: input.orderId ?? null,
        nextAttemptAt,
      },
    );
    queued += result.queued;
    suppressed += result.suppressed;
  }
  return { queued, suppressed };
}
