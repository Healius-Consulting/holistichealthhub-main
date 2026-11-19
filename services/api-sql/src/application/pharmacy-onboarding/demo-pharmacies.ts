import { HttpError } from '../../domain/common/errors.js';
import { DEMO_PHARMACIES_KEY, demoGphcNumbersFrom } from '../../domain/pharmacy-onboarding/demo.js';
import { compactGphcNumber } from '../../domain/pharmacy-onboarding/request.js';
import type { PlatformContentRepository } from '../../repositories/ports/worldpay-application.port.js';

/** What the platform holds for one GPhC number. */
export interface DemoPharmacyRecords {
  organisations: Array<{ id: string; name: string; status: string; createdAt: string }>;
  requests: Array<{ id: string; pharmacyName: string; status: string; filledFormStoragePath: string | null; licenceStoragePath: string | null; createdAt: string }>;
  staffUids: string[];
  worldpayFiles: string[];
  /** Patients or orders: real activity, which the delete refuses to touch. */
  hasPatientsOrOrders: boolean;
}

export interface DemoPharmacyRepository {
  find(gphc: string): Promise<DemoPharmacyRecords>;
  /** One transaction: everything for the GPhC, or nothing. Returns rows deleted per table. */
  delete(input: { gphc: string; organisationIds: string[]; requestIds: string[]; staffUids: string[] }): Promise<Record<string, number>>;
}

export async function readDemoGphcNumbers(content: PlatformContentRepository) {
  const stored = await content.read([DEMO_PHARMACIES_KEY]);
  return demoGphcNumbersFrom(stored[DEMO_PHARMACIES_KEY]);
}

export async function isDemoGphc(content: PlatformContentRepository, gphc: string) {
  const compact = compactGphcNumber(gphc);
  return compact ? (await readDemoGphcNumbers(content)).includes(compact) : false;
}

/**
 * Deletes every record of a demo pharmacy, so it can go through onboarding again.
 * Only numbers on the demo list, and never a branch with patients or orders.
 */
export async function deleteDemoPharmacy(
  deps: { repo: DemoPharmacyRepository; content: PlatformContentRepository; storage: { deleteFile(path: string): Promise<unknown> } },
  rawGphc: string,
) {
  const gphc = compactGphcNumber(rawGphc);
  if (!gphc || !(await isDemoGphc(deps.content, gphc))) {
    throw new HttpError(403, 'Only a GPhC number on the demo list can be deleted here.', 'NOT_A_DEMO_PHARMACY');
  }
  const found = await deps.repo.find(gphc);
  if (found.hasPatientsOrOrders) {
    throw new HttpError(409, 'This demo pharmacy has patients or orders, so it was not deleted. Remove those first.', 'DEMO_PHARMACY_IN_USE');
  }
  if (found.organisations.length === 0 && found.requests.length === 0) return { gphc, deleted: {}, files: 0 };
  const deleted = await deps.repo.delete({
    gphc,
    organisationIds: found.organisations.map(row => row.id),
    requestIds: found.requests.map(row => row.id),
    staffUids: found.staffUids,
  });
  // Stored files: each request's folder (the Curaleaf form and licence) and any Worldpay application files.
  const files = [
    ...found.requests.flatMap(row => [row.filledFormStoragePath, row.licenceStoragePath]),
    ...found.worldpayFiles,
  ].filter((path): path is string => Boolean(path));
  let removed = 0;
  for (const path of files) {
    try { await deps.storage.deleteFile(path); removed += 1; } catch { /* already gone */ }
  }
  return { gphc, deleted, files: removed };
}
