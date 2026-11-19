import { EMAIL_COPY_CONTENT_KEY, emailCopyFrom, type EmailCopyOverrides } from '../../domain/notifications/email-copy.js';
import type { PlatformContentRepository } from '../../repositories/ports/worldpay-application.port.js';

/** The wording admins have saved for the platform's emails (one stored record for all of them). */
export async function readEmailCopy(content: Pick<PlatformContentRepository, 'read'>): Promise<EmailCopyOverrides> {
  const stored = await content.read([EMAIL_COPY_CONTENT_KEY]);
  return emailCopyFrom(stored[EMAIL_COPY_CONTENT_KEY]);
}
