/**
 * A note that a pharmacy sent the old one-page Worldpay form (retired 19 Nov 2026 for
 * the Worldpay application, application/worldpay-application). Only who sent it and
 * when was ever kept, never the answers. Existing notes still count as "Worldpay form
 * sent" on the admin record and the go-live checklist.
 */
export type WorldpaySubmissionNote = {
  id: string;
  gphcNumber: string;
  /** The branch, when the form was sent from the pharmacy portal. */
  organisationId?: string | null;
  tradingName: string;
  submittedAt: string;
  idempotencyKey: string;
};
