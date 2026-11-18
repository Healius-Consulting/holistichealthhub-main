import { isPlatformTestPharmacy } from '../shared/contracts.ts';

export type PharmacyWorkspaceMode = 'training' | 'test' | 'live';

export function isOpenPharmacyWorkspace(mode: string | null | undefined): mode is 'test' | 'live' {
  return mode === 'live' || mode === 'test';
}

/** A pharmacy not yet live is awaiting Curaleaf: its eligibility link is open, ordering is not. */
export function pharmacyWorkspaceStatusLabel(mode: string | null | undefined, paused = false): 'Paused' | 'Live' | 'Test' | 'Awaiting Curaleaf' {
  if (paused) return 'Paused';
  if (mode === 'live') return 'Live';
  if (mode === 'test') return 'Test';
  return 'Awaiting Curaleaf';
}

/**
 * Training: not yet live, or the demo data set (Demo mode, or local `?devPortal=pharmacy`).
 * Test: flipped workspace on sandbox keys, or always-on Primary/Alternate.
 * Live: flipped workspace on production Curaleaf keys.
 */
export function resolvePharmacyWorkspaceMode(
  organisation: {
    id: string;
    status?: string | null;
    workspaceClassification?: string | null;
    testAccount?: boolean;
  } | null | undefined,
  extras?: { curaleafEstate?: 'test' | 'production'; localPreview?: boolean; demo?: boolean },
): PharmacyWorkspaceMode {
  if (extras?.localPreview || extras?.demo) return 'training';
  if (!organisation) return 'training';
  if (isPlatformTestPharmacy(organisation)) {
    return extras?.curaleafEstate === 'production' ? 'live' : 'test';
  }
  const flipped = organisation.status === 'live' || organisation.status === 'paused' || organisation.workspaceClassification === 'allocation_holding';
  if (!flipped) return 'training';
  return extras?.curaleafEstate === 'production' ? 'live' : 'test';
}

/** The portal shows the demo data set: the pharmacy turned Demo mode on, or local preview. */
export function usesSandboxDummyPack(flags: { demo: boolean; localPreview: boolean }) {
  return flags.demo || flags.localPreview;
}
