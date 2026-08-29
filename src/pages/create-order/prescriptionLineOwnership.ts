/**
 * Flatten a multi-prescription basket without losing the prescription that owns
 * each line. Keeping this as a pure boundary helper makes the create-order API
 * payload independently testable from the React selection state.
 */
export function flattenPrescriptionLines<
  TItem,
  TLine extends object,
  TPrescription extends { id: string | number; items: TItem[] },
>(
  prescriptions: TPrescription[],
  mapItem: (item: TItem, prescription: TPrescription) => TLine,
): Array<TLine & { localPrescriptionId: string }> {
  return prescriptions.flatMap(prescription => prescription.items.map(item => ({
    ...mapItem(item, prescription),
    localPrescriptionId: String(prescription.id),
  })));
}
