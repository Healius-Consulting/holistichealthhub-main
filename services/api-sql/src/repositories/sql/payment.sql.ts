import { dataConnect } from '../../bootstrap/firebase.js';
import { pendingPaymentsToCancel, selectLivePayment } from '../../application/payments/live-payment.js';
import { refundedAllocationState } from '../../application/payments/payment-allocation.js';
import type { PaymentRecord, PaymentRepositoryPort, PaymentSqlStatus, RefundRecord } from '../ports/payment.port.js';
import type { PaymentAllocationRecord, QuoteCheckRecord } from '../ports/payment.port.js';

const PAYMENT_FIELDS = `
  id
  organisationId
  orderId
  patientId
  status
  amountPence
  currency
  route
  receiptHash
  transactionReference
  providerPaymentId
  hostedPaymentUrl
  linkExpiresAt
  providerPayload
  manualTender
  manualReference
  baselineQuoteCheckId
  basketFingerprint
  version
  createdAt
  updatedAt
`;

const GET_PAYMENT_BY_WORLDPAY_CODE_GQL = `
  query GetPaymentByWorldpayCode($transactionReference: String!) {
    payments(where: { transactionReference: { eq: $transactionReference } }, limit: 1) {
      ${PAYMENT_FIELDS}
    }
  }
`;

const GET_PAYMENT_BY_RECEIPT_HASH_GQL = `
  query GetPaymentByReceiptHash($receiptHash: String!) {
    payments(where: { receiptHash: { eq: $receiptHash } }, limit: 1) {
      ${PAYMENT_FIELDS}
    }
  }
`;

const GET_PAYMENT_BY_ORDER_ID_GQL = `
  query GetPaymentByOrderId($orderId: UUID!, $organisationId: UUID!) {
    payments(where: { orderId: { eq: $orderId }, organisationId: { eq: $organisationId } }, limit: 50) {
      ${PAYMENT_FIELDS}
    }
  }
`;

const LIST_TENANT_PAYMENTS_GQL = `
  query ListTenantPayments($organisationId: UUID!, $limit: Int!) {
    payments(where: { organisationId: { eq: $organisationId } }, limit: $limit) {
      ${PAYMENT_FIELDS}
    }
  }
`;

const LIST_PENDING_WORLDPAY_PAYMENTS_GQL = `
  query ListPendingWorldpayPayments($limit: Int!) {
    payments(
      where: {
        route: { eq: WORLDPAY }
        status: { in: [PENDING, REFUND_REQUIRED] }
      }
      limit: $limit
    ) {
      ${PAYMENT_FIELDS}
    }
  }
`;

const LIST_RECENT_RETIRED_WORLDPAY_PAYMENTS_GQL = `
  query ListRecentRetiredWorldpayPayments($limit: Int!, $retiredAfter: Timestamp!) {
    payments(
      where: {
        route: { eq: WORLDPAY }
        status: { eq: CANCELLED }
        updatedAt: { gt: $retiredAfter }
      }
      limit: $limit
    ) {
      ${PAYMENT_FIELDS}
    }
  }
`;

const CREATE_PAYMENT_GQL = `
  mutation CreatePayment(
    $organisationId: UUID!
    $orderId: UUID!
    $patientId: UUID!
    $status: PaymentStatus!
    $amountPence: Int64!
    $currency: String!
    $route: PaymentRoute!
    $transactionReference: String
    $providerPaymentId: String
    $receiptHash: String
    $hostedPaymentUrl: String
    $linkExpiresAt: Timestamp
    $manualTender: String
    $manualReference: String
    $baselineQuoteCheckId: UUID
    $basketFingerprint: String
  ) {
    payment_insert(data: {
      organisationId: $organisationId
      orderId: $orderId
      patientId: $patientId
      status: $status
      amountPence: $amountPence
      currency: $currency
      route: $route
      transactionReference: $transactionReference
      providerPaymentId: $providerPaymentId
      receiptHash: $receiptHash
      hostedPaymentUrl: $hostedPaymentUrl
      linkExpiresAt: $linkExpiresAt
      manualTender: $manualTender
      manualReference: $manualReference
      baselineQuoteCheckId: $baselineQuoteCheckId
      basketFingerprint: $basketFingerprint
      version: 1
    })
  }
`;

const UPDATE_PAYMENT_STATUS_GQL = `
  mutation UpdatePaymentStatus(
    $id: UUID!
    $status: PaymentStatus!
    $receiptHash: String
    $orderId: UUID!
  ) {
    payment_update(
      key: { id: $id }
      data: {
        status: $status
        receiptHash: $receiptHash
        paidAt_expr: "request.time"
        updatedAt_expr: "request.time"
      }
    )
    order_update(
      key: { id: $orderId }
      data: {
        status: PROCESSING
        paymentStatus: $status
        paidAt_expr: "request.time"
        updatedAt_expr: "request.time"
      }
    )
  }
`;

const CANCEL_PAYMENT_GQL = `
  mutation CancelPayment($id: UUID!, $status: PaymentStatus!) {
    payment_update(
      key: { id: $id }
      data: {
        status: $status
        updatedAt_expr: "request.time"
      }
    )
  }
`;

const UPDATE_PAYMENT_OUTCOME_GQL = `
  mutation UpdatePaymentOutcome(
    $id: UUID!
    $status: PaymentStatus!
    $receiptHash: String
    $providerPayload: Any
  ) {
    payment_update(
      key: { id: $id }
      data: {
        status: $status
        receiptHash: $receiptHash
        providerPayload: $providerPayload
        updatedAt_expr: "request.time"
      }
    )
  }
`;

const UPDATE_PAYMENT_PROVIDER_GQL = `
  mutation UpdatePaymentProvider($id: UUID!, $providerPaymentId: String, $providerPayload: Any) {
    payment_update(
      key: { id: $id }
      data: {
        providerPaymentId: $providerPaymentId
        providerPayload: $providerPayload
        updatedAt_expr: "request.time"
      }
    )
  }
`;

const UPDATE_ORDER_PAYMENT_STATUS_GQL = `
  mutation UpdateOrderPaymentStatus($id: UUID!, $paymentStatus: PaymentStatus!) {
    order_update(
      key: { id: $id }
      data: {
        paymentStatus: $paymentStatus
        updatedAt_expr: "request.time"
      }
    )
  }
`;

const REFUND_FIELDS = `
  id organisationId orderId paymentId status amountPence currency cause route
  idempotencyKey externalReference verificationStatus verificationPayload
  confirmedByUid createdAt confirmedAt verifiedAt
`;

const CREATE_REFUND_GQL = `
  mutation CreateRefund(
    $organisationId: UUID!
    $orderId: UUID!
    $paymentId: UUID!
    $amountPence: Int64!
    $currency: String!
    $cause: String!
    $route: PaymentRoute!
    $status: RefundStatus!
    $idempotencyKey: String!
  ) {
    refund_insert(data: {
      organisationId: $organisationId
      orderId: $orderId
      paymentId: $paymentId
      amountPence: $amountPence
      currency: $currency
      cause: $cause
      route: $route
      status: $status
      idempotencyKey: $idempotencyKey
    })
  }
`;

const LIST_REFUNDS_BY_ORDER_GQL = `
  query ListRefundsByOrder($orderId: UUID!, $organisationId: UUID!) {
    refunds(where: { orderId: { eq: $orderId }, organisationId: { eq: $organisationId } }, limit: 20) {
      ${REFUND_FIELDS}
    }
  }
`;

const LIST_TENANT_REFUNDS_GQL = `
  query ListTenantRefunds($organisationId: UUID!, $limit: Int!) {
    refunds(where: { organisationId: { eq: $organisationId } }, limit: $limit) {
      ${REFUND_FIELDS}
    }
  }
`;

const FIND_REFUND_BY_KEY_GQL = `
  query FindRefundByIdempotencyKey($idempotencyKey: String!, $organisationId: UUID!) {
    refunds(where: { idempotencyKey: { eq: $idempotencyKey }, organisationId: { eq: $organisationId } }, limit: 1) {
      ${REFUND_FIELDS}
    }
  }
`;

const CONFIRM_REFUND_GQL = `
  mutation ConfirmRefund($id: UUID!, $externalReference: String!, $confirmedByUid: String!) {
    refund_update(
      key: { id: $id }
      data: {
        status: COMPLETED
        externalReference: $externalReference
        confirmedByUid: $confirmedByUid
        confirmedAt_expr: "request.time"
      }
    )
  }
`;

const MARK_REFUND_VERIFICATION_GQL = `
  mutation MarkRefundVerification(
    $id: UUID!
    $status: RefundStatus!
    $externalReference: String
    $confirmedByUid: String
    $verificationStatus: String!
    $verificationPayload: Any
  ) {
    refund_update(
      key: { id: $id }
      data: {
        status: $status
        externalReference: $externalReference
        confirmedByUid: $confirmedByUid
        verificationStatus: $verificationStatus
        verificationPayload: $verificationPayload
        verifiedAt_expr: "request.time"
      }
    )
  }
`;

const COMPLETE_REFUND_VERIFICATION_GQL = `
  mutation CompleteRefundVerification(
    $id: UUID!
    $externalReference: String
    $confirmedByUid: String
    $verificationStatus: String!
    $verificationPayload: Any
  ) {
    refund_update(
      key: { id: $id }
      data: {
        status: COMPLETED
        externalReference: $externalReference
        confirmedByUid: $confirmedByUid
        verificationStatus: $verificationStatus
        verificationPayload: $verificationPayload
        verifiedAt_expr: "request.time"
        confirmedAt_expr: "request.time"
      }
    )
  }
`;

const QUOTE_CHECK_FIELDS = `
  id organisationId orderId paymentId phase status baselineQuoteCheckId basketFingerprint
  quoteFingerprint patientTotalPence wholesaleTotalPence shippingPence taxPence rawQuote
  comparison decidedByUid createdAt decidedAt
`;

const CREATE_QUOTE_CHECK_GQL = `
  mutation CreateQuoteCheck(
    $organisationId: UUID!
    $orderId: UUID!
    $paymentId: UUID
    $phase: QuoteCheckPhase!
    $status: QuoteCheckStatus!
    $baselineQuoteCheckId: UUID
    $basketFingerprint: String!
    $quoteFingerprint: String!
    $patientTotalPence: Int64!
    $wholesaleTotalPence: Int64!
    $shippingPence: Int64!
    $taxPence: Int64!
    $rawQuote: Any!
    $comparison: Any
    $decidedByUid: String
    $decidedAt: Timestamp
  ) {
    quoteCheck_insert(data: {
      organisationId: $organisationId
      orderId: $orderId
      paymentId: $paymentId
      phase: $phase
      status: $status
      baselineQuoteCheckId: $baselineQuoteCheckId
      basketFingerprint: $basketFingerprint
      quoteFingerprint: $quoteFingerprint
      patientTotalPence: $patientTotalPence
      wholesaleTotalPence: $wholesaleTotalPence
      shippingPence: $shippingPence
      taxPence: $taxPence
      rawQuote: $rawQuote
      comparison: $comparison
      decidedByUid: $decidedByUid
      decidedAt: $decidedAt
    })
  }
`;

const FIND_QUOTE_CHECK_GQL = `
  query FindQuoteCheck($id: UUID!, $organisationId: UUID!) {
    quoteChecks(where: { id: { eq: $id }, organisationId: { eq: $organisationId } }, limit: 1) {
      ${QUOTE_CHECK_FIELDS}
    }
  }
`;

const LIST_QUOTE_CHECKS_GQL = `
  query ListQuoteChecks($orderId: UUID!, $organisationId: UUID!) {
    quoteChecks(where: { orderId: { eq: $orderId }, organisationId: { eq: $organisationId } }, limit: 100) {
      ${QUOTE_CHECK_FIELDS}
    }
  }
`;

const LIST_TENANT_QUOTE_CHECKS_GQL = `
  query ListTenantQuoteChecks($organisationId: UUID!, $limit: Int!) {
    quoteChecks(where: { organisationId: { eq: $organisationId } }, limit: $limit) {
      ${QUOTE_CHECK_FIELDS}
    }
  }
`;

const BIND_PAYMENT_QUOTE_GQL = `
  mutation BindPaymentQuote($id: UUID!, $baselineQuoteCheckId: UUID!, $basketFingerprint: String!) {
    payment_update(key: { id: $id }, data: {
      baselineQuoteCheckId: $baselineQuoteCheckId
      basketFingerprint: $basketFingerprint
      updatedAt_expr: "request.time"
    })
  }
`;

const ALLOCATION_FIELDS = `
  id organisationId paymentId orderId sourceOrderId amountPence status version createdAt updatedAt transferredAt
`;

const LIST_PAYMENT_ALLOCATIONS_GQL = `
  query ListPaymentAllocations($paymentId: UUID!, $organisationId: UUID!) {
    paymentAllocations(where: { paymentId: { eq: $paymentId }, organisationId: { eq: $organisationId } }, limit: 100) {
      ${ALLOCATION_FIELDS}
    }
  }
`;

const LIST_ORDER_PAYMENT_ALLOCATIONS_GQL = `
  query ListOrderPaymentAllocations($orderId: UUID!, $organisationId: UUID!) {
    paymentAllocations(where: { orderId: { eq: $orderId }, organisationId: { eq: $organisationId } }, limit: 100) {
      ${ALLOCATION_FIELDS}
    }
  }
`;

const LIST_TENANT_PAYMENT_ALLOCATIONS_GQL = `
  query ListTenantPaymentAllocations($organisationId: UUID!, $limit: Int!) {
    paymentAllocations(where: { organisationId: { eq: $organisationId } }, limit: $limit) {
      ${ALLOCATION_FIELDS}
    }
  }
`;

const CREATE_PAYMENT_ALLOCATION_GQL = `
  mutation CreatePaymentAllocation(
    $organisationId: UUID!
    $paymentId: UUID!
    $orderId: UUID!
    $sourceOrderId: UUID
    $amountPence: Int64!
  ) {
    paymentAllocation_insert(data: {
      organisationId: $organisationId
      paymentId: $paymentId
      orderId: $orderId
      sourceOrderId: $sourceOrderId
      amountPence: $amountPence
      status: ACTIVE
      version: 1
    })
  }
`;

const TRANSFER_PAYMENT_ALLOCATION_GQL = `
  mutation TransferPaymentAllocation(
    $allocationId: UUID!
    $sourceAmountPence: Int64!
    $sourceStatus: PaymentAllocationStatus!
    $sourceVersion: Int!
    $organisationId: UUID!
    $paymentId: UUID!
    $toOrderId: UUID!
    $fromOrderId: UUID!
    $amountPence: Int64!
  ) {
    paymentAllocation_update(key: { id: $allocationId }, data: {
      amountPence: $sourceAmountPence
      status: $sourceStatus
      version: $sourceVersion
      updatedAt_expr: "request.time"
      transferredAt_expr: "request.time"
    })
    paymentAllocation_insert(data: {
      organisationId: $organisationId
      paymentId: $paymentId
      orderId: $toOrderId
      sourceOrderId: $fromOrderId
      amountPence: $amountPence
      status: ACTIVE
      version: 1
    })
  }
`;

const REFUND_PAYMENT_ALLOCATION_GQL = `
  mutation RefundPaymentAllocation(
    $allocationId: UUID!
    $amountPence: Int64!
    $status: PaymentAllocationStatus!
    $version: Int!
  ) {
    paymentAllocation_update(key: { id: $allocationId }, data: {
      amountPence: $amountPence
      status: $status
      version: $version
      updatedAt_expr: "request.time"
    })
  }
`;

const COMPLETE_REFUND_AND_ALLOCATION_GQL = `
  mutation CompleteRefundAndAllocation(
    $refundId: UUID!
    $externalReference: String!
    $confirmedByUid: String!
    $verificationStatus: String!
    $verificationPayload: Any
    $allocationId: UUID!
    $amountPence: Int64!
    $allocationStatus: PaymentAllocationStatus!
    $version: Int!
  ) {
    refund_update(key: { id: $refundId }, data: {
      status: COMPLETED
      externalReference: $externalReference
      confirmedByUid: $confirmedByUid
      verificationStatus: $verificationStatus
      verificationPayload: $verificationPayload
      verifiedAt_expr: "request.time"
      confirmedAt_expr: "request.time"
    })
    paymentAllocation_update(key: { id: $allocationId }, data: {
      amountPence: $amountPence
      status: $allocationStatus
      version: $version
      updatedAt_expr: "request.time"
    })
  }
`;

export class SqlPaymentRepository implements PaymentRepositoryPort {
  async findPaymentByWorldpayCode(worldpayOrderCode: string): Promise<PaymentRecord | null> {
    const result = await dataConnect.executeGraphql<{ payments: PaymentRecord[] }, any>(
      GET_PAYMENT_BY_WORLDPAY_CODE_GQL,
      { variables: { transactionReference: worldpayOrderCode } }
    );
    return result.data.payments?.[0] ?? null;
  }

  async findPaymentByReceiptHash(receiptHash: string): Promise<PaymentRecord | null> {
    const result = await dataConnect.executeGraphql<{ payments: PaymentRecord[] }, any>(
      GET_PAYMENT_BY_RECEIPT_HASH_GQL,
      { variables: { receiptHash } }
    );
    return result.data.payments?.[0] ?? null;
  }

  async listPaymentsByOrderId(orderId: string, organisationId: string): Promise<PaymentRecord[]> {
    const result = await dataConnect.executeGraphql<{ payments: PaymentRecord[] }, any>(
      GET_PAYMENT_BY_ORDER_ID_GQL,
      { variables: { orderId, organisationId } }
    );
    return result.data.payments ?? [];
  }

  async findPaymentByOrderId(orderId: string, organisationId: string): Promise<PaymentRecord | null> {
    return selectLivePayment(await this.listPaymentsByOrderId(orderId, organisationId));
  }

  async cancelPendingPaymentsForOrder(orderId: string, organisationId: string, keepId?: string | null): Promise<void> {
    const pending = pendingPaymentsToCancel(await this.listPaymentsByOrderId(orderId, organisationId), keepId);
    for (const payment of pending) {
      await dataConnect.executeGraphql(CANCEL_PAYMENT_GQL, {
        variables: { id: payment.id, status: 'CANCELLED' },
      });
    }
  }

  async listTenantPayments(organisationId: string, limit = 200): Promise<PaymentRecord[]> {
    const result = await dataConnect.executeGraphql<{ payments: PaymentRecord[] }, any>(
      LIST_TENANT_PAYMENTS_GQL,
      { variables: { organisationId, limit } }
    );
    return result.data.payments ?? [];
  }

  async listPendingWorldpayPayments(limit = 200): Promise<PaymentRecord[]> {
    const [pending, retired] = await Promise.all([
      dataConnect.executeGraphql<{ payments: PaymentRecord[] }, any>(
        LIST_PENDING_WORLDPAY_PAYMENTS_GQL,
        { variables: { limit } },
      ),
      dataConnect.executeGraphql<{ payments: PaymentRecord[] }, any>(
        LIST_RECENT_RETIRED_WORLDPAY_PAYMENTS_GQL,
        { variables: { limit, retiredAfter: new Date(Date.now() - 30 * 24 * 60 * 60 * 1_000).toISOString() } },
      ),
    ]);
    const byId = new Map([...pending.data.payments ?? [], ...retired.data.payments ?? []].map(row => [row.id, row]));
    return [...byId.values()].slice(0, limit);
  }

  async createPayment(data: {
    organisationId: string;
    orderId: string;
    patientId: string;
    status: 'PENDING' | 'PAID' | 'FAILED' | 'CANCELLED';
    amountPence: number;
    currency: string;
    route: 'MANUAL' | 'WORLDPAY';
    transactionReference?: string | null;
    providerPaymentId?: string | null;
    receiptHash?: string | null;
    hostedPaymentUrl?: string | null;
    linkExpiresAt?: string | null;
    manualTender?: string | null;
    manualReference?: string | null;
    baselineQuoteCheckId?: string | null;
    basketFingerprint?: string | null;
  }): Promise<{ id?: string }> {
    if (data.status === 'PENDING' || data.status === 'PAID') {
      await this.cancelPendingPaymentsForOrder(data.orderId, data.organisationId);
    }
    const result = await dataConnect.executeGraphql<{ payment_insert: { id: string } }, any>(
      CREATE_PAYMENT_GQL,
      {
        variables: {
          organisationId: data.organisationId,
          orderId: data.orderId,
          patientId: data.patientId,
          status: data.status,
          amountPence: data.amountPence,
          currency: data.currency,
          route: data.route,
          transactionReference: data.transactionReference ?? null,
          providerPaymentId: data.providerPaymentId ?? null,
          receiptHash: data.receiptHash ?? null,
          hostedPaymentUrl: data.hostedPaymentUrl ?? null,
          linkExpiresAt: data.linkExpiresAt ?? null,
          manualTender: data.manualTender ?? null,
          manualReference: data.manualReference ?? null,
          baselineQuoteCheckId: data.baselineQuoteCheckId ?? null,
          basketFingerprint: data.basketFingerprint ?? null,
        },
      }
    );
    return { id: result.data.payment_insert?.id };
  }

  async updatePaymentStatus(id: string, status: 'PAID' | 'FAILED' | 'CANCELLED', orderId: string, receiptHash?: string | null): Promise<void> {
    if (status === 'PAID') {
      await dataConnect.executeGraphql<any, any>(UPDATE_PAYMENT_STATUS_GQL, {
        variables: { id, status, orderId, receiptHash: receiptHash ?? null },
      });
      return;
    }
    await dataConnect.executeGraphql(CANCEL_PAYMENT_GQL, { variables: { id, status } });
  }

  async updatePaymentOutcome(data: {
    id: string;
    orderId: string;
    status: PaymentSqlStatus;
    receiptHash?: string | null;
    providerPayload?: unknown;
    markOrderPaid?: boolean;
    updateOrderPaymentStatus?: boolean;
  }): Promise<void> {
    if (data.markOrderPaid || (data.status === 'PAID' && data.updateOrderPaymentStatus !== false)) {
      await this.updatePaymentStatus(data.id, 'PAID', data.orderId, data.receiptHash);
      if (data.providerPayload !== undefined) {
        await dataConnect.executeGraphql<any, any>(UPDATE_PAYMENT_OUTCOME_GQL, {
          variables: {
            id: data.id,
            status: 'PAID',
            receiptHash: data.receiptHash ?? null,
            providerPayload: data.providerPayload ?? null,
          },
        });
      }
      return;
    }
    await dataConnect.executeGraphql<any, any>(UPDATE_PAYMENT_OUTCOME_GQL, {
      variables: {
        id: data.id,
        status: data.status,
        receiptHash: data.receiptHash ?? null,
        providerPayload: data.providerPayload ?? null,
      },
    });
    if (data.updateOrderPaymentStatus !== false) {
      await dataConnect.executeGraphql<any, any>(UPDATE_ORDER_PAYMENT_STATUS_GQL, {
        variables: { id: data.orderId, paymentStatus: data.status },
      });
    }
  }

  async updatePaymentProvider(data: { id: string; providerPaymentId?: string | null; providerPayload?: unknown }): Promise<void> {
    await dataConnect.executeGraphql(UPDATE_PAYMENT_PROVIDER_GQL, {
      variables: {
        id: data.id,
        providerPaymentId: data.providerPaymentId ?? null,
        providerPayload: data.providerPayload ?? null,
      },
    });
  }

  async createRefund(data: {
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
  }): Promise<RefundRecord> {
    const existing = await this.findRefundByIdempotencyKey(data.idempotencyKey, data.organisationId);
    if (existing) return existing;
    await dataConnect.executeGraphql<{ refund_insert: { id: string } }, any>(
      CREATE_REFUND_GQL,
      {
        variables: {
          organisationId: data.organisationId,
          orderId: data.orderId,
          paymentId: data.paymentId,
          amountPence: data.amountPence,
          currency: data.currency,
          cause: data.cause,
          route: data.route,
          status: data.status ?? 'PENDING_CONFIRMATION',
          idempotencyKey: data.idempotencyKey,
        },
      }
    );
    const saved = await this.findRefundByIdempotencyKey(data.idempotencyKey, data.organisationId);
    if (!saved) throw new Error('Refund could not be stored.');
    return saved;
  }

  async listRefundsByOrderId(orderId: string, organisationId: string): Promise<RefundRecord[]> {
    const result = await dataConnect.executeGraphql<{ refunds: RefundRecord[] }, any>(
      LIST_REFUNDS_BY_ORDER_GQL,
      { variables: { orderId, organisationId } },
    );
    return result.data.refunds ?? [];
  }

  async listTenantRefunds(organisationId: string, limit = 500): Promise<RefundRecord[]> {
    const result = await dataConnect.executeGraphql<{ refunds: RefundRecord[] }, any>(
      LIST_TENANT_REFUNDS_GQL,
      { variables: { organisationId, limit } },
    );
    return result.data.refunds ?? [];
  }

  async findRefundByIdempotencyKey(idempotencyKey: string, organisationId: string): Promise<RefundRecord | null> {
    const result = await dataConnect.executeGraphql<{ refunds: RefundRecord[] }, any>(
      FIND_REFUND_BY_KEY_GQL,
      { variables: { idempotencyKey, organisationId } },
    );
    return result.data.refunds?.[0] ?? null;
  }

  async confirmRefund(data: {
    id: string;
    externalReference: string;
    confirmedByUid: string;
  }): Promise<void> {
    await dataConnect.executeGraphql(CONFIRM_REFUND_GQL, {
      variables: {
        id: data.id,
        externalReference: data.externalReference,
        confirmedByUid: data.confirmedByUid,
      },
    });
  }

  async markRefundVerification(data: {
    id: string;
    status: 'PENDING_CONFIRMATION' | 'VERIFICATION_PENDING' | 'RECONCILIATION_REQUIRED' | 'COMPLETED' | 'FAILED';
    externalReference?: string | null;
    confirmedByUid?: string | null;
    verificationStatus: string;
    verificationPayload?: unknown;
  }): Promise<void> {
    const mutation = data.status === 'COMPLETED' ? COMPLETE_REFUND_VERIFICATION_GQL : MARK_REFUND_VERIFICATION_GQL;
    await dataConnect.executeGraphql(mutation, {
      variables: {
        id: data.id,
        status: data.status,
        externalReference: data.externalReference ?? null,
        confirmedByUid: data.confirmedByUid ?? null,
        verificationStatus: data.verificationStatus,
        verificationPayload: data.verificationPayload ?? null,
      },
    });
  }

  async createQuoteCheck(data: Omit<QuoteCheckRecord, 'id' | 'createdAt' | 'decidedAt'> & { decidedAt?: string | null }): Promise<QuoteCheckRecord> {
    const inserted = await dataConnect.executeGraphql<{ quoteCheck_insert: { id: string } }, any>(CREATE_QUOTE_CHECK_GQL, {
      variables: {
        ...data,
        paymentId: data.paymentId ?? null,
        baselineQuoteCheckId: data.baselineQuoteCheckId ?? null,
        comparison: data.comparison ?? null,
        decidedByUid: data.decidedByUid ?? null,
        decidedAt: data.decidedAt ?? null,
      },
    });
    const saved = await this.findQuoteCheckById(inserted.data.quoteCheck_insert.id, data.organisationId);
    if (!saved) throw new Error('Quote check could not be stored.');
    return saved;
  }

  async findQuoteCheckById(id: string, organisationId: string): Promise<QuoteCheckRecord | null> {
    const result = await dataConnect.executeGraphql<{ quoteChecks: QuoteCheckRecord[] }, any>(FIND_QUOTE_CHECK_GQL, {
      variables: { id, organisationId },
    });
    return result.data.quoteChecks?.[0] ?? null;
  }

  async listQuoteChecksByOrder(orderId: string, organisationId: string): Promise<QuoteCheckRecord[]> {
    const result = await dataConnect.executeGraphql<{ quoteChecks: QuoteCheckRecord[] }, any>(LIST_QUOTE_CHECKS_GQL, {
      variables: { orderId, organisationId },
    });
    return (result.data.quoteChecks ?? []).sort((left, right) => String(left.createdAt).localeCompare(String(right.createdAt)));
  }

  async listTenantQuoteChecks(organisationId: string, limit = 2_000): Promise<QuoteCheckRecord[]> {
    const result = await dataConnect.executeGraphql<{ quoteChecks: QuoteCheckRecord[] }, any>(LIST_TENANT_QUOTE_CHECKS_GQL, {
      variables: { organisationId, limit },
    });
    return (result.data.quoteChecks ?? []).sort((left, right) => String(left.createdAt).localeCompare(String(right.createdAt)));
  }

  async bindPaymentQuote(data: { paymentId: string; baselineQuoteCheckId: string; basketFingerprint: string }): Promise<void> {
    await dataConnect.executeGraphql(BIND_PAYMENT_QUOTE_GQL, {
      variables: { id: data.paymentId, baselineQuoteCheckId: data.baselineQuoteCheckId, basketFingerprint: data.basketFingerprint },
    });
  }

  async createPaymentAllocation(data: {
    organisationId: string;
    paymentId: string;
    orderId: string;
    sourceOrderId?: string | null;
    amountPence: number;
  }): Promise<PaymentAllocationRecord> {
    const allocations = await this.listPaymentAllocations(data.paymentId, data.organisationId);
    const existing = allocations.find(row => row.orderId === data.orderId && row.status === 'ACTIVE');
    if (existing) return existing;
    const payment = (await this.listTenantPayments(data.organisationId, 1000)).find(row => row.id === data.paymentId);
    if (!payment) throw new Error('Payment not found for allocation.');
    const allocated = allocations.filter(row => row.status === 'ACTIVE').reduce((sum, row) => sum + Number(row.amountPence), 0);
    if (data.amountPence <= 0 || allocated + data.amountPence > Number(payment.amountPence)) {
      throw new Error('Payment allocation exceeds the settled payment.');
    }
    const result = await dataConnect.executeGraphql<{ paymentAllocation_insert: { id: string } }, any>(CREATE_PAYMENT_ALLOCATION_GQL, {
      variables: { ...data, sourceOrderId: data.sourceOrderId ?? null },
    });
    const saved = (await this.listPaymentAllocations(data.paymentId, data.organisationId)).find(row => row.id === result.data.paymentAllocation_insert.id);
    if (!saved) throw new Error('Payment allocation could not be stored.');
    return saved;
  }

  async listPaymentAllocations(paymentId: string, organisationId: string): Promise<PaymentAllocationRecord[]> {
    const result = await dataConnect.executeGraphql<{ paymentAllocations: PaymentAllocationRecord[] }, any>(LIST_PAYMENT_ALLOCATIONS_GQL, {
      variables: { paymentId, organisationId },
    });
    return result.data.paymentAllocations ?? [];
  }

  async listPaymentAllocationsByOrder(orderId: string, organisationId: string): Promise<PaymentAllocationRecord[]> {
    const result = await dataConnect.executeGraphql<{ paymentAllocations: PaymentAllocationRecord[] }, any>(LIST_ORDER_PAYMENT_ALLOCATIONS_GQL, {
      variables: { orderId, organisationId },
    });
    return result.data.paymentAllocations ?? [];
  }

  async listTenantPaymentAllocations(organisationId: string, limit = 2_000): Promise<PaymentAllocationRecord[]> {
    const result = await dataConnect.executeGraphql<{ paymentAllocations: PaymentAllocationRecord[] }, any>(LIST_TENANT_PAYMENT_ALLOCATIONS_GQL, {
      variables: { organisationId, limit },
    });
    return result.data.paymentAllocations ?? [];
  }

  async transferPaymentAllocation(data: {
    allocationId: string;
    organisationId: string;
    fromOrderId: string;
    toOrderId: string;
    amountPence: number;
  }): Promise<PaymentAllocationRecord> {
    const tenantPayments = await this.listTenantPayments(data.organisationId, 1000);
    let source: PaymentAllocationRecord | undefined;
    let paymentId = '';
    for (const payment of tenantPayments) {
      const allocations = await this.listPaymentAllocations(payment.id, data.organisationId);
      source = allocations.find(row => row.id === data.allocationId);
      if (source) { paymentId = payment.id; break; }
    }
    if (!source || source.status !== 'ACTIVE' || source.orderId !== data.fromOrderId) throw new Error('Active source payment allocation not found.');
    if (data.amountPence <= 0 || data.amountPence > Number(source.amountPence)) throw new Error('Invalid payment allocation transfer amount.');
    const remaining = Number(source.amountPence) - data.amountPence;
    const result = await dataConnect.executeGraphql<{ paymentAllocation_insert: { id: string } }, any>(TRANSFER_PAYMENT_ALLOCATION_GQL, {
      variables: {
        allocationId: source.id,
        sourceAmountPence: remaining,
        sourceStatus: remaining === 0 ? 'TRANSFERRED' : 'ACTIVE',
        sourceVersion: Number(source.version) + 1,
        organisationId: data.organisationId,
        paymentId,
        toOrderId: data.toOrderId,
        fromOrderId: data.fromOrderId,
        amountPence: data.amountPence,
      },
    });
    const saved = (await this.listPaymentAllocations(paymentId, data.organisationId)).find(row => row.id === result.data.paymentAllocation_insert.id);
    if (!saved) throw new Error('Transferred payment allocation could not be stored.');
    return saved;
  }

  async refundPaymentAllocation(data: {
    organisationId: string;
    paymentId: string;
    orderId: string;
    amountPence: number;
  }): Promise<PaymentAllocationRecord> {
    const allocations = await this.listPaymentAllocations(data.paymentId, data.organisationId);
    const active = allocations.find(row => row.orderId === data.orderId && row.status === 'ACTIVE');
    if (!active) throw new Error('Active payment allocation not found for refund.');
    const next = refundedAllocationState(Number(active.amountPence), data.amountPence);
    await dataConnect.executeGraphql(REFUND_PAYMENT_ALLOCATION_GQL, {
      variables: {
        allocationId: active.id,
        amountPence: next.amountPence,
        status: next.status,
        version: Number(active.version) + 1,
      },
    });
    const saved = (await this.listPaymentAllocations(data.paymentId, data.organisationId)).find(row => row.id === active.id);
    if (!saved) throw new Error('Refunded payment allocation could not be stored.');
    return saved;
  }

  async completeRefundAndConsumeAllocation(data: {
    refundId: string;
    organisationId: string;
    orderId: string;
    paymentId: string;
    amountPence: number;
    externalReference: string;
    confirmedByUid: string;
    verificationStatus: string;
    verificationPayload?: unknown;
  }): Promise<PaymentAllocationRecord> {
    const allocations = await this.listPaymentAllocations(data.paymentId, data.organisationId);
    const active = allocations.find(row => row.orderId === data.orderId && row.status === 'ACTIVE');
    if (!active) throw new Error('Active payment allocation not found for refund.');
    const next = refundedAllocationState(Number(active.amountPence), data.amountPence);
    await dataConnect.executeGraphql(COMPLETE_REFUND_AND_ALLOCATION_GQL, {
      variables: {
        refundId: data.refundId,
        externalReference: data.externalReference,
        confirmedByUid: data.confirmedByUid,
        verificationStatus: data.verificationStatus,
        verificationPayload: data.verificationPayload ?? null,
        allocationId: active.id,
        amountPence: next.amountPence,
        allocationStatus: next.status,
        version: Number(active.version) + 1,
      },
    });
    const saved = (await this.listPaymentAllocations(data.paymentId, data.organisationId)).find(row => row.id === active.id);
    if (!saved) throw new Error('Completed refund allocation could not be stored.');
    return saved;
  }
}
