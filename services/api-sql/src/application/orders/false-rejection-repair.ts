type RepairOrder = {
  id: string;
  organisationId: string;
  orderNumber?: string | null;
  status?: string | null;
  paymentStatus?: string | null;
  fulfilmentStatus?: string | null;
  paidAt?: string | null;
  quoteSnapshot?: unknown;
};

type RepairPayment = { status?: string | null };
type RepairRefund = { status?: string | null };
type RepairOperation = {
  operationType?: string | null;
  status?: string | null;
  supplierPurchaseOrderId?: string | null;
  responsePayload?: unknown;
};

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function normalizedUuid(value: string): string {
  return value.trim().toLowerCase().replaceAll('-', '');
}

function containsFalseRejectionMarker(value: unknown): boolean {
  try {
    return JSON.stringify(value).toLowerCase().includes('curaleaf_prescription_rejected');
  } catch {
    return false;
  }
}

function operationCreatedSupplierClinicalRecord(operation: RepairOperation): boolean {
  if (String(operation.status || '').toUpperCase() !== 'SUCCEEDED') return false;
  const type = String(operation.operationType || '').toLowerCase();
  if (operation.supplierPurchaseOrderId) return true;
  if (!/(prescription|purchase.?order)/.test(type)) return false;
  const response = asRecord(operation.responsePayload);
  return Boolean(response.id || response.prescriptionId || response.purchaseOrderId);
}

export function planFalseRejectionRepair(input: {
  order: RepairOrder;
  expectedOrderNumber: string;
  expectedOrganisationId: string;
  payments: RepairPayment[];
  refunds: RepairRefund[];
  operations: RepairOperation[];
  now?: string;
}) {
  const { order } = input;
  const snapshot = asRecord(order.quoteSnapshot);
  const curaleaf = asRecord(snapshot.curaleaf);
  const reasons: string[] = [];

  if (order.orderNumber !== input.expectedOrderNumber) reasons.push('order_number_mismatch');
  if (normalizedUuid(order.organisationId) !== normalizedUuid(input.expectedOrganisationId)) reasons.push('organisation_mismatch');
  if (!['CANCELLED', 'EXCEPTION', 'PROCESSING'].includes(String(order.status || '').toUpperCase())) {
    reasons.push('order_not_in_repairable_state');
  }
  if (String(order.paymentStatus || '').toUpperCase() !== 'PAID' || !order.paidAt) reasons.push('order_not_settled');
  if (!input.payments.some(payment => String(payment.status || '').toUpperCase() === 'PAID')) reasons.push('paid_payment_missing');
  if (input.refunds.some(refund => !['FAILED', 'CANCELLED'].includes(String(refund.status || '').toUpperCase()))) {
    reasons.push('refund_already_started');
  }
  if (!containsFalseRejectionMarker(snapshot)) reasons.push('expected_false_rejection_marker_missing');
  if (!String(curaleaf.prescriberId || '').trim()) reasons.push('supplier_prescriber_missing');
  if (String(curaleaf.prescriptionId || '').trim()) reasons.push('supplier_prescription_already_exists');
  if (String(curaleaf.purchaseOrderId || '').trim()) reasons.push('supplier_purchase_order_already_exists');
  if (input.operations.some(operationCreatedSupplierClinicalRecord)) reasons.push('successful_supplier_clinical_operation_exists');

  if (reasons.length > 0) return { eligible: false as const, reasons };

  const now = input.now ?? new Date().toISOString();
  const nextSnapshot: Record<string, unknown> = {
    ...snapshot,
    curaleaf: {
      ...curaleaf,
      status: 'prescriber_verification_required',
      prescriberState: 'UNVERIFIED',
    },
    curaleafAttention: {
      status: 'correction_required',
      source: 'prescriber',
      code: 'PRESCRIBER_VERIFICATION_REQUIRED',
      reason: 'Correct the prescriber regulator details, then wait for Curaleaf VERIFIED before creating a prescription.',
      recordedAt: now,
    },
    repair: {
      kind: 'false_prescription_rejection',
      repairedAt: now,
      priorFulfilmentStatus: order.fulfilmentStatus ?? null,
    },
  };
  delete nextSnapshot.cancellation;
  delete nextSnapshot.curaleafCancellation;
  delete nextSnapshot.refund;

  return {
    eligible: true as const,
    reasons: [],
    orderId: order.id,
    organisationId: order.organisationId,
    nextSnapshot,
    nextOrderStatus: 'PROCESSING' as const,
    nextPaymentStatus: 'PAID' as const,
    nextFulfilmentStatus: 'SUPPLIER_PENDING' as const,
  };
}
