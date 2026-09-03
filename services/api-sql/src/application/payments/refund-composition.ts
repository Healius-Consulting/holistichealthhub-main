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

export function isRefundChargePercent(value: number): value is RefundChargePercent {
  return (REFUND_CHARGE_PERCENTS as readonly number[]).includes(value);
}

export function chargeSharePence(amountPence: number, percent: RefundChargePercent) {
  return Math.round((Math.max(0, amountPence) * percent) / 100);
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

export function composeRefund(catalog: RefundCatalog, draft: RefundDraft) {
  const included = new Set(draft.scope === 'full' ? catalog.medicines.map(line => line.id) : draft.includedMedicineIds);
  const dispensingPercent: RefundChargePercent = draft.scope === 'full' ? (catalog.dispensingFeePence > 0 ? 100 : 0) : draft.dispensingPercent;
  const deliveryPercent: RefundChargePercent = draft.scope === 'full' ? (catalog.deliveryFeePence > 0 ? 100 : 0) : draft.deliveryPercent;
  const lines: RefundBreakdownLine[] = [];
  for (const medicine of catalog.medicines) {
    if (draft.scope === 'full' || included.has(medicine.id)) {
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
  return {
    scope: draft.scope,
    amountPence: lines.reduce((sum, line) => sum + line.amountPence, 0),
    lines,
  };
}

export function defaultRefundDraft(catalog: RefundCatalog): RefundDraft {
  return {
    scope: 'full',
    includedMedicineIds: catalog.medicines.map(line => line.id),
    dispensingPercent: catalog.dispensingFeePence > 0 ? 100 : 0,
    deliveryPercent: catalog.deliveryFeePence > 0 ? 100 : 0,
  };
}

export function staffRefundDraft(catalog: RefundCatalog, input: {
  scope: RefundScope;
  includedMedicineIds?: string[];
  dispensingPercent?: number;
  deliveryPercent?: number;
}): { draft: RefundDraft; error?: undefined } | { draft?: undefined; error: string } {
  if (input.scope === 'full') return { draft: defaultRefundDraft(catalog) };
  if (!Array.isArray(input.includedMedicineIds)) {
    return { error: 'Partial refunds must list which medicines to return.' };
  }
  const known = new Set(catalog.medicines.map(line => line.id));
  if (input.includedMedicineIds.some(id => !known.has(id))) {
    return { error: 'A selected medicine is not on this paid order.' };
  }
  if (catalog.dispensingFeePence > 0 && !isRefundChargePercent(Number(input.dispensingPercent))) {
    return { error: 'Choose 100, 75, 50, 25 or 0 percent for the dispensing charge.' };
  }
  if (catalog.deliveryFeePence > 0 && !isRefundChargePercent(Number(input.deliveryPercent))) {
    return { error: 'Choose 100, 75, 50, 25 or 0 percent for the delivery charge.' };
  }
  return {
    draft: {
      scope: 'partial',
      includedMedicineIds: input.includedMedicineIds.filter(id => known.has(id)),
      dispensingPercent: catalog.dispensingFeePence > 0 ? input.dispensingPercent as RefundChargePercent : 0,
      deliveryPercent: catalog.deliveryFeePence > 0 ? input.deliveryPercent as RefundChargePercent : 0,
    },
  };
}

export function resolveStaffRefund(catalog: RefundCatalog, input: {
  scope: RefundScope;
  amountPence: number;
  includedMedicineIds?: string[];
  dispensingPercent?: number;
  deliveryPercent?: number;
}): { error: string; composed?: undefined } | { error?: undefined; composed: ReturnType<typeof composeRefund> } {
  if (input.scope === 'full' && catalog.medicines.length === 0 && catalog.dispensingFeePence === 0 && catalog.deliveryFeePence === 0) {
    if (input.amountPence !== catalog.paidPence || catalog.paidPence <= 0) {
      return { error: 'A full refund must return the settled payment.' };
    }
    return {
      composed: {
        scope: 'full',
        amountPence: catalog.paidPence,
        lines: [{ key: 'order', kind: 'medicine', label: 'Settled payment', amountPence: catalog.paidPence }],
      },
    };
  }
  const prepared = staffRefundDraft(catalog, input);
  if (prepared.error || !prepared.draft) return { error: prepared.error ?? 'The refund could not be prepared.' };
  const error = refundCompositionError(catalog, prepared.draft, input.amountPence);
  if (error) return { error };
  return { composed: composeRefund(catalog, prepared.draft) };
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

export function catalogFromPortalOrderSources(input: {
  orderLines?: Array<{ packId?: string | null; formulaName?: string | null; quantity?: number | null; lineMedicineRevenuePence?: number | null; fixedPatientPricePence?: number | null }>;
  snapshotLineItems?: Array<{ packId?: string | null; productId?: string | null; name?: string | null; quantity?: number | null; unitPricePence?: number | null }>;
  dispensingFeePence: number;
  pharmacyDeliveryPence: number;
  paidPence: number;
}): RefundCatalog {
  const fromLines = (input.orderLines ?? []).map(line => {
    const quantity = Math.max(1, Number(line.quantity || 1));
    const amountPence = Number(line.lineMedicineRevenuePence || 0) || Number(line.fixedPatientPricePence || 0) * quantity;
    return {
      id: String(line.packId || '').trim(),
      label: String(line.formulaName || line.packId || 'Medicine').trim() || 'Medicine',
      amountPence: Math.max(0, Math.round(amountPence)),
    };
  }).filter(line => line.id);
  const fromSnapshot = (input.snapshotLineItems ?? []).map(line => ({
    id: String(line.packId || line.productId || '').trim(),
    label: String(line.name || line.packId || 'Medicine').trim() || 'Medicine',
    amountPence: Math.max(0, Math.round(Number(line.unitPricePence || 0) * Math.max(1, Number(line.quantity || 1)))),
  })).filter(line => line.id);
  return catalogFromOrderPence({
    medicines: fromLines.length ? fromLines : fromSnapshot,
    dispensingFeePence: input.dispensingFeePence,
    deliveryFeePence: input.pharmacyDeliveryPence,
    paidPence: input.paidPence,
  });
}
