import { sha256 } from '../../security/session-utils.js';
import { resolveOwnerUid } from '../../domain/identity/pharmacy-owner.js';
import type { EmailTemplateCode } from './message-kinds.js';
import { messageIdempotencyKey } from './message-kinds.js';
import type { NotificationRepositoryPort } from '../../repositories/ports/notification.port.js';
import type { IdentityRepositoryPort, StaffUserRecord } from '../../repositories/ports/identity.port.js';
import type { OrganisationRecord, OrganisationRepositoryPort } from '../../repositories/ports/organisation.port.js';
import type { SuppressionRepositoryPort } from '../../repositories/ports/suppression.port.js';

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

/**
 * Identity of the pharmacy a message is about. The controller fields land in the email
 * footer, which Privacy 1.1 promises carries the pharmacy's name, address, GPhC number,
 * ICO number and privacy contact. Name, address and GPhC come from the organisation;
 * the data-protection contacts live on the public directory profile, so a caller that
 * has one passes it and the footer is complete.
 */
export function pharmacyEmailContext(
  organisation: OrganisationRecord | null | undefined,
  profile?: {
    icoRegistrationNumber?: string | null;
    privacyContactEmail?: string | null;
    complaintsContactEmail?: string | null;
    complaintsContactPhone?: string | null;
  } | null,
) {
  return {
    organisationId: organisation?.id || '',
    // Trading name only. `organisation.name` is the owning company, which a patient
    // has never heard of and must never be shown; it belongs on the admin identity tab.
    pharmacyName: organisation?.tradingName || 'the pharmacy',
    pharmacyPhone: organisation?.mainContactPhone || '',
    pharmacyEmail: organisation?.mainContactEmail || '',
    pharmacyAddress: organisation?.address || '',
    pharmacyGphcNumber: organisation?.gphcNumber || '',
    pharmacyIcoNumber: profile?.icoRegistrationNumber || '',
    pharmacyPrivacyEmail: profile?.privacyContactEmail || '',
    pharmacyComplaintsEmail: profile?.complaintsContactEmail || '',
    pharmacyComplaintsPhone: profile?.complaintsContactPhone || '',
  };
}

/**
 * Marketing must not reach a suppressed address, whatever the stored consent says:
 * an unsubscribe outranks a tick made earlier. Service messages about an open
 * application are not marketing (Terms 9.1) and are never filtered here.
 */
export async function filterSuppressedRecipients(
  suppressionRepo: Pick<SuppressionRepositoryPort, 'isSuppressed'>,
  recipients: Recipient[],
): Promise<Recipient[]> {
  const allowed: Recipient[] = [];
  for (const recipient of recipients) {
    const address = String(recipient.email || '').trim().toLowerCase();
    if (!address) continue;
    // Fail closed: if the list cannot be read, no marketing goes out.
    try {
      if (await suppressionRepo.isSuppressed(sha256(address))) continue;
    } catch {
      continue;
    }
    allowed.push(recipient);
  }
  return allowed;
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
  let queued = 0;
  for (const recipient of unique) {
    const outcome = await notificationRepo.enqueue({
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
    if (outcome.created) queued += 1;
  }
  // An idempotency-key collision makes `enqueue` a silent no-op. Callers that tell an
  // operator "setup email queued" need to know that happened, or the portal reports a
  // send that no worker will ever pick up.
  return { queued, suppressed: unique.length - queued };
}

export async function listPlatformAdminRecipients(identityRepo: IdentityRepositoryPort) {
  const admins = await identityRepo.listPlatformAdmins();
  return dedupeRecipients(admins.map(admin => ({
    email: admin.email,
    displayName: admin.displayName,
  })));
}

function ownerRecipient(staff: StaffUserRecord[], organisation: OrganisationRecord | null | undefined) {
  const ownerUid = resolveOwnerUid(staff, organisation?.primaryContactUid);
  const owner = staff.find(member => member.uid === ownerUid);
  if (owner && owner.status !== 'REMOVED' && !owner.disabled) {
    return [{ email: owner.email, displayName: owner.displayName }];
  }
  if (organisation?.mainContactEmail) {
    return [{ email: organisation.mainContactEmail, displayName: organisation.mainContactName }];
  }
  return [];
}

export function pharmacyOwnerRecipients(
  staff: StaffUserRecord[],
  organisation: OrganisationRecord | null | undefined,
) {
  return dedupeRecipients(ownerRecipient(staff, organisation));
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
  return pharmacyOwnerRecipients(staff, organisation);
}
