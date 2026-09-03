import { lineRevenue, type PatientOrder } from '../context/AppContext';
import {
  catalogFromOrderPence,
  type RefundCatalog,
  type RefundChargePercent,
  type RefundDraft,
} from './refundComposition';

export type RefundRequestInput = RefundDraft & { amountPence: number };

export function catalogFromPatientOrder(order: PatientOrder): RefundCatalog {
  const medicines = order.prescriptions.flatMap(prescription => prescription.items.map(item => ({
    id: item.productId,
    label: `${item.name}${item.qty > 1 ? ` × ${item.qty}` : ''}`,
    amountPence: Math.max(0, Math.round(lineRevenue(item) * 100)),
  })));
  return catalogFromOrderPence({
    medicines,
    dispensingFeePence: Math.round((order.dispensingFee || 0) * 100),
    deliveryFeePence: Math.round((order.pharmacyDelivery || 0) * 100),
    paidPence: Math.round(order.payment.amount * 100),
  });
}

export const REFUND_PERCENT_OPTIONS: RefundChargePercent[] = [100, 75, 50, 25, 0];
