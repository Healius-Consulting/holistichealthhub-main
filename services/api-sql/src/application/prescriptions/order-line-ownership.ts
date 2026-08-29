export type PrescriptionOwnershipInput = {
  prescriptions: Array<{ id?: string; items?: unknown[] }>;
  lineItems: Array<{ localPrescriptionId?: string }>;
};

/** Fail closed before creating an order whose lines cannot be assigned to every prescription. */
export function prescriptionOwnershipError(input: PrescriptionOwnershipInput): string | null {
  if (input.prescriptions.length <= 1) return null;
  const ids = input.prescriptions.map((rx, index) => String(rx.id || index));
  if (new Set(ids).size !== ids.length) return 'Prescription identifiers must be unique.';
  const owners = input.lineItems.map(line => String(line.localPrescriptionId || ''));
  if (owners.some(owner => !owner || !ids.includes(owner))) {
    return 'Every medicine line must identify its prescription.';
  }
  const missing = ids.filter(id => !owners.includes(id));
  if (missing.length) return 'Every prescription must have its own medicine lines.';
  return null;
}
