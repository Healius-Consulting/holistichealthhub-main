import { z } from 'zod';

/**
 * Demo pharmacies: GPhC premises numbers HHH uses to walk through onboarding on
 * production, to show how the process works. For these numbers the Curaleaf
 * application email goes to HHH only (never to Curaleaf), and a new Curaleaf form
 * from the number first wipes the previous run, so the walk-through can start again.
 *
 * The list is admin-editable (PlatformContent); with nothing stored it is the default.
 */
export const DEMO_PHARMACIES_KEY = 'onboarding.demoGphcNumbers';
export const DEFAULT_DEMO_GPHC_NUMBERS = ['9012605'];

export const demoGphcNumbersSchema = z.array(z.string().trim().regex(/^\d{7}$/, 'A GPhC premises number is 7 digits.')).max(20);

export function demoGphcNumbersFrom(stored: unknown): string[] {
  const parsed = demoGphcNumbersSchema.safeParse(stored);
  return parsed.success ? [...new Set(parsed.data)] : DEFAULT_DEMO_GPHC_NUMBERS;
}
