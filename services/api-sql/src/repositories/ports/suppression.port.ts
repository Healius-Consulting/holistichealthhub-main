export interface SuppressionRecord {
  contactHash: string;
  channel: 'EMAIL' | 'SMS';
  organisationId: string | null;
  reason: string;
  suppressedAt: string;
}

export interface SuppressionRepositoryPort {
  /** Idempotent: unsubscribing twice is a no-op, not an error. */
  suppress(input: {
    contactHash: string;
    channel: 'EMAIL' | 'SMS';
    organisationId?: string | null;
    reason: string;
  }): Promise<void>;
  isSuppressed(contactHash: string): Promise<boolean>;
}
