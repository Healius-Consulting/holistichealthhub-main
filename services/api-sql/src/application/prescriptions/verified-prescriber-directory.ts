import type { PrescriptionRepositoryPort, UpsertPrescriberInput } from '../../repositories/ports/prescription.port.js';

export type VerifiedPrescriberDirectorySource = {
  name?: string | null;
  initials?: string | null;
  pin?: string | null;
  gmcNumber?: number | string | null;
  gphcNumber?: string | null;
};

function initialsFromName(name: string) {
  return name.split(/\s+/).map(part => part[0]).join('').toUpperCase().slice(0, 20) || 'XX';
}

function regulatorGmc(value: number | string | null | undefined) {
  const parsed = typeof value === 'number' ? value : Number(String(value ?? '').trim());
  if (!Number.isInteger(parsed) || parsed <= 0) return null;
  return parsed;
}

export function verifiedPrescriberDirectoryInput(source: VerifiedPrescriberDirectorySource): UpsertPrescriberInput | null {
  const name = String(source.name || '').trim();
  const pin = String(source.pin || '').trim();
  const gphcNumber = String(source.gphcNumber || '').trim() || null;
  const gmcNumber = regulatorGmc(source.gmcNumber);
  if (!name || !pin || (!gmcNumber && !gphcNumber)) return null;
  const initials = String(source.initials || '').trim() || initialsFromName(name);
  return {
    name,
    initials,
    pin,
    gmcNumber,
    gphcNumber,
    createdByUid: null,
  };
}

export async function recordVerifiedPrescriberInDirectory(
  prescriptionRepo: Pick<PrescriptionRepositoryPort, 'upsertPrescriber'>,
  source: VerifiedPrescriberDirectorySource,
) {
  const input = verifiedPrescriberDirectoryInput(source);
  if (!input) return 'skipped' as const;
  try {
    await prescriptionRepo.upsertPrescriber(input);
    return 'saved' as const;
  } catch (error) {
    console.warn('[Prescriber directory] Verified upsert failed.', {
      code: error instanceof Error ? error.name : 'PRESCRIBER_DIRECTORY_UPSERT_FAILED',
    });
    return 'failed' as const;
  }
}
