export type PublicPaymentReceiptLine = {
  key: 'medicine' | 'dispensing' | 'pharmacyDelivery' | 'delivery';
  label: string;
  amountPence: number;
};

export type PublicPaymentReceiptBody = {
  id: string;
  amountPence: number;
  currency: string;
  status: string;
  createdAt: string;
  updatedAt?: string | null;
  orderNumber?: string | null;
  refundedAmountPence?: number | null;
  partial?: boolean;
  breakdown?: PublicPaymentReceiptLine[];
};

export type PublicReceiptOrderPricing = {
  medicineTotalPence?: number | null;
  dispensingFeePence?: number | null;
  pharmacyDeliveryPence?: number | null;
  deliveryPence?: number | null;
};

function pence(value: unknown) {
  const parsed = Math.round(Number(value || 0));
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 0;
}

/**
 * A patient-facing breakdown is only honest when its parts add up to the money that
 * actually moved, so a stale or renegotiated order total drops the lines rather than
 * showing a split that does not reconcile with the amount charged.
 */
export function publicReceiptBreakdown(
  amountPence: number,
  order?: PublicReceiptOrderPricing | null,
): PublicPaymentReceiptLine[] | undefined {
  if (!order) return undefined;
  const medicine = pence(order.medicineTotalPence);
  const dispensing = pence(order.dispensingFeePence);
  const pharmacyDelivery = pence(order.pharmacyDeliveryPence);
  const supplierDelivery = pence(order.deliveryPence);
  if (medicine <= 0) return undefined;

  const withoutSupplierDelivery = medicine + dispensing + pharmacyDelivery;
  // Orders priced before pricing policy v2 charged the patient for Curaleaf shipping too.
  const includeSupplierDelivery = withoutSupplierDelivery !== amountPence
    && withoutSupplierDelivery + supplierDelivery === amountPence;
  if (withoutSupplierDelivery !== amountPence && !includeSupplierDelivery) return undefined;

  const lines: PublicPaymentReceiptLine[] = [{ key: 'medicine', label: 'Medicine', amountPence: medicine }];
  if (dispensing > 0) lines.push({ key: 'dispensing', label: 'Dispensing Cost', amountPence: dispensing });
  if (pharmacyDelivery > 0) lines.push({ key: 'pharmacyDelivery', label: 'Pharmacy Delivery', amountPence: pharmacyDelivery });
  if (includeSupplierDelivery) lines.push({ key: 'delivery', label: 'Delivery', amountPence: supplierDelivery });
  return lines;
}

export function buildPublicPaymentReceipt(input: {
  payment: {
    id: string;
    amountPence: number;
    currency: string;
    status: string;
    createdAt: string;
    updatedAt?: string | null;
  };
  orderNumber?: string | null;
  order?: PublicReceiptOrderPricing | null;
  completedRefunds?: Array<{ paymentId: string; amountPence: number | string; status: string }>;
}): PublicPaymentReceiptBody {
  const completed = (input.completedRefunds ?? [])
    .filter(row => String(row.status).toUpperCase() === 'COMPLETED' && row.paymentId === input.payment.id)
    .reduce((sum, row) => sum + Number(row.amountPence || 0), 0);
  const amountPence = Number(input.payment.amountPence || 0);
  const refundedAmountPence = completed > 0 ? completed : null;
  const partial = Boolean(refundedAmountPence != null && refundedAmountPence > 0 && refundedAmountPence < amountPence);
  const paymentStatus = String(input.payment.status || '').toLowerCase();
  const status = paymentStatus === 'refunded' || (refundedAmountPence != null && refundedAmountPence >= amountPence)
    ? 'refunded'
    : paymentStatus;
  const breakdown = publicReceiptBreakdown(amountPence, input.order);

  return {
    id: input.payment.id,
    amountPence,
    currency: input.payment.currency || 'GBP',
    status,
    createdAt: input.payment.createdAt,
    updatedAt: input.payment.updatedAt ?? null,
    orderNumber: input.orderNumber ?? null,
    refundedAmountPence,
    partial,
    ...(breakdown ? { breakdown } : {}),
  };
}
