export const REFUND_CHARGE_PERCENTS = [100, 75, 50, 25, 0] as const;
export type RefundChargePercent = (typeof REFUND_CHARGE_PERCENTS)[number];
export type RefundScope = 'full' | 'partial';

export type RefundMedicineLine = {
  id: string;
  label: string;
  amountPence: number;
};

export type RefundCatalog = {
  medicines: RefundMedicineLine[];
  dispensingFeePence: number;
  deliveryFeePence: number;
  paidPence: number;
};

export type RefundDraft = {
  scope: RefundScope;
  includedMedicineIds: string[];
  dispensingPercent: RefundChargePercent;
  deliveryPercent: RefundChargePercent;
};

export type RefundBreakdownLine = {
  key: string;
  kind: 'medicine' | 'dispensing' | 'delivery';
  label: string;
  amountPence: number;
  percent?: RefundChargePercent;
};

export type RefundComposition = {
  scope: RefundScope;
  amountPence: number;
  lines: RefundBreakdownLine[];
};

export function isRefundChargePercent(value: number): value is RefundChargePercent {
  return (REFUND_CHARGE_PERCENTS as readonly number[]).includes(value);
}

export function defaultRefundDraft(catalog: RefundCatalog): RefundDraft {
  return {
    scope: 'full',
    includedMedicineIds: catalog.medicines.map(line => line.id),
    dispensingPercent: catalog.dispensingFeePence > 0 ? 100 : 0,
    deliveryPercent: catalog.deliveryFeePence > 0 ? 100 : 0,
  };
}

export function chargeSharePence(amountPence: number, percent: RefundChargePercent) {
  return Math.round((Math.max(0, amountPence) * percent) / 100);
}

export function composeRefund(catalog: RefundCatalog, draft: RefundDraft): RefundComposition {
  const included = new Set(draft.scope === 'full' ? catalog.medicines.map(line => line.id) : draft.includedMedicineIds);
  const dispensingPercent: RefundChargePercent = draft.scope === 'full' ? (catalog.dispensingFeePence > 0 ? 100 : 0) : draft.dispensingPercent;
  const deliveryPercent: RefundChargePercent = draft.scope === 'full' ? (catalog.deliveryFeePence > 0 ? 100 : 0) : draft.deliveryPercent;

  const lines: RefundBreakdownLine[] = [];
  for (const medicine of catalog.medicines) {
    const selected = included.has(medicine.id);
    if (draft.scope === 'full' || selected) {
      lines.push({
        key: `medicine:${medicine.id}`,
        kind: 'medicine',
        label: medicine.label,
        amountPence: Math.max(0, medicine.amountPence),
      });
    }
  }
  if (catalog.dispensingFeePence > 0 && (draft.scope === 'full' || dispensingPercent > 0)) {
    lines.push({
      key: 'charge:dispensing',
      kind: 'dispensing',
      label: 'Dispensing charge',
      amountPence: chargeSharePence(catalog.dispensingFeePence, dispensingPercent),
      percent: dispensingPercent,
    });
  }
  if (catalog.deliveryFeePence > 0 && (draft.scope === 'full' || deliveryPercent > 0)) {
    lines.push({
      key: 'charge:delivery',
      kind: 'delivery',
      label: 'Delivery charge',
      amountPence: chargeSharePence(catalog.deliveryFeePence, deliveryPercent),
      percent: deliveryPercent,
    });
  }

  const amountPence = lines.reduce((sum, line) => sum + line.amountPence, 0);
  return { scope: draft.scope, amountPence, lines };
}

export function refundCompositionError(catalog: RefundCatalog, draft: RefundDraft, claimedAmountPence?: number) {
  if (draft.scope === 'partial' && !isRefundChargePercent(draft.dispensingPercent)) return 'Choose 100, 75, 50, 25 or 0 percent for the dispensing charge.';
  if (draft.scope === 'partial' && !isRefundChargePercent(draft.deliveryPercent)) return 'Choose 100, 75, 50, 25 or 0 percent for the delivery charge.';
  const composed = composeRefund(catalog, draft);
  if (composed.amountPence <= 0) return 'Choose at least one item or charge to refund.';
  if (composed.amountPence > catalog.paidPence) return 'The refund cannot exceed the settled payment.';
  if (draft.scope === 'full' && composed.amountPence !== catalog.paidPence) return 'The item and charge breakdown does not match the settled payment.';
  if (claimedAmountPence != null && claimedAmountPence !== composed.amountPence) return 'The refund total does not match the selected items.';
  return null;
}

export function catalogFromOrderPence(input: {
  medicines: RefundMedicineLine[];
  dispensingFeePence: number;
  deliveryFeePence: number;
  paidPence: number;
}): RefundCatalog {
  return {
    medicines: input.medicines.filter(line => line.amountPence > 0),
    dispensingFeePence: Math.max(0, Math.round(input.dispensingFeePence)),
    deliveryFeePence: Math.max(0, Math.round(input.deliveryFeePence)),
    paidPence: Math.max(0, Math.round(input.paidPence)),
  };
}
