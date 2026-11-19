import { sqlClickupHooks } from '../clickup/clickup-hooks.js';
import type { RequestContext } from '../../security/request-context.js';
import type { WorldpayHooks } from './applications.js';

/**
 * What else happens when a Worldpay application moves: the ClickUp card is told
 * (references only, never answers). The go-live checklist reads the application
 * itself, so it needs no hook.
 */
export function worldpayHooks(_context?: RequestContext): WorldpayHooks {
  const clickup = sqlClickupHooks();
  return {
    async submitted(record) {
      if (!record.reference || !record.submittedAt) return;
      await clickup.worldpaySubmitted({
        gphcNumber: record.gphcNumber,
        organisationId: record.organisationId,
        onboardingRequestId: record.onboardingRequestId,
        reference: record.reference,
        submittedAt: record.submittedAt,
      });
    },
    async statusChanged(record) {
      if (record.status === 'CONNECTED' && record.organisationId) {
        await clickup.worldpayValidated({ gphcNumber: record.gphcNumber, organisationId: record.organisationId });
      }
    },
  };
}
