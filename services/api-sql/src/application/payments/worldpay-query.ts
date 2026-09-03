export type WorldpayPaymentStatus =
  | 'pending'
  | 'paid'
  | 'failed'
  | 'cancelled'
  | 'expired'
  | 'refund_required'
  | 'refunded';

export type WorldpayPaymentQuery = {
  found: boolean;
  transactionReference: string;
  paymentId: string | null;
  providerStatus: string | null;
  paymentStatus: WorldpayPaymentStatus;
  amountPence: number | null;
  currency: string | null;
  entityId: string | null;
  payment: Record<string, unknown> | null;
};

export type WorldpayRefundAction = {
  href: string;
  style: 'card-payments' | 'payments-api';
};

function object(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function string(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function linkedHref(container: Record<string, unknown> | null, keys: string[]): string | null {
  for (const key of keys) {
    const href = string(object(container?.[key])?.href);
    if (href) return href;
  }
  return null;
}

/** Resolve only documented refund actions. The caller must still validate the URL host. */
export function worldpayRefundAction(
  payment: Record<string, unknown> | null,
  partial: boolean,
): WorldpayRefundAction | null {
  if (!payment) return null;
  const actions = object(payment._actions);
  const modernHref = linkedHref(actions, partial ? ['partiallyRefundPayment'] : ['refundPayment']);
  if (modernHref) return { href: modernHref, style: 'payments-api' };

  const links = object(payment._links);
  const linkHref = linkedHref(links, partial
    ? ['cardPayments:partialRefund', 'payments:partialRefund', 'partialRefund']
    : ['cardPayments:refund', 'payments:refund', 'refund']);
  return linkHref ? { href: linkHref, style: 'card-payments' } : null;
}

function finiteNumber(value: unknown): number | null {
  const parsed = typeof value === 'number' ? value : typeof value === 'string' && value.trim() ? Number(value) : Number.NaN;
  return Number.isFinite(parsed) ? parsed : null;
}

function normalisedStatus(value: string | null) {
  return (value ?? '').toLowerCase().replace(/[^a-z]/g, '');
}

export function worldpayPaymentStatus(providerStatus: string | null): WorldpayPaymentStatus {
  switch (normalisedStatus(providerStatus)) {
    case 'sentforsettlement':
    case 'settlementrequestsubmitted':
    case 'salesucceeded':
    case 'settled':
    case 'settlementsucceeded':
      return 'paid';
    case 'refused':
    case 'authorizationrefused':
    case 'salerefused':
    case 'error':
    case 'authorizationfailed':
    case 'salefailed':
    case 'settlementrequestsubmissionfailed':
    case 'settlementfailed':
      return 'failed';
    case 'cancelled':
    case 'canceled':
    case 'cancellationrequestsubmitted':
      return 'cancelled';
    case 'expired':
      return 'expired';
    case 'sentforrefund':
    case 'sentforpartialrefund':
    case 'refundrequested':
    case 'refundrequestsubmitted':
    case 'partialrefundrequested':
    case 'partialrefundrequestsubmitted':
    case 'refundfailed':
    case 'refundrequestsubmissionfailed':
      return 'refund_required';
    case 'refunded':
    case 'refundsucceeded':
    case 'partiallyrefunded':
    case 'partialrefundsucceeded':
      return 'refunded';
    default:
      // Authorization reserves funds but does not prove that settlement has started.
      return 'pending';
  }
}

export type WorldpayRefundVerification = {
  verified: boolean;
  pending: boolean;
  reason: string;
  evidence: Record<string, unknown> | null;
};

function recordArray(value: unknown): Record<string, unknown>[] {
  return Array.isArray(value) ? value.map(object).filter((entry): entry is Record<string, unknown> => Boolean(entry)) : [];
}

function refundEvidenceCandidates(payment: Record<string, unknown> | null) {
  if (!payment) return [];
  const embedded = object(payment._embedded);
  return [
    ...recordArray(payment.refunds),
    ...recordArray(payment.events),
    ...recordArray(embedded?.refunds),
    ...recordArray(embedded?.events),
  ];
}

function refundEvidenceStatus(candidate: Record<string, unknown>) {
  return string(candidate.lastEvent) ?? string(candidate.eventName) ?? string(candidate.type)
    ?? string(candidate.status) ?? string(candidate.outcome);
}

function refundEvidenceReference(candidate: Record<string, unknown>) {
  return string(candidate.commandId) ?? string(candidate.refundReference) ?? string(candidate.reference)
    ?? string(candidate.externalReference) ?? string(candidate.paymentId);
}

function refundEvidenceValue(candidate: Record<string, unknown>) {
  const value = object(candidate.value) ?? object(candidate.amount);
  return {
    amountPence: finiteNumber(value?.amount) ?? finiteNumber(value?.value),
    currency: string(value?.currency) ?? string(value?.currencyCode),
  };
}

/**
 * Payment Queries always lets us verify the original payment identity. A terminal
 * full-refund state also proves the whole original value was refunded. Partial
 * refunds are only accepted when the provider payload exposes an exact terminal
 * refund event with the staff-recorded reference, amount and currency.
 */
export function verifyWorldpayRefund(input: {
  query: WorldpayPaymentQuery;
  transactionReference: string;
  paymentId: string | null;
  paymentAmountPence: number;
  refundAmountPence: number;
  currency: string;
  expectedEntityId: string;
  externalReference: string;
  alternateReferences?: string[];
}): WorldpayRefundVerification {
  const identityMatches = worldpayIdentityMatches({
    query: input.query,
    transactionReference: input.transactionReference,
    amountPence: input.paymentAmountPence,
    currency: input.currency,
    expectedEntityId: input.expectedEntityId,
  });
  if (!identityMatches) return { verified: false, pending: false, reason: 'payment_identity_mismatch', evidence: null };
  const providerStatus = normalisedStatus(input.query.providerStatus);
  if (providerStatus.includes('refund') && (providerStatus.includes('failed') || providerStatus.includes('refused'))) {
    return { verified: false, pending: false, reason: 'provider_refund_failed', evidence: null };
  }
  if (input.query.paymentStatus === 'refund_required') {
    return { verified: false, pending: true, reason: 'provider_refund_pending', evidence: null };
  }
  if (input.query.paymentStatus !== 'refunded') {
    return { verified: false, pending: false, reason: 'provider_refund_not_completed', evidence: null };
  }

  if (input.refundAmountPence === input.paymentAmountPence
    && !providerStatus.includes('partial')) {
    return {
      verified: true,
      pending: false,
      reason: 'provider_full_refund_completed',
      evidence: {
        providerPaymentId: input.query.paymentId,
        providerStatus: input.query.providerStatus,
        amountPence: input.paymentAmountPence,
        currency: input.currency,
      },
    };
  }

  const acceptedReferences = new Set([input.externalReference, ...(input.alternateReferences ?? [])].filter(Boolean));
  const exact = refundEvidenceCandidates(input.query.payment).find(candidate => {
    const status = worldpayPaymentStatus(refundEvidenceStatus(candidate));
    const reference = refundEvidenceReference(candidate);
    const value = refundEvidenceValue(candidate);
    const parentPaymentId = string(candidate.originalPaymentId) ?? string(candidate.parentPaymentId);
    return status === 'refunded'
      && Boolean(reference && acceptedReferences.has(reference))
      && value.amountPence === input.refundAmountPence
      && value.currency === input.currency
      && (!parentPaymentId || parentPaymentId === input.paymentId);
  }) ?? null;
  if (!exact) {
    return { verified: false, pending: false, reason: 'partial_refund_evidence_missing', evidence: null };
  }
  return { verified: true, pending: false, reason: 'provider_partial_refund_completed', evidence: exact };
}

export function worldpayStatusToSql(status: WorldpayPaymentStatus): 'PENDING' | 'PAID' | 'FAILED' | 'CANCELLED' | 'EXPIRED' | 'REFUND_REQUIRED' | 'REFUNDED' {
  switch (status) {
    case 'paid':
      return 'PAID';
    case 'failed':
      return 'FAILED';
    case 'cancelled':
      return 'CANCELLED';
    case 'expired':
      return 'EXPIRED';
    case 'refund_required':
      return 'REFUND_REQUIRED';
    case 'refunded':
      return 'REFUNDED';
    default:
      return 'PENDING';
  }
}

export function normaliseWorldpayPaymentQuery(value: unknown, transactionReference: string): WorldpayPaymentQuery {
  const response = object(value);
  const embedded = object(response?._embedded);
  const candidates = string(response?.transactionReference) === transactionReference
    ? [response]
    : Array.isArray(embedded?.payments)
      ? embedded.payments
      : Array.isArray(response?.payments)
        ? response.payments
        : [];
  const payment = candidates.map(object).find(candidate => string(candidate?.transactionReference) === transactionReference) ?? null;
  if (!payment) {
    return {
      found: false,
      transactionReference,
      paymentId: null,
      providerStatus: null,
      paymentStatus: 'pending',
      amountPence: null,
      currency: null,
      entityId: null,
      payment: null,
    };
  }
  const valueObject = object(payment.value) ?? object(payment.amount);
  const merchant = object(payment.merchant);
  const providerStatus = string(payment.lastEvent) ?? string(payment.eventName) ?? string(payment.status) ?? string(payment.outcome);
  return {
    found: true,
    transactionReference,
    paymentId: string(payment.paymentId),
    providerStatus,
    paymentStatus: worldpayPaymentStatus(providerStatus),
    amountPence: finiteNumber(valueObject?.amount) ?? finiteNumber(valueObject?.value),
    currency: string(valueObject?.currency) ?? string(valueObject?.currencyCode),
    entityId: string(payment.entityReference) ?? string(payment.entity) ?? string(merchant?.entity),
    payment,
  };
}

export function worldpayIdentityMatches(input: {
  query: WorldpayPaymentQuery;
  transactionReference: string;
  amountPence: number;
  currency: string;
  expectedEntityId: string;
}): boolean {
  return input.query.transactionReference === input.transactionReference
    && input.query.amountPence === input.amountPence
    && input.query.currency === input.currency
    && input.query.entityId === input.expectedEntityId;
}

export type WorldpayWebhookEvent = {
  eventId: string;
  eventTimestamp: string | null;
  transactionReference: string;
  type: string;
  entityId: string | null;
  paymentId: string | null;
  amountPence: number | null;
  currency: string | null;
};

export function parseWorldpayWebhookEvent(value: unknown): WorldpayWebhookEvent {
  const event = object(value);
  const details = object(event?.eventDetails);
  const amount = object(details?.amount);
  const merchant = object(details?.merchant);
  const eventId = string(event?.eventId);
  const transactionReference = string(details?.transactionReference);
  const type = string(details?.type);
  if (!eventId || !transactionReference || !type) {
    throw new Error('INVALID_WORLDPAY_EVENT');
  }
  return {
    eventId,
    eventTimestamp: string(event?.eventTimestamp),
    transactionReference,
    type,
    entityId: string(merchant?.entity),
    paymentId: string(details?.paymentId),
    amountPence: finiteNumber(amount?.value),
    currency: string(amount?.currencyCode),
  };
}

export function transactionReferenceFromWorldpayWebhook(value: unknown): string | null {
  try {
    return parseWorldpayWebhookEvent(value).transactionReference;
  } catch {
    const body = object(value);
    return string(body?.orderCode) ?? string(body?.transactionReference);
  }
}

export function displayedPublicPaymentStatus(payment: { status: string } | null): string {
  if (!payment) return 'pending';
  return payment.status.toLowerCase();
}

export function isUsablePublicPaymentLookup(value: string): boolean {
  return /^[A-Za-z0-9._:-]{8,128}$/.test(value);
}

export function publicPaymentStatusBody(
  payment: {
    status: string;
    transactionReference?: string | null;
    amountPence?: number;
    currency?: string;
  } | null,
  lookupRef: string | null,
) {
  if (!payment) {
    return {
      status: displayedPublicPaymentStatus(null),
      transactionReference: lookupRef,
      message: 'Payment verification is processing...',
    };
  }
  return {
    status: displayedPublicPaymentStatus(payment),
    transactionReference: payment.transactionReference ?? lookupRef,
    amountPence: payment.amountPence,
    currency: payment.currency,
  };
}
