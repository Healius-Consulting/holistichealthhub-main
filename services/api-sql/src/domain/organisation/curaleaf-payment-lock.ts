import { HttpError } from '../common/errors.js';
import { isPlatformTestOrganisation } from './training-directory.js';

/** Non-platform pharmacies stay locked on Curaleaf TEST. Primary and Alternate may pay on sandbox keys. */
export function curaleafTestPaymentAllowed(
  organisation: { id: string } | null | undefined,
  curaleafEnvironment: string | null | undefined,
) {
  if (String(curaleafEnvironment || '').toUpperCase() !== 'TEST') return true;
  return isPlatformTestOrganisation(organisation);
}

export function assertCuraleafTestPaymentAllowed(
  organisation: { id: string } | null | undefined,
  curaleafEnvironment: string | null | undefined,
) {
  if (curaleafTestPaymentAllowed(organisation, curaleafEnvironment)) return;
  throw new HttpError(409, 'Payment stays locked until Curaleaf is live.', 'CURALEAF_TEST_PAYMENT_LOCKED');
}
