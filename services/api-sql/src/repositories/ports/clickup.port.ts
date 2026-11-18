import type { ClickupCardFields, ClickupEvent, ClickupStage } from '../../domain/clickup/clickup-events.js';

export type ClickupOutboxStatus = 'PENDING' | 'PROCESSING' | 'SENT' | 'FAILED';

export interface ClickupOutboxRecord {
  id: string;
  gphcNumber: string;
  event: ClickupEvent;
  payload: ClickupCardFields;
  idempotencyKey: string;
  status: ClickupOutboxStatus;
  attemptCount: number;
  nextAttemptAt: string | null;
  createdAt: string;
}

export interface ClickupCardRecord {
  gphcNumber: string;
  clickupTaskId: string | null;
  onboardingRequestId: string | null;
  organisationId: string | null;
  stage: ClickupStage | null;
  pharCodeEntered: boolean;
  apiKeyEntered: boolean;
}

export interface ClickupRepositoryPort {
  /** Idempotent on `idempotencyKey`: a repeat returns `created: false`. */
  enqueue(input: {
    gphcNumber: string;
    event: ClickupEvent;
    payload: ClickupCardFields;
    idempotencyKey: string;
  }): Promise<{ created: boolean }>;
  /** Every PENDING event, oldest first, due or not: the worker keeps each card's events in order. */
  listPending(limit: number): Promise<ClickupOutboxRecord[]>;
  markProcessing(id: string, attemptCount: number): Promise<void>;
  markSent(id: string): Promise<void>;
  markRetry(id: string, attemptCount: number, nextAttemptAt: string, failureCode: string): Promise<void>;
  markFailed(id: string, attemptCount: number, failureCode: string): Promise<void>;
  /** The card matching any of the keys: GPhC, then onboarding request, then branch. */
  findCard(keys: { gphcNumber: string; onboardingRequestId?: string | null; organisationId?: string | null }): Promise<ClickupCardRecord | null>;
  saveCard(card: ClickupCardRecord): Promise<void>;
}

export interface PharmacyOnboardingVisitRecord {
  gphcNumber: string;
  pharmsmartPharmacyId: string | null;
  tradingName: string | null;
  firstVisitAt: string;
  submittedAt: string | null;
}

export interface PharmacyOnboardingVisitRepositoryPort {
  findVisit(gphcNumber: string): Promise<PharmacyOnboardingVisitRecord | null>;
  /** Writes the record only if the GPhC has none; `created` says whether this call wrote it. */
  insertVisit(input: { gphcNumber: string; pharmsmartPharmacyId: string | null; tradingName: string | null }): Promise<{ created: boolean }>;
  markSubmitted(gphcNumber: string, submittedAt: string): Promise<void>;
  listUnsubmittedBefore(cutoff: string, limit: number): Promise<PharmacyOnboardingVisitRecord[]>;
  deleteVisit(gphcNumber: string): Promise<void>;
}
