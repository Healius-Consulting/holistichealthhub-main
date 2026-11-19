export interface NotificationOutboxRecord {
  id: string;
  organisationId: string | null;
  patientId: string | null;
  orderId: string | null;
  channel: 'EMAIL' | 'SMS' | 'INTERNAL';
  templateCode: string;
  recipientHash: string;
  encryptedRecipient: string | null;
  /** Every To address of a one-email-to-several send; null means `encryptedRecipient` alone. */
  toRecipients?: string[] | null;
  ccRecipients?: string[] | null;
  payload: unknown;
  idempotencyKey: string;
  status: 'PENDING' | 'PROCESSING' | 'SENT' | 'FAILED' | 'CANCELLED';
  attemptCount: number;
  createdAt: string;
  /** The partner onboarding request the message belongs to (its send log). */
  onboardingRequestId?: string | null;
  sentAt?: string | null;
  failedAt?: string | null;
  failureCode?: string | null;
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
    toRecipients?: string[] | null;
    ccRecipients?: string[] | null;
    payload: unknown;
    idempotencyKey: string;
    /** Hold the message until this instant; null or absent sends on the next sweep. */
    nextAttemptAt?: string | null;
    /** Partner onboarding emails: the request whose send log shows this message. */
    onboardingRequestId?: string | null;
  }): Promise<{ id?: string; created: boolean }>;
  listPending(limit?: number): Promise<NotificationOutboxRecord[]>;
  markProcessing(id: string, attemptCount: number): Promise<void>;
  markSent(id: string, providerResponse?: unknown): Promise<void>;
  /** Return a transient delivery failure to the queue without changing its idempotency key. */
  markRetry?(id: string, attemptCount: number, nextAttemptAt: string, failureCode: string): Promise<void>;
  markFailed(id: string, failureCode: string): Promise<void>;
  /** Every message tagged with this onboarding request, newest first (its send log). */
  listForOnboardingRequest?(onboardingRequestId: string, limit?: number): Promise<NotificationOutboxRecord[]>;
}
