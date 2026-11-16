import { randomUUID } from 'node:crypto';
import { HttpError } from '../../domain/common/errors.js';
import { compactGphcNumber } from '../../domain/pharmacy-onboarding/request.js';
import type {
  PharmacyOnboardingDeferralInput,
  PharmacyOnboardingDeferralRecord,
} from '../../domain/pharmacy-onboarding/deferral.js';

export type DeferralRepository = {
  findDeferralByIdempotencyKey(idempotencyKey: string): Promise<{ id: string } | null>;
  insertDeferral(record: PharmacyOnboardingDeferralRecord): Promise<void>;
};

/** Records "Not yet". It never creates a branch, and a retry with the same key records nothing new. */
export async function recordPharmacyOnboardingDeferral(
  repo: DeferralRepository,
  input: PharmacyOnboardingDeferralInput,
): Promise<{ id: string }> {
  const gphcNumber = compactGphcNumber(input.gphcNumber);
  if (!gphcNumber) throw new HttpError(400, 'Enter the GPhC number.', 'INVALID_INPUT');
  const existing = await repo.findDeferralByIdempotencyKey(input.idempotencyKey);
  if (existing) return { id: existing.id };
  const record: PharmacyOnboardingDeferralRecord = {
    id: randomUUID(),
    gphcNumber,
    pharmsmartPharmacyId: input.pharmsmartPharmacyId?.trim() || null,
    personName: input.personName?.trim() || null,
    personEmail: input.personEmail?.trim().toLowerCase() || null,
    idempotencyKey: input.idempotencyKey,
  };
  await repo.insertDeferral(record);
  return { id: record.id };
}
