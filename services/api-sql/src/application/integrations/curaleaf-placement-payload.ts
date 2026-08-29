import type { PlacementRxItem } from '../orders/prescription-units.js';

export function curaleafPrescriptionCreatePayload(input: {
  serialNumber: string;
  prescriberId: string;
  issueDate: string;
  items: PlacementRxItem[];
}) {
  return {
    serialNumber: input.serialNumber,
    prescriberId: input.prescriberId,
    issueDate: input.issueDate,
    items: input.items.map(item => ({
      formulaId: item.formulaId,
      unitsNeededCount: item.unitsNeededCount,
    })),
  };
}

export function curaleafPurchaseOrderPayload(input: {
  customerReference: string;
  prescriptionId: string;
}) {
  return {
    customerReference: input.customerReference,
    prescriptionIds: [input.prescriptionId],
  };
}
