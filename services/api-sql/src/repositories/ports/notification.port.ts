export interface NotificationOutboxRecord {
  id: string;
  organisationId: string | null;
  patientId: string | null;
  orderId: string | null;
  channel: 'EMAIL' | 'SMS' | 'INTERNAL';
  templateCode: string;
  recipientHash: string;
  encryptedRecipient: string | null;
  payload: unknown;
  idempotencyKey: string;
  status: 'PENDING' | 'PROCESSING' | 'SENT' | 'FAILED' | 'CANCELLED';
  attemptCount: number;
  createdAt: string;
}

export interface NotificationRepositoryPort {
  findByIdempotencyKey(idempotencyKey: string): Promise<NotificationOutboxRecord | null>;
  enqueue(data: {
    organisationId?: string | null;
    patientId?: string | null;
    orderId?: string | null;
    channel: 'EMAIL' | 'SMS' | 'INTERNAL';
    templateCode: string;
    recipientHash: string;
    encryptedRecipient?: string | null;
    payload: unknown;
    idempotencyKey: string;
    /** Hold the message until this instant; null or absent sends on the next sweep. */
    nextAttemptAt?: string | null;
  }): Promise<{ id?: string; created: boolean }>;
  listPending(limit?: number): Promise<NotificationOutboxRecord[]>;
  markProcessing(id: string, attemptCount: number): Promise<void>;
  markSent(id: string, providerResponse?: unknown): Promise<void>;
  /** Return a transient delivery failure to the queue without changing its idempotency key. */
  markRetry?(id: string, attemptCount: number, nextAttemptAt: string, failureCode: string): Promise<void>;
  markFailed(id: string, failureCode: string): Promise<void>;
}
