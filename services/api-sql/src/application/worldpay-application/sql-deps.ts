import { StorageProvider } from '../../providers/storage/storage.provider.js';
import { SqlPlatformContentRepository, SqlWorldpayApplicationRepository } from '../../repositories/sql/worldpay-application.sql.js';
import { sendEmailNow } from '../workers/deliver-messages.js';
import type { WorldpayDeps, WorldpayHooks } from './applications.js';

export { worldpayPrefill } from './prefill.js';

type SharedDeps = Required<Pick<WorldpayDeps, 'repo' | 'content' | 'storage' | 'sendEmail'>>;
let shared: SharedDeps | null = null;

/** The production wiring: Data Connect, Cloud Storage and Resend. */
export function sqlWorldpayDeps(hooks?: WorldpayHooks): WorldpayDeps {
  shared ??= {
    repo: new SqlWorldpayApplicationRepository(),
    content: new SqlPlatformContentRepository(),
    storage: new StorageProvider(),
    sendEmail: email => sendEmailNow(email),
  };
  return { ...shared, hooks };
}
