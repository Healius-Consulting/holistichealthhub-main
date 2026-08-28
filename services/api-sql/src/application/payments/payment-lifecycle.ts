import type { PaymentRecord } from '../../repositories/ports/payment.port.js';

export const PAYMENT_REMINDER_HOURS = [24, 48] as const;

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function count(value: unknown) {
  const number = Number(value ?? 0);
  return Number.isFinite(number) && number > 0 ? Math.floor(number) : 0;
}

export function snapshotPrescriptions(snapshot: unknown): Array<Record<string, unknown>> {
  const root = asRecord(snapshot);
  return Array.isArray(root.prescriptions)
    ? root.prescriptions.filter((value): value is Record<string, unknown> => Boolean(value) && typeof value === 'object')
    : [];
}

export function prescriptionIsCurrent(prescription: Record<string, unknown>, now: Date) {
  if (prescription.payable === false || prescription.cancelled === true) return false;
  const expiry = Date.parse(`${String(prescription.expiryDate ?? '')}T23:59:59.999Z`);
  return !Number.isFinite(expiry) || now.getTime() <= expiry;
}

export function orderPayableTotal(order: { dispensingFeePence?: number; pharmacyDeliveryPence?: number; quoteSnapshot?: unknown }, current: Array<Record<string, unknown>>) {
  const snapshot = asRecord(order.quoteSnapshot);
  const lines = Array.isArray(snapshot.lineItems) ? snapshot.lineItems as Array<Record<string, unknown>> : [];
  const priceByPack = new Map(lines.map(line => [String(line.packId ?? line.productId ?? ''), Number(line.unitPricePence ?? 0)]));
  const productTotal = current
    .flatMap(prescription => Array.isArray(prescription.items) ? prescription.items as Array<Record<string, unknown>> : [])
    .reduce((total, item) => total + (priceByPack.get(String(item.packId ?? item.productId ?? '')) ?? 0) * count(item.quantity), 0);
  return productTotal > 0
    ? productTotal + Number(order.dispensingFeePence ?? 0) + Number(order.pharmacyDeliveryPence ?? 0)
    : 0;
}

export type PaymentLifecycleAction =
  | { action: 'none' }
  | { action: 'remind'; hour: 24 | 48 }
  | { action: 'void_expired' }
  | { action: 'reduce_expired'; amountPence: number; current: Array<Record<string, unknown>> };

export function evaluatePendingPaymentLifecycle(input: {
  payment: Pick<PaymentRecord, 'status' | 'route' | 'createdAt' | 'providerPayload'>;
  quoteSnapshot: unknown;
  dispensingFeePence?: number;
  pharmacyDeliveryPence?: number;
  now?: Date;
}): PaymentLifecycleAction {
  if (input.payment.status !== 'PENDING' || input.payment.route !== 'WORLDPAY') return { action: 'none' };
  const now = input.now ?? new Date();
  const prescriptions = snapshotPrescriptions(input.quoteSnapshot);
  const payable = prescriptions.filter(prescription => prescription.payable !== false && prescription.cancelled !== true);
  const current = payable.filter(prescription => prescriptionIsCurrent(prescription, now));
  if (current.length !== payable.length) {
    const amountPence = orderPayableTotal({
      dispensingFeePence: input.dispensingFeePence,
      pharmacyDeliveryPence: input.pharmacyDeliveryPence,
      quoteSnapshot: input.quoteSnapshot,
    }, current);
    return amountPence > 0
      ? { action: 'reduce_expired', amountPence, current }
      : { action: 'void_expired' };
  }

  const sentAt = Date.parse(String(input.payment.createdAt ?? ''));
  if (!Number.isFinite(sentAt)) return { action: 'none' };
  const elapsedHours = (now.getTime() - sentAt) / 3_600_000;
  const payload = asRecord(input.payment.providerPayload);
  if (elapsedHours >= 48 && !payload.reminder48At) return { action: 'remind', hour: 48 };
  if (elapsedHours >= 24 && !payload.reminder24At) return { action: 'remind', hour: 24 };
  return { action: 'none' };
}
