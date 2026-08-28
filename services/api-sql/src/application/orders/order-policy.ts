import { randomBytes } from 'node:crypto';

export function pharmacyDeliveryPermitted(input: {
  draftEnabledAtCreation?: boolean | null;
  organisationEnabled: boolean;
}) {
  return input.draftEnabledAtCreation ?? input.organisationEnabled;
}

export function pharmacyDeliveryChargeAllowed(pence: number, permitted: boolean) {
  return Number.isInteger(pence) && pence >= 0 && pence <= 1_500 && (pence === 0 || permitted);
}

/** Business references are server-owned and unpredictable under the database unique constraint. */
export function generateOrderNumber(now: number = Date.now(), randomSuffix?: string) {
  const suffix = randomSuffix ?? randomBytes(5).toString('hex').toUpperCase();
  return `ORD-${now.toString(36).toUpperCase()}-${suffix}`;
}
