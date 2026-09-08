import type { RefundRecord } from '../../repositories/ports/payment.port.js';

/** A paid £150 order with two prescriptions that share one product, one cancelled at Curaleaf. */
export function refundFixture() {
  return {
    order: { id: 'order', organisationId: 'org', version: 1, updatedAt: '2026-09-08T00:00:00Z', dispensingFeePence: 1000, pharmacyDeliveryPence: 500,
      quoteSnapshot: { prescriptions: [{ hhhPrescriptionId: 'rx1' }, { hhhPrescriptionId: 'rx2' }], curaleafSubOrders: {
        rx1: { purchaseOrderId: 'po1', purchaseOrderState: 'CANCELLED', lines: [{ productId: 'same-product', ordered: 1, shipped: 0 }] },
        rx2: { purchaseOrderId: 'po2', purchaseOrderState: 'PROCESSING', lines: [{ productId: 'same-product', ordered: 1, shipped: 0 }] },
      } } } as any,
    payment: { id: 'payment', organisationId: 'org', orderId: 'order', amountPence: 15000, version: 1, status: 'PAID', route: 'MANUAL', currency: 'GBP' } as any,
    allocations: [{ id: 'allocation', orderId: 'order', status: 'ACTIVE', amountPence: 15000, version: 1 }] as any,
    refunds: [] as RefundRecord[],
    lines: [
      { id: 'line1', orderId: 'order', prescriptionId: 'rx1', packId: 'same-product', quantity: 1, fixedPatientPricePence: 8500, lineMedicineRevenuePence: 8500 },
      { id: 'line2', orderId: 'order', prescriptionId: 'rx2', packId: 'same-product', quantity: 1, fixedPatientPricePence: 5000, lineMedicineRevenuePence: 5000 },
    ] as any,
    prescriptionId: 'rx1',
  };
}
