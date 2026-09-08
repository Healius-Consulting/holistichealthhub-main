import { createHash } from 'node:crypto';
import type { OrderRecord } from '../../repositories/ports/order.port.js';
import type { OrderLineRecord } from '../../repositories/ports/order-line.port.js';
import type { RefundRecord } from '../../repositories/ports/payment.port.js';
import { asSnapshotRecord, snapshotRxList } from '../prescriptions/snapshot-rx.js';
import { prescriptionRefundTotal, type PrescriptionRefundBreakdown } from './prescription-refund.js';

/** Reconstruct only explicit, exact historical breakdowns. Never infer an Rx share of an order total. */
export function historicalPrescriptionRefundBreakdown(order: OrderRecord, lines: OrderLineRecord[], refund: RefundRecord): PrescriptionRefundBreakdown | null {
  if (refund.breakdown || refund.prescriptionId || refund.status !== 'COMPLETED') return null;
  const snapshot = asSnapshotRecord(order.quoteSnapshot);
  const history = asSnapshotRecord(snapshot.refund);
  const prescriptions = snapshotRxList(snapshot);
  if (prescriptions.length !== 1 || history.id !== refund.id || !Array.isArray(history.lines)) return null;
  const prescriptionId = String(prescriptions[0]!.hhhPrescriptionId || '');
  if (!prescriptionId || !lines.length || lines.some(line => line.prescriptionId !== prescriptionId)) return null;
  const result: PrescriptionRefundBreakdown = { version: 1, prescriptionId, medicines: [], dispensingFeePence: 0, deliveryFeePence: 0, requestHash: createHash('sha256').update(`historical:${refund.id}`).digest('hex') };
  const seen = new Set<string>();
  for (const entry of history.lines) {
    const row = asSnapshotRecord(entry); const key = String(row.key || ''); const amount = Number(row.amountPence);
    if (!key || seen.has(key) || !Number.isSafeInteger(amount) || amount < 0) return null;
    seen.add(key);
    if (row.kind === 'medicine') {
      const matches = lines.filter(line => key === `medicine:${line.packId}`);
      if (matches.length !== 1 || Number(matches[0]!.fixedPatientPricePence) <= 0) return null;
      const line = matches[0]!; const quantity = amount / Number(line.fixedPatientPricePence);
      if (!Number.isSafeInteger(quantity) || quantity <= 0 || quantity > Number(line.quantity)) return null;
      result.medicines.push({ orderLineId: line.id, label: line.formulaName || line.packId, quantity, unitPricePence: Number(line.fixedPatientPricePence), amountPence: amount });
    } else if (row.kind === 'dispensing' && key === 'charge:dispensing' && amount <= Number(order.dispensingFeePence)) result.dispensingFeePence = amount;
    else if (row.kind === 'delivery' && key === 'charge:delivery' && amount <= Number(order.pharmacyDeliveryPence)) result.deliveryFeePence = amount;
    else return null;
  }
  return prescriptionRefundTotal(result) === Number(refund.amountPence) ? result : null;
}
