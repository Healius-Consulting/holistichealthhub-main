import { dataConnect } from '../../bootstrap/firebase.js';
import type { NotificationOutboxRecord, NotificationRepositoryPort } from '../ports/notification.port.js';

const OUTBOX_FIELDS = `
  id
  organisationId
  patientId
  orderId
  channel
  templateCode
  recipientHash
  encryptedRecipient
  payload
  idempotencyKey
  status
  attemptCount
  createdAt
`;

const FIND_BY_IDEMPOTENCY_GQL = `
  query FindNotificationByIdempotency($idempotencyKey: String!) {
    notificationOutboxes(where: { idempotencyKey: { eq: $idempotencyKey } }, limit: 1) {
      ${OUTBOX_FIELDS}
    }
  }
`;

const LIST_PENDING_GQL = `
  query ListPendingNotifications($limit: Int!, $now: Timestamp!) {
    notificationOutboxes(
      where: {
        _and: [
          { status: { eq: PENDING } }
          {
            _or: [
              { nextAttemptAt: { isNull: true } }
              { nextAttemptAt: { le: $now } }
            ]
          }
        ]
      }
      limit: $limit
    ) {
      ${OUTBOX_FIELDS}
    }
  }
`;

const INSERT_GQL = `
  mutation InsertNotificationOutbox(
    $organisationId: UUID
    $patientId: UUID
    $orderId: UUID
    $channel: NotificationChannel!
    $templateCode: String!
    $recipientHash: String!
    $encryptedRecipient: String
    $payload: Any!
    $idempotencyKey: String!
    $nextAttemptAt: Timestamp
  ) {
    notificationOutbox_insert(data: {
      organisationId: $organisationId
      patientId: $patientId
      orderId: $orderId
      channel: $channel
      templateCode: $templateCode
      recipientHash: $recipientHash
      encryptedRecipient: $encryptedRecipient
      payload: $payload
      idempotencyKey: $idempotencyKey
      nextAttemptAt: $nextAttemptAt
      status: PENDING
      attemptCount: 0
      version: 1
    })
  }
`;

const MARK_PROCESSING_GQL = `
  mutation MarkNotificationProcessing($id: UUID!, $attemptCount: Int!) {
    notificationOutbox_update(
      key: { id: $id }
      data: {
        status: PROCESSING
        attemptCount: $attemptCount
      }
    )
  }
`;

const MARK_SENT_GQL = `
  mutation MarkNotificationSent($id: UUID!, $payload: Any) {
    notificationOutbox_update(
      key: { id: $id }
      data: {
        status: SENT
        payload: $payload
        sentAt_expr: "request.time"
      }
    )
  }
`;

const MARK_FAILED_GQL = `
  mutation MarkNotificationFailed($id: UUID!, $failureCode: String!) {
    notificationOutbox_update(
      key: { id: $id }
      data: {
        status: FAILED
        failureCode: $failureCode
        failedAt_expr: "request.time"
      }
    )
  }
`;

const MARK_RETRY_GQL = `
  mutation MarkNotificationRetry($id: UUID!, $attemptCount: Int!, $nextAttemptAt: Timestamp!, $failureCode: String!) {
    notificationOutbox_update(
      key: { id: $id }
      data: {
        status: PENDING
        attemptCount: $attemptCount
        nextAttemptAt: $nextAttemptAt
        failureCode: $failureCode
      }
    )
  }
`;

export class SqlNotificationRepository implements NotificationRepositoryPort {
  async findByIdempotencyKey(idempotencyKey: string): Promise<NotificationOutboxRecord | null> {
    const result = await dataConnect.executeGraphql<{ notificationOutboxes: NotificationOutboxRecord[] }, any>(
      FIND_BY_IDEMPOTENCY_GQL,
      { variables: { idempotencyKey } },
    );
    return result.data.notificationOutboxes?.[0] ?? null;
  }

  async enqueue(data: {
    organisationId?: string | null;
    patientId?: string | null;
    orderId?: string | null;
    channel: 'EMAIL' | 'SMS' | 'INTERNAL';
    templateCode: string;
    recipientHash: string;
    encryptedRecipient?: string | null;
    payload: unknown;
    idempotencyKey: string;
    nextAttemptAt?: string | null;
  }): Promise<{ id?: string; created: boolean }> {
    const existing = await this.findByIdempotencyKey(data.idempotencyKey);
    if (existing) return { id: existing.id, created: false };
    try {
      const result = await dataConnect.executeGraphql<{ notificationOutbox_insert: { id: string } }, any>(
        INSERT_GQL,
        {
          variables: {
            organisationId: data.organisationId ?? null,
            patientId: data.patientId ?? null,
            orderId: data.orderId ?? null,
            channel: data.channel,
            templateCode: data.templateCode,
            nextAttemptAt: data.nextAttemptAt ?? null,
            recipientHash: data.recipientHash,
            encryptedRecipient: data.encryptedRecipient ?? null,
            payload: data.payload,
            idempotencyKey: data.idempotencyKey,
          },
        },
      );
      return { id: result.data.notificationOutbox_insert?.id, created: true };
    } catch (error) {
      const raced = await this.findByIdempotencyKey(data.idempotencyKey);
      if (raced) return { id: raced.id, created: false };
      throw error;
    }
  }

  async listPending(limit = 100): Promise<NotificationOutboxRecord[]> {
    const result = await dataConnect.executeGraphql<{ notificationOutboxes: NotificationOutboxRecord[] }, any>(
      LIST_PENDING_GQL,
      { variables: { limit, now: new Date().toISOString() } },
    );
    return result.data.notificationOutboxes ?? [];
  }

  async markProcessing(id: string, attemptCount: number): Promise<void> {
    await dataConnect.executeGraphql(MARK_PROCESSING_GQL, { variables: { id, attemptCount } });
  }

  async markSent(id: string, providerResponse?: unknown): Promise<void> {
    await dataConnect.executeGraphql(MARK_SENT_GQL, { variables: { id, payload: providerResponse ?? null } });
  }

  async markRetry(id: string, attemptCount: number, nextAttemptAt: string, failureCode: string): Promise<void> {
    await dataConnect.executeGraphql(MARK_RETRY_GQL, {
      variables: { id, attemptCount, nextAttemptAt, failureCode: failureCode.slice(0, 180) },
    });
  }

  async markFailed(id: string, failureCode: string): Promise<void> {
    await dataConnect.executeGraphql(MARK_FAILED_GQL, { variables: { id, failureCode: failureCode.slice(0, 180) } });
  }
}
