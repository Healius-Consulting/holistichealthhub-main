import { z } from 'zod';

/**
 * "Not yet" from a PharmSmart visitor. The values are the PharmSmart welcome the
 * browser was given, so they say who to follow up with. They are not a login.
 */
export const pharmacyOnboardingDeferralSchema = z.object({
  gphcNumber: z.string().trim().min(3).max(40),
  pharmsmartPharmacyId: z.string().trim().max(80).optional().or(z.literal('')),
  personName: z.string().trim().max(160).optional().or(z.literal('')),
  personEmail: z.string().trim().email().max(254).optional().or(z.literal('')),
  idempotencyKey: z.string().trim().min(8).max(128),
});

export type PharmacyOnboardingDeferralInput = z.infer<typeof pharmacyOnboardingDeferralSchema>;

export type PharmacyOnboardingDeferralRecord = {
  id: string;
  gphcNumber: string;
  pharmsmartPharmacyId: string | null;
  personName: string | null;
  personEmail: string | null;
  idempotencyKey: string;
};
