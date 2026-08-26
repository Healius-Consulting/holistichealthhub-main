export type PaymentSqlStatus =
  | 'PENDING'
  | 'PAID'
  | 'FAILED'
  | 'REFUNDED'
  | 'CANCELLED'
  | 'EXPIRED'
  | 'REFUND_REQUIRED'
  | 'RECONCILIATION_REQUIRED';

export interface PaymentRecord {
  id: string;
  organisationId: string;
  orderId: string;
  patientId?: string;
  status: PaymentSqlStatus;
  amountPence: number;
  currency: string;
  route: 'MANUAL' | 'WORLDPAY';
  transactionReference?: string | null;
  receiptHash: string | null;
  hostedPaymentUrl?: string | null;
  linkExpiresAt?: string | null;
  providerPayload?: unknown;
  manualTender?: string | null;
  manualReference?: string | null;
  baselineQuoteCheckId?: string | null;
  basketFingerprint?: string | null;
  version: number;
  createdAt: string;
  updatedAt?: string;
}

export interface RefundRecord {
  id: string;
  organisationId: string;
  orderId: string;
  paymentId: string;
  status: 'PENDING_CONFIRMATION' | 'COMPLETED' | 'FAILED' | string;
  amountPence: number | string;
  currency?: string | null;
  cause?: string | null;
  route?: 'MANUAL' | 'WORLDPAY' | string | null;
  idempotencyKey?: string | null;
  externalReference?: string | null;
  confirmedByUid?: string | null;
  createdAt?: string | null;
  confirmedAt?: string | null;
  verificationStatus?: string | null;
  verificationPayload?: unknown;
  verifiedAt?: string | null;
}

export type QuoteCheckPhase = 'PRE_PAYMENT' | 'POST_PAYMENT' | 'FINAL_PLACEMENT' | 'REPLACEMENT';
export type QuoteCheckStatus = 'MATCHED' | 'REVIEW_REQUIRED' | 'OUT_OF_STOCK' | 'RECONCILIATION_REQUIRED' | 'ABSORBED' | 'CANCELLED';

export interface QuoteCheckRecord {
  id: string;
  organisationId: string;
  orderId: string;
  paymentId?: string | null;
  phase: QuoteCheckPhase;
  status: QuoteCheckStatus;
  baselineQuoteCheckId?: string | null;
  basketFingerprint: string;
  quoteFingerprint: string;
  patientTotalPence: number;
  wholesaleTotalPence: number;
  shippingPence: number;
  taxPence: number;
  rawQuote: unknown;
  comparison?: unknown;
  decidedByUid?: string | null;
  createdAt: string;
  decidedAt?: string | null;
}

export interface PaymentAllocationRecord {
  id: string;
  organisationId: string;
  paymentId: string;
  orderId: string;
  sourceOrderId?: string | null;
  amountPence: number;
  status: 'ACTIVE' | 'TRANSFERRED' | 'REFUNDED' | 'RELEASED';
  version: number;
  createdAt: string;
  updatedAt: string;
  transferredAt?: string | null;
}

export interface PaymentRepositoryPort {
  findPaymentByWorldpayCode(worldpayOrderCode: string): Promise<PaymentRecord | null>;
  findPaymentByReceiptHash(receiptHash: string): Promise<PaymentRecord | null>;
  findPaymentByOrderId(orderId: string, organisationId: string): Promise<PaymentRecord | null>;
  listPaymentsByOrderId(orderId: string, organisationId: string): Promise<PaymentRecord[]>;
  listTenantPayments(organisationId: string, limit?: number): Promise<PaymentRecord[]>;
  listPendingWorldpayPayments(limit?: number): Promise<PaymentRecord[]>;
  cancelPendingPaymentsForOrder(orderId: string, organisationId: string, keepId?: string | null): Promise<void>;
  createPayment(data: {
    organisationId: string;
    orderId: string;
    patientId: string;
    status: 'PENDING' | 'PAID' | 'FAILED' | 'CANCELLED';
    amountPence: number;
    currency: string;
    route: 'MANUAL' | 'WORLDPAY';
    transactionReference?: string | null;
    receiptHash?: string | null;
    hostedPaymentUrl?: string | null;
    linkExpiresAt?: string | null;
    manualTender?: string | null;
    manualReference?: string | null;
    baselineQuoteCheckId?: string | null;
    basketFingerprint?: string | null;
  }): Promise<{ id?: string }>;
  updatePaymentStatus(id: string, status: 'PAID' | 'FAILED' | 'CANCELLED', orderId: string, receiptHash?: string | null): Promise<void>;
  updatePaymentOutcome(data: {
    id: string;
    orderId: string;
    status: PaymentSqlStatus;
    receiptHash?: string | null;
    providerPayload?: unknown;
    markOrderPaid?: boolean;
    updateOrderPaymentStatus?: boolean;
  }): Promise<void>;
  createRefund(data: {
    organisationId: string;
    orderId: string;
    paymentId: string;
    amountPence: number;
    currency: string;
    cause: string;
    route: 'MANUAL' | 'WORLDPAY';
    status?: 'PENDING_CONFIRMATION' | 'COMPLETED' | 'FAILED';
    idempotencyKey: string;
    confirmedByUid?: string | null;
  }): Promise<RefundRecord>;
  listRefundsByOrderId(orderId: string, organisationId: string): Promise<RefundRecord[]>;
  listTenantRefunds(organisationId: string, limit?: number): Promise<RefundRecord[]>;
  findRefundByIdempotencyKey(idempotencyKey: string, organisationId: string): Promise<RefundRecord | null>;
  confirmRefund(data: {
    id: string;
    externalReference: string;
    confirmedByUid: string;
  }): Promise<void>;
  markRefundVerification(data: {
    id: string;
    status: 'VERIFICATION_PENDING' | 'RECONCILIATION_REQUIRED' | 'COMPLETED' | 'FAILED';
    externalReference?: string | null;
    confirmedByUid?: string | null;
    verificationStatus: string;
    verificationPayload?: unknown;
  }): Promise<void>;
  completeRefundAndConsumeAllocation(data: {
    refundId: string;
    organisationId: string;
    orderId: string;
    paymentId: string;
    amountPence: number;
    externalReference: string;
    confirmedByUid: string;
    verificationStatus: string;
    verificationPayload?: unknown;
  }): Promise<PaymentAllocationRecord>;
  createQuoteCheck(data: Omit<QuoteCheckRecord, 'id' | 'createdAt' | 'decidedAt'> & { decidedAt?: string | null }): Promise<QuoteCheckRecord>;
  findQuoteCheckById(id: string, organisationId: string): Promise<QuoteCheckRecord | null>;
  listQuoteChecksByOrder(orderId: string, organisationId: string): Promise<QuoteCheckRecord[]>;
  listTenantQuoteChecks(organisationId: string, limit?: number): Promise<QuoteCheckRecord[]>;
  bindPaymentQuote(data: { paymentId: string; baselineQuoteCheckId: string; basketFingerprint: string }): Promise<void>;
  createPaymentAllocation(data: {
    organisationId: string;
    paymentId: string;
    orderId: string;
    sourceOrderId?: string | null;
    amountPence: number;
  }): Promise<PaymentAllocationRecord>;
  listPaymentAllocations(paymentId: string, organisationId: string): Promise<PaymentAllocationRecord[]>;
  listPaymentAllocationsByOrder(orderId: string, organisationId: string): Promise<PaymentAllocationRecord[]>;
  listTenantPaymentAllocations(organisationId: string, limit?: number): Promise<PaymentAllocationRecord[]>;
  transferPaymentAllocation(data: {
    allocationId: string;
    organisationId: string;
    fromOrderId: string;
    toOrderId: string;
    amountPence: number;
  }): Promise<PaymentAllocationRecord>;
  refundPaymentAllocation(data: {
    organisationId: string;
    paymentId: string;
    orderId: string;
    amountPence: number;
  }): Promise<PaymentAllocationRecord>;
}
