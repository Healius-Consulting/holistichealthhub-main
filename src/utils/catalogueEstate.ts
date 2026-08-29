/**
 * Curaleaf key estate: sandbox (.dev) vs production (.co.uk).
 *
 * Unknown is treated as test so a mis-keyed pharmacy is never silently presented
 * as production. Production stays unmarked in the UI, matching Overview.
 */

export type CuraleafCatalogueEstate = 'test' | 'production';

export function curaleafCatalogueEstate(value: unknown): CuraleafCatalogueEstate {
  return value === 'production' ? 'production' : 'test';
}

export function curaleafCatalogueEstateLabel(value: unknown): 'Test' | 'Production' {
  return curaleafCatalogueEstate(value) === 'production' ? 'Production' : 'Test';
}

export function isCuraleafTestCatalogue(
  source: 'curaleaf' | 'training' | 'unavailable' | undefined,
  environment: unknown,
): boolean {
  return source === 'curaleaf' && curaleafCatalogueEstate(environment) === 'test';
}
