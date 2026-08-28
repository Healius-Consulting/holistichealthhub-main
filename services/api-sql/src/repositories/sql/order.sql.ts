import { dataConnect } from '../../bootstrap/firebase.js';
import type {
  CreateOrderInput,
  OrderDraftRecord,
  OrderRecord,
  OrderRepositoryPort,
} from '../ports/order.port.js';

const GET_ORDER_DRAFT_BY_ID_GQL = `
  query GetOrderDraftById($id: UUID!, $organisationId: UUID!) {
    orderDrafts(
      where: {
        id: { eq: $id }
        organisationId: { eq: $organisationId }
      }
      limit: 1
    ) {
      id
      organisationId
      patientId
      status
      paymentStatus
      pharmacyDeliveryEnabledAtCreation
      payload
      version
      createdAt
      updatedAt
    }
  }
`;

const CREATE_ORDER_DRAFT_GQL = `
  mutation CreateOrderDraft(
    $organisationId: UUID!
    $patientId: UUID
    $payload: Any!
    $pharmacyDeliveryEnabledAtCreation: Boolean!
    $createdByUid: String!
  ) {
    orderDraft_insert(data: {
      organisationId: $organisationId
      patientId: $patientId
      status: DRAFT
      paymentStatus: NONE
      pharmacyDeliveryEnabledAtCreation: $pharmacyDeliveryEnabledAtCreation
      payload: $payload
      createdByUid: $createdByUid
    })
  }
`;

const UPDATE_ORDER_DRAFT_GQL = `
  mutation UpdateOrderDraft(
    $id: UUID!
    $patientId: UUID
    $payload: Any!
  ) {
    orderDraft_update(
      key: { id: $id }
      data: {
        patientId: $patientId
        payload: $payload
        updatedAt_expr: "request.time"
      }
    )
  }
`;

const DELETE_ORDER_DRAFT_GQL = `
  mutation DeleteOrderDraft($id: UUID!) {
    orderDraft_delete(key: { id: $id })
  }
`;

const LIST_TENANT_ORDER_DRAFTS_GQL = `
  query ListTenantOrderDrafts($organisationId: UUID!, $limit: Int!) {
    orderDrafts(
      where: {
        organisationId: { eq: $organisationId }
        status: { eq: DRAFT }
      }
      orderBy: { updatedAt: DESC }
      limit: $limit
    ) {
      id
      organisationId
      patientId
      status
      paymentStatus
      pharmacyDeliveryEnabledAtCreation
      payload
      version
      createdAt
      updatedAt
    }
  }
`;

const LIST_OPEN_ORDER_DRAFTS_GQL = `
  query ListOpenOrderDrafts($limit: Int!) {
    orderDrafts(
      where: { status: { eq: DRAFT } }
      orderBy: { updatedAt: ASC }
      limit: $limit
    ) {
      id
      organisationId
      patientId
      status
      paymentStatus
      pharmacyDeliveryEnabledAtCreation
      payload
      version
      createdAt
      updatedAt
    }
  }
`;

const MARK_ORDER_DRAFT_ABANDONED_GQL = `
  mutation MarkOrderDraftAbandoned($id: UUID!, $payload: Any!) {
    orderDraft_update(
      key: { id: $id }
      data: {
        status: ABANDONED
        payload: $payload
        updatedAt_expr: "request.time"
      }
    )
  }
`;

const GET_ORDER_BY_ID_GQL = `
  query GetOrderById($id: UUID!, $organisationId: UUID!) {
    orders(
      where: {
        id: { eq: $id }
        organisationId: { eq: $organisationId }
      }
      limit: 1
    ) {
      id
      organisationId
      patientId
      draftId
      redoOfId
      orderNumber
      status
      paymentStatus
      fulfilmentStatus
      paymentRoute
      currency
      medicineTotalPence
      dispensingFeePence
      pharmacyDeliveryPence
      deliveryPence
      taxPence
      totalPence
      quoteSnapshot
      version
      submittedAt
      paidAt
      collectedAt
      cancelledAt
      resolutionStatus
      resolutionReason
      resolvedAt
      archivedAt
      createdAt
      updatedAt
    }
  }
`;

const CREATE_ORDER_GQL = `
  mutation CreateOrder(
    $organisationId: UUID!
    $patientId: UUID!
    $draftId: UUID
    $orderNumber: String
    $status: OrderStatus!
    $paymentStatus: PaymentStatus!
    $fulfilmentStatus: FulfilmentStatus!
    $paymentRoute: PaymentRoute!
    $currency: String!
    $medicineTotalPence: Int64!
    $dispensingFeePence: Int64!
    $pharmacyDeliveryPence: Int64!
    $deliveryPence: Int64!
    $taxPence: Int64!
    $totalPence: Int64!
    $quoteSnapshot: Any
    $createdByUid: String!
  ) {
    order_insert(data: {
      organisationId: $organisationId
      patientId: $patientId
      draftId: $draftId
      orderNumber: $orderNumber
      status: $status
      paymentStatus: $paymentStatus
      fulfilmentStatus: $fulfilmentStatus
      paymentRoute: $paymentRoute
      currency: $currency
      medicineTotalPence: $medicineTotalPence
      dispensingFeePence: $dispensingFeePence
      pharmacyDeliveryPence: $pharmacyDeliveryPence
      deliveryPence: $deliveryPence
      taxPence: $taxPence
      totalPence: $totalPence
      quoteSnapshot: $quoteSnapshot
      createdByUid: $createdByUid
      submittedAt_expr: "request.time"
    })
  }
`;

const RECORD_PAYMENT_ORDER_GQL = `
  mutation RecordPaymentOrder($id: UUID!) {
    order_update(
      key: { id: $id }
      data: {
        status: PROCESSING
        paymentStatus: PAID
        paidAt_expr: "request.time"
        updatedAt_expr: "request.time"
      }
    )
  }
`;

const UPDATE_FULFILMENT_GQL = `
  mutation UpdateFulfilment($id: UUID!, $fulfilmentStatus: FulfilmentStatus!) {
    order_update(
      key: { id: $id }
      data: {
        status: PROCESSING
        fulfilmentStatus: $fulfilmentStatus
        updatedAt_expr: "request.time"
      }
    )
  }
`;

const COMPLETE_ORDER_GQL = `
  mutation CompleteOrder($id: UUID!) {
    order_update(
      key: { id: $id }
      data: {
        status: COMPLETED
        fulfilmentStatus: COLLECTED
        collectedAt_expr: "request.time"
        updatedAt_expr: "request.time"
      }
    )
  }
`;

const CANCEL_ORDER_GQL = `
  mutation CancelOrder($id: UUID!) {
    order_update(
      key: { id: $id }
      data: {
        status: CANCELLED
        cancelledAt_expr: "request.time"
        updatedAt_expr: "request.time"
      }
    )
  }
`;

const LINK_REPLACEMENT_RESOLUTION_GQL = `
  mutation LinkReplacementResolution($sourceOrderId: UUID!, $replacementOrderId: UUID!) {
    order_update(key: { id: $replacementOrderId }, data: {
      redoOfId: $sourceOrderId
      status: PROCESSING
      paymentStatus: PAID
      paidAt_expr: "request.time"
      updatedAt_expr: "request.time"
    })
    order_update(key: { id: $sourceOrderId }, data: {
      status: CANCELLED
      resolutionStatus: "RESOLVED"
      resolutionReason: "REPLACED"
      resolvedAt_expr: "request.time"
      archivedAt_expr: "request.time"
      cancelledAt_expr: "request.time"
      updatedAt_expr: "request.time"
    })
  }
`;

const MARK_REFUND_RESOLUTION_GQL = `
  mutation MarkRefundResolution($orderId: UUID!, $paymentStatus: PaymentStatus!) {
    order_update(key: { id: $orderId }, data: {
      status: CANCELLED
      paymentStatus: $paymentStatus
      resolutionStatus: "RESOLVED"
      resolutionReason: "REFUNDED"
      resolvedAt_expr: "request.time"
      archivedAt_expr: "request.time"
      cancelledAt_expr: "request.time"
      updatedAt_expr: "request.time"
    })
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

const LIST_TENANT_ORDERS_GQL = `
  query ListTenantOrders($organisationId: UUID!, $limit: Int!) {
    orders(
      where: { organisationId: { eq: $organisationId } }
      limit: $limit
    ) {
      id
      organisationId
      patientId
      draftId
      redoOfId
      orderNumber
      status
      paymentStatus
      fulfilmentStatus
      paymentRoute
      currency
      medicineTotalPence
      dispensingFeePence
      pharmacyDeliveryPence
      deliveryPence
      taxPence
      totalPence
      quoteSnapshot
      version
      submittedAt
      paidAt
      collectedAt
      cancelledAt
      resolutionStatus
      resolutionReason
      resolvedAt
      archivedAt
      createdAt
      updatedAt
    }
  }
`;

const LIST_PAID_OPEN_ORDERS_GQL = `
  query ListPaidOpenOrders($limit: Int!) {
    orders(
      where: {
        paymentStatus: { eq: PAID }
        status: { ne: CANCELLED }
      }
      limit: $limit
    ) {
      id
      organisationId
      patientId
      draftId
      redoOfId
      orderNumber
      status
      paymentStatus
      fulfilmentStatus
      paymentRoute
      currency
      medicineTotalPence
      dispensingFeePence
      pharmacyDeliveryPence
      deliveryPence
      taxPence
      totalPence
      quoteSnapshot
      version
      submittedAt
      paidAt
      collectedAt
      cancelledAt
      resolutionStatus
      resolutionReason
      resolvedAt
      archivedAt
      createdAt
      updatedAt
    }
  }
`;

const UPDATE_ORDER_SNAPSHOT_GQL = `
  mutation UpdateOrderSnapshot($id: UUID!, $quoteSnapshot: Any, $fulfilmentStatus: FulfilmentStatus, $dispensingFeePence: Int64, $medicineTotalPence: Int64) {
    order_update(
      key: { id: $id }
      data: {
        quoteSnapshot: $quoteSnapshot
        fulfilmentStatus: $fulfilmentStatus
        dispensingFeePence: $dispensingFeePence
        medicineTotalPence: $medicineTotalPence
        updatedAt_expr: "request.time"
      }
    )
  }
`;

const APPEND_PLACEMENT_EVENT_GQL = `
  mutation AppendPlacementEvent(
    $organisationId: UUID!
    $orderId: UUID!
    $orderLineId: UUID
    $fromState: PlacementState
    $toState: PlacementState!
    $reason: String
    $externalReference: String
    $actorUid: String
  ) {
    placementEvent_insert(data: {
      organisationId: $organisationId
      orderId: $orderId
      orderLineId: $orderLineId
      fromState: $fromState
      toState: $toState
      reason: $reason
      externalReference: $externalReference
      actorUid: $actorUid
    })
  }
`;

export class SqlOrderRepository implements OrderRepositoryPort {
  async findDraftById(id: string, organisationId: string): Promise<OrderDraftRecord | null> {
    const result = await dataConnect.executeGraphql<{ orderDrafts: OrderDraftRecord[] }, any>(
      GET_ORDER_DRAFT_BY_ID_GQL,
      { variables: { id, organisationId } }
    );
    return result.data.orderDrafts?.[0] ?? null;
  }

  async createDraft(data: {
    organisationId: string;
    patientId?: string | null;
    payload: unknown;
    pharmacyDeliveryEnabledAtCreation: boolean;
    createdByUid: string;
  }): Promise<{ id?: string }> {
    const result = await dataConnect.executeGraphql<{ orderDraft_insert: { id: string } }, any>(
      CREATE_ORDER_DRAFT_GQL,
      {
        variables: {
          organisationId: data.organisationId,
          patientId: data.patientId ?? null,
          payload: data.payload,
          pharmacyDeliveryEnabledAtCreation: data.pharmacyDeliveryEnabledAtCreation,
          createdByUid: data.createdByUid,
        },
      }
    );
    return { id: result.data.orderDraft_insert?.id };
  }

  async listOpenDrafts(limit = 2_000): Promise<OrderDraftRecord[]> {
    const result = await dataConnect.executeGraphql<{ orderDrafts: OrderDraftRecord[] }, any>(
      LIST_OPEN_ORDER_DRAFTS_GQL,
      { variables: { limit } },
    );
    return result.data.orderDrafts ?? [];
  }

  async markDraftAbandoned(id: string, scrubbedPayload: unknown): Promise<void> {
    await dataConnect.executeGraphql(MARK_ORDER_DRAFT_ABANDONED_GQL, {
      variables: { id, payload: scrubbedPayload },
    });
  }

  async updateDraft(data: {
    id: string;
    organisationId: string;
    patientId?: string | null;
    payload: unknown;
  }): Promise<{ id: string } | null> {
    const existing = await this.findDraftById(data.id, data.organisationId);
    if (!existing) return null;
    const result = await dataConnect.executeGraphql<{ orderDraft_update: { id: string } | null }, any>(
      UPDATE_ORDER_DRAFT_GQL,
      {
        variables: {
          id: data.id,
          patientId: data.patientId || null,
          payload: data.payload ?? {},
        },
      }
    );
    return result.data.orderDraft_update ? { id: result.data.orderDraft_update.id } : { id: data.id };
  }

  async deleteDraft(id: string, organisationId: string): Promise<boolean> {
    const existing = await this.findDraftById(id, organisationId);
    if (!existing) return false;
    await dataConnect.executeGraphql<any, any>(
      DELETE_ORDER_DRAFT_GQL,
      { variables: { id } }
    );
    return true;
  }

  async listTenantDrafts(organisationId: string, limit = 200): Promise<OrderDraftRecord[]> {
    const result = await dataConnect.executeGraphql<{ orderDrafts: OrderDraftRecord[] }, any>(
      LIST_TENANT_ORDER_DRAFTS_GQL,
      { variables: { organisationId, limit } },
    );
    return result.data.orderDrafts ?? [];
  }

  async findOrderById(id: string, organisationId: string): Promise<OrderRecord | null> {
    const result = await dataConnect.executeGraphql<{ orders: OrderRecord[] }, any>(
      GET_ORDER_BY_ID_GQL,
      { variables: { id, organisationId } }
    );
    return result.data.orders?.[0] ?? null;
  }

  async createOrder(data: CreateOrderInput): Promise<{ id?: string }> {
    const result = await dataConnect.executeGraphql<{ order_insert: { id: string } }, any>(
      CREATE_ORDER_GQL,
      {
        variables: {
          organisationId: data.organisationId,
          patientId: data.patientId,
          draftId: data.draftId ?? null,
          orderNumber: data.orderNumber ?? null,
          status: data.status,
          paymentStatus: data.paymentStatus,
          fulfilmentStatus: data.fulfilmentStatus,
          paymentRoute: data.paymentRoute,
          currency: data.currency,
          medicineTotalPence: data.medicineTotalPence,
          dispensingFeePence: data.dispensingFeePence,
          pharmacyDeliveryPence: data.pharmacyDeliveryPence,
          deliveryPence: data.deliveryPence,
          taxPence: data.taxPence,
          totalPence: data.totalPence,
          quoteSnapshot: data.quoteSnapshot ?? null,
          createdByUid: data.createdByUid,
        },
      }
    );
    return { id: result.data.order_insert?.id };
  }

  async listTenantOrders(organisationId: string, limit = 200): Promise<OrderRecord[]> {
    const result = await dataConnect.executeGraphql<{ orders: OrderRecord[] }, any>(
      LIST_TENANT_ORDERS_GQL,
      { variables: { organisationId, limit } }
    );
    return result.data.orders ?? [];
  }

  async listPaidOpenOrders(limit = 1000): Promise<OrderRecord[]> {
    const result = await dataConnect.executeGraphql<{ orders: OrderRecord[] }, any>(
      LIST_PAID_OPEN_ORDERS_GQL,
      { variables: { limit } },
    );
    return result.data.orders ?? [];
  }

  async updateQuoteSnapshot(data: {
    id: string;
    organisationId: string;
    quoteSnapshot: unknown;
    fulfilmentStatus?: CreateOrderInput['fulfilmentStatus'];
    dispensingFeePence?: number;
    medicineTotalPence?: number;
  }): Promise<boolean> {
    const existing = await this.findOrderById(data.id, data.organisationId);
    if (!existing) return false;
    await dataConnect.executeGraphql<any, any>(UPDATE_ORDER_SNAPSHOT_GQL, {
      variables: {
        id: data.id,
        quoteSnapshot: data.quoteSnapshot ?? existing.quoteSnapshot ?? null,
        fulfilmentStatus: data.fulfilmentStatus ?? existing.fulfilmentStatus,
        dispensingFeePence: data.dispensingFeePence ?? existing.dispensingFeePence,
        medicineTotalPence: data.medicineTotalPence ?? existing.medicineTotalPence,
      },
    });
    return true;
  }

  async linkReplacementResolution(data: {
    sourceOrderId: string;
    replacementOrderId: string;
    organisationId: string;
  }): Promise<void> {
    const [source, replacement] = await Promise.all([
      this.findOrderById(data.sourceOrderId, data.organisationId),
      this.findOrderById(data.replacementOrderId, data.organisationId),
    ]);
    if (!source || !replacement) throw new Error('Replacement orders must belong to the same pharmacy.');
    await dataConnect.executeGraphql(LINK_REPLACEMENT_RESOLUTION_GQL, {
      variables: { sourceOrderId: data.sourceOrderId, replacementOrderId: data.replacementOrderId },
    });
  }

  async markRefundResolution(data: { orderId: string; organisationId: string; fullyRefunded: boolean }): Promise<void> {
    const order = await this.findOrderById(data.orderId, data.organisationId);
    if (!order) throw new Error('Refunded order must belong to the same pharmacy.');
    await dataConnect.executeGraphql(MARK_REFUND_RESOLUTION_GQL, {
      variables: { orderId: data.orderId, paymentStatus: data.fullyRefunded ? 'REFUNDED' : 'PAID' },
    });
  }

  async setPaymentStatus(id: string, paymentStatus: 'NONE' | 'PENDING' | 'PAID' | 'FAILED' | 'CANCELLED' | 'REFUND_REQUIRED' | 'REFUNDED'): Promise<void> {
    await dataConnect.executeGraphql<any, any>(UPDATE_ORDER_PAYMENT_STATUS_GQL, {
      variables: { id, paymentStatus },
    });
  }

  async updateOrderStatus(data: {
    id: string;
    organisationId: string;
    status?: 'DRAFT' | 'SUBMITTED' | 'PROCESSING' | 'COMPLETED' | 'CANCELLED' | 'EXCEPTION';
    paymentStatus?: 'NONE' | 'PENDING' | 'PAID' | 'FAILED' | 'CANCELLED' | 'REFUND_REQUIRED' | 'REFUNDED';
    fulfilmentStatus?: 'SUPPLIER_PENDING' | 'SUPPLIER_PROCESSING' | 'SUPPLIER_ALLOCATED' | 'PARTIALLY_DISPATCHED_TO_PHARMACY' | 'DISPATCHED_TO_PHARMACY' | 'PARTIALLY_RECEIVED' | 'RECEIVED' | 'READY_FOR_COLLECTION' | 'COLLECTED' | 'EXCEPTION';
    paidAt?: string | null;
    cancelledAt?: string | null;
  }): Promise<boolean> {
    const existing = await this.findOrderById(data.id, data.organisationId);
    if (!existing) return false;

    if (data.status === 'CANCELLED' || data.cancelledAt) {
      await dataConnect.executeGraphql<any, any>(CANCEL_ORDER_GQL, { variables: { id: data.id } });
      if (data.paymentStatus) await this.setPaymentStatus(data.id, data.paymentStatus);
      return true;
    }

    if (data.paymentStatus === 'PAID' || data.paidAt) {
      await dataConnect.executeGraphql<any, any>(RECORD_PAYMENT_ORDER_GQL, { variables: { id: data.id } });
      return true;
    }

    if (data.fulfilmentStatus === 'COLLECTED' || data.status === 'COMPLETED') {
      await dataConnect.executeGraphql<any, any>(COMPLETE_ORDER_GQL, { variables: { id: data.id } });
      return true;
    }

    if (data.fulfilmentStatus) {
      await dataConnect.executeGraphql<any, any>(UPDATE_FULFILMENT_GQL, {
        variables: { id: data.id, fulfilmentStatus: data.fulfilmentStatus },
      });
      return true;
    }

    return true;
  }

  async appendPlacementEvent(data: {
    organisationId: string;
    orderId: string;
    orderLineId?: string | null;
    fromState?: string | null;
    toState: string;
    reason?: string | null;
    externalReference?: string | null;
    actorUid?: string | null;
  }): Promise<void> {
    try {
      const isUuid = (val?: string | null) => Boolean(val && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(val));
      const orderLineId = isUuid(data.orderLineId) ? data.orderLineId : null;
      const validStates = new Set(['PENDING_PLACEMENT', 'HELD_PRICE', 'HELD_STOCK', 'CANCELLATION_PENDING_REFUND', 'PLACED', 'HELD_FOR_RENEWAL', 'CANCELLED_REFUNDED']);
      const toState = validStates.has(data.toState) ? data.toState : 'PENDING_PLACEMENT';
      const fromState = data.fromState && validStates.has(data.fromState) ? data.fromState : null;

      await dataConnect.executeGraphql<any, any>(APPEND_PLACEMENT_EVENT_GQL, {
        variables: {
          organisationId: data.organisationId,
          orderId: data.orderId,
          orderLineId,
          fromState,
          toState,
          reason: data.reason ?? null,
          externalReference: data.externalReference ?? null,
          actorUid: data.actorUid ?? null,
        },
      });
    } catch (err) {
      console.warn('Placement event logging note:', err);
    }
  }
}
