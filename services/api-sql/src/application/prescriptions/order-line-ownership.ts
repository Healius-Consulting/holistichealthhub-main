export type PrescriptionOwnershipInput = {
  prescriptions: Array<{ clientKey?: string; id?: string; items?: unknown[] }>;
  lineItems: Array<{ localPrescriptionId?: string }>;
};

/** Same client correlation used when persisting lines: clientKey, then legacy id, then index. */
export function prescriptionCorrelationKey(
  rx: { clientKey?: string; id?: string },
  index: number,
): string {
  const clientKey = String(rx.clientKey ?? '').trim();
  if (clientKey) return clientKey;
  const id = String(rx.id ?? '').trim();
  if (id) return id;
  return String(index);
}

/** Fail closed before creating an order whose lines cannot be assigned to every prescription. */
export function prescriptionOwnershipError(input: PrescriptionOwnershipInput): string | null {
  if (input.prescriptions.length <= 1) return null;
  const ids = input.prescriptions.map((rx, index) => prescriptionCorrelationKey(rx, index));
  if (new Set(ids).size !== ids.length) return 'Prescription identifiers must be unique.';
  const owners = input.lineItems.map(line => String(line.localPrescriptionId || '').trim());
  if (owners.some(owner => !owner || !ids.includes(owner))) {
    return 'Every medicine line must identify its prescription.';
  }
  const missing = ids.filter(id => !owners.includes(id));
  if (missing.length) return 'Every prescription must have its own medicine lines.';
  return null;
}
