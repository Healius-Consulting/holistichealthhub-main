import { sha256 } from '../../security/session-utils.js';
import type { EmailTemplateCode } from './message-kinds.js';
import { messageIdempotencyKey } from './message-kinds.js';
import type { NotificationRepositoryPort } from '../../repositories/ports/notification.port.js';
import type { IdentityRepositoryPort, StaffUserRecord } from '../../repositories/ports/identity.port.js';
import type { OrganisationRecord, OrganisationRepositoryPort } from '../../repositories/ports/organisation.port.js';

type Recipient = {
  email: string;
  displayName?: string | null;
};

function normaliseEmail(value: string | null | undefined) {
  return String(value || '').trim().toLowerCase();
}

function dedupeRecipients(items: Recipient[]) {
  const seen = new Set<string>();
  const result: Recipient[] = [];
  for (const item of items) {
    const email = normaliseEmail(item.email);
    if (!email || seen.has(email)) continue;
    seen.add(email);
    result.push({ email, displayName: item.displayName ?? null });
  }
  return result;
}

export function pharmacyEmailContext(organisation: OrganisationRecord | null | undefined) {
  return {
    organisationId: organisation?.id || '',
    pharmacyName: organisation?.tradingName || organisation?.name || 'the pharmacy',
    pharmacyPhone: organisation?.mainContactPhone || '',
    pharmacyEmail: organisation?.mainContactEmail || '',
    pharmacyAddress: organisation?.address || '',
  };
}

export async function queueEmailToRecipients(
  notificationRepo: NotificationRepositoryPort,
  recipients: Recipient[],
  templateCode: EmailTemplateCode,
  payload: unknown,
  keyParts: Array<string | number | null | undefined>,
  meta?: {
    organisationId?: string | null;
    patientId?: string | null;
    orderId?: string | null;
    /** Hold delivery until this instant, e.g. outside pharmacy hours. */
    nextAttemptAt?: Date | string | null;
  },
) {
  const unique = dedupeRecipients(recipients);
  for (const recipient of unique) {
    await notificationRepo.enqueue({
      organisationId: meta?.organisationId ?? null,
      patientId: meta?.patientId ?? null,
      orderId: meta?.orderId ?? null,
      channel: 'EMAIL',
      templateCode,
      recipientHash: sha256(recipient.email),
      encryptedRecipient: recipient.email,
      payload: {
        recipientName: recipient.displayName || null,
        ...((payload && typeof payload === 'object' && !Array.isArray(payload)) ? payload as Record<string, unknown> : { value: payload }),
      },
      idempotencyKey: messageIdempotencyKey([...keyParts, recipient.email]),
      nextAttemptAt: meta?.nextAttemptAt
        ? (meta.nextAttemptAt instanceof Date ? meta.nextAttemptAt.toISOString() : meta.nextAttemptAt)
        : null,
    });
  }
}

export async function listPlatformAdminRecipients(identityRepo: IdentityRepositoryPort) {
  const admins = await identityRepo.listPlatformAdmins();
  return dedupeRecipients(admins.map(admin => ({
    email: admin.email,
    displayName: admin.displayName,
  })));
}

function activeStaffRecipients(staff: StaffUserRecord[]) {
  return staff
    .filter(member => member.status !== 'REMOVED' && !member.disabled)
    .map(member => ({ email: member.email, displayName: member.displayName }));
}

export async function listPharmacyRecipients(
  organisationId: string,
  deps: {
    identityRepo: IdentityRepositoryPort;
    organisationRepo: OrganisationRepositoryPort;
  },
) {
  const [staff, organisation] = await Promise.all([
    deps.identityRepo.listPharmacyStaffByOrganisationId(organisationId),
    deps.organisationRepo.findOrganisationById(organisationId),
  ]);
  return dedupeRecipients([
    ...activeStaffRecipients(staff),
    ...(organisation?.mainContactEmail
      ? [{ email: organisation.mainContactEmail, displayName: organisation.mainContactName }]
      : []),
  ]);
}
