import { dataConnect } from '../../bootstrap/firebase.js';
import { asUuid } from '../../domain/common/uuid.js';
import { isClickupEvent, type ClickupStage } from '../../domain/clickup/clickup-events.js';
import type {
  ClickupCardRecord,
  ClickupOutboxRecord,
  ClickupRepositoryPort,
  PharmacyOnboardingVisitRecord,
  PharmacyOnboardingVisitRepositoryPort,
} from '../ports/clickup.port.js';

const OUTBOX_FIELDS = `
  id
  gphcNumber
  event
  payload
  idempotencyKey
  status
  attemptCount
  nextAttemptAt
  createdAt
`;

const FIND_OUTBOX_BY_KEY_GQL = `
  query FindClickupOutboxByIdempotency($idempotencyKey: String!) {
    clickupOutboxes(where: { idempotencyKey: { eq: $idempotencyKey } }, limit: 1) {
      id
    }
  }
`;

const INSERT_OUTBOX_GQL = `
  mutation InsertClickupOutbox($gphcNumber: String!, $event: String!, $payload: Any!, $idempotencyKey: String!) {
    clickupOutbox_insert(data: {
      gphcNumber: $gphcNumber
      event: $event
      payload: $payload
      idempotencyKey: $idempotencyKey
      status: PENDING
      attemptCount: 0
    })
  }
`;

const LIST_PENDING_OUTBOX_GQL = `
  query ListPendingClickupOutbox($limit: Int!) {
    clickupOutboxes(
      where: { status: { eq: PENDING } }
      orderBy: [{ createdAt: ASC }]
      limit: $limit
    ) {
      ${OUTBOX_FIELDS}
    }
  }
`;

const MARK_OUTBOX_PROCESSING_GQL = `
  mutation MarkClickupOutboxProcessing($id: UUID!, $attemptCount: Int!) {
    clickupOutbox_update(key: { id: $id }, data: { status: PROCESSING, attemptCount: $attemptCount })
  }
`;

const MARK_OUTBOX_SENT_GQL = `
  mutation MarkClickupOutboxSent($id: UUID!) {
    clickupOutbox_update(key: { id: $id }, data: { status: SENT, sentAt_expr: "request.time" })
  }
`;

const MARK_OUTBOX_RETRY_GQL = `
  mutation MarkClickupOutboxRetry($id: UUID!, $attemptCount: Int!, $nextAttemptAt: Timestamp!, $failureCode: String!) {
    clickupOutbox_update(key: { id: $id }, data: {
      status: PENDING
      attemptCount: $attemptCount
      nextAttemptAt: $nextAttemptAt
      failureCode: $failureCode
    })
  }
`;

const MARK_OUTBOX_FAILED_GQL = `
  mutation MarkClickupOutboxFailed($id: UUID!, $attemptCount: Int!, $failureCode: String!) {
    clickupOutbox_update(key: { id: $id }, data: {
      status: FAILED
      attemptCount: $attemptCount
      failureCode: $failureCode
      failedAt_expr: "request.time"
    })
  }
`;

const CARD_FIELDS = `
  gphcNumber
  clickupTaskId
  onboardingRequestId
  organisationId
  status
  pharCodeEntered
  apiKeyEntered
`;

const CARD_BY_GPHC_GQL = `
  query ClickupCardByGphc($gphcNumber: String!) {
    clickupCard(key: { gphcNumber: $gphcNumber }) {
      ${CARD_FIELDS}
    }
  }
`;

const CARD_BY_REQUEST_GQL = `
  query ClickupCardByRequest($onboardingRequestId: UUID!) {
    clickupCards(where: { onboardingRequestId: { eq: $onboardingRequestId } }, limit: 1) {
      ${CARD_FIELDS}
    }
  }
`;

const CARD_BY_ORGANISATION_GQL = `
  query ClickupCardByOrganisation($organisationId: UUID!) {
    clickupCards(where: { organisationId: { eq: $organisationId } }, limit: 1) {
      ${CARD_FIELDS}
    }
  }
`;

const UPSERT_CARD_GQL = `
  mutation UpsertClickupCard(
    $gphcNumber: String!
    $clickupTaskId: String
    $onboardingRequestId: UUID
    $organisationId: UUID
    $status: String
    $pharCodeEntered: Boolean!
    $apiKeyEntered: Boolean!
  ) {
    clickupCard_upsert(data: {
      gphcNumber: $gphcNumber
      clickupTaskId: $clickupTaskId
      onboardingRequestId: $onboardingRequestId
      organisationId: $organisationId
      status: $status
      pharCodeEntered: $pharCodeEntered
      apiKeyEntered: $apiKeyEntered
      updatedAt_expr: "request.time"
    })
  }
`;

type RawCard = {
  gphcNumber: string;
  clickupTaskId?: string | null;
  onboardingRequestId?: string | null;
  organisationId?: string | null;
  status?: string | null;
  pharCodeEntered?: boolean | null;
  apiKeyEntered?: boolean | null;
};

function toCard(row: RawCard | null | undefined): ClickupCardRecord | null {
  if (!row) return null;
  return {
    gphcNumber: row.gphcNumber,
    clickupTaskId: row.clickupTaskId ?? null,
    onboardingRequestId: row.onboardingRequestId ?? null,
    organisationId: row.organisationId ?? null,
    stage: (row.status as ClickupStage | null | undefined) ?? null,
    pharCodeEntered: Boolean(row.pharCodeEntered),
    apiKeyEntered: Boolean(row.apiKeyEntered),
  };
}

type RawOutbox = Omit<ClickupOutboxRecord, 'event' | 'nextAttemptAt'> & { event: string; nextAttemptAt?: string | null };

export class SqlClickupRepository implements ClickupRepositoryPort {
  async enqueue(input: Parameters<ClickupRepositoryPort['enqueue']>[0]): Promise<{ created: boolean }> {
    if (await this.outboxExists(input.idempotencyKey)) return { created: false };
    try {
      await dataConnect.executeGraphql(INSERT_OUTBOX_GQL, { variables: input });
      return { created: true };
    } catch (error) {
      // Two requests raced on the same key: the unique index let one through.
      if (await this.outboxExists(input.idempotencyKey)) return { created: false };
      throw error;
    }
  }

  private async outboxExists(idempotencyKey: string) {
    const result = await dataConnect.executeGraphql<{ clickupOutboxes: Array<{ id: string }> }, { idempotencyKey: string }>(
      FIND_OUTBOX_BY_KEY_GQL,
      { variables: { idempotencyKey } },
    );
    return (result.data.clickupOutboxes?.length ?? 0) > 0;
  }

  async listPending(limit: number): Promise<ClickupOutboxRecord[]> {
    const result = await dataConnect.executeGraphql<{ clickupOutboxes: RawOutbox[] }, { limit: number }>(
      LIST_PENDING_OUTBOX_GQL,
      { variables: { limit } },
    );
    return (result.data.clickupOutboxes ?? [])
      .filter(row => isClickupEvent(row.event))
      .map(row => ({ ...row, event: row.event as ClickupOutboxRecord['event'], nextAttemptAt: row.nextAttemptAt ?? null }));
  }

  async markProcessing(id: string, attemptCount: number): Promise<void> {
    await dataConnect.executeGraphql(MARK_OUTBOX_PROCESSING_GQL, { variables: { id: asUuid(id), attemptCount } });
  }

  async markSent(id: string): Promise<void> {
    await dataConnect.executeGraphql(MARK_OUTBOX_SENT_GQL, { variables: { id: asUuid(id) } });
  }

  async markRetry(id: string, attemptCount: number, nextAttemptAt: string, failureCode: string): Promise<void> {
    await dataConnect.executeGraphql(MARK_OUTBOX_RETRY_GQL, {
      variables: { id: asUuid(id), attemptCount, nextAttemptAt, failureCode: failureCode.slice(0, 180) },
    });
  }

  async markFailed(id: string, attemptCount: number, failureCode: string): Promise<void> {
    await dataConnect.executeGraphql(MARK_OUTBOX_FAILED_GQL, {
      variables: { id: asUuid(id), attemptCount, failureCode: failureCode.slice(0, 180) },
    });
  }

  async findCard(keys: { gphcNumber: string; onboardingRequestId?: string | null; organisationId?: string | null }) {
    const byGphc = await dataConnect.executeGraphql<{ clickupCard: RawCard | null }, { gphcNumber: string }>(
      CARD_BY_GPHC_GQL,
      { variables: { gphcNumber: keys.gphcNumber } },
    );
    if (byGphc.data.clickupCard) return toCard(byGphc.data.clickupCard);
    if (keys.onboardingRequestId) {
      const byRequest = await dataConnect.executeGraphql<{ clickupCards: RawCard[] }, { onboardingRequestId: string }>(
        CARD_BY_REQUEST_GQL,
        { variables: { onboardingRequestId: asUuid(keys.onboardingRequestId) } },
      );
      if (byRequest.data.clickupCards?.[0]) return toCard(byRequest.data.clickupCards[0]);
    }
    if (keys.organisationId) {
      const byOrganisation = await dataConnect.executeGraphql<{ clickupCards: RawCard[] }, { organisationId: string }>(
        CARD_BY_ORGANISATION_GQL,
        { variables: { organisationId: asUuid(keys.organisationId) } },
      );
      if (byOrganisation.data.clickupCards?.[0]) return toCard(byOrganisation.data.clickupCards[0]);
    }
    return null;
  }

  async saveCard(card: ClickupCardRecord): Promise<void> {
    await dataConnect.executeGraphql(UPSERT_CARD_GQL, {
      variables: {
        gphcNumber: card.gphcNumber,
        clickupTaskId: card.clickupTaskId,
        onboardingRequestId: card.onboardingRequestId ? asUuid(card.onboardingRequestId) : null,
        organisationId: card.organisationId ? asUuid(card.organisationId) : null,
        status: card.stage,
        pharCodeEntered: card.pharCodeEntered,
        apiKeyEntered: card.apiKeyEntered,
      },
    });
  }
}

const VISIT_FIELDS = `
  gphcNumber
  pharmsmartPharmacyId
  tradingName
  firstVisitAt
  submittedAt
`;

const VISIT_BY_GPHC_GQL = `
  query PharmacyOnboardingVisitByGphc($gphcNumber: String!) {
    pharmacyOnboardingVisit(key: { gphcNumber: $gphcNumber }) {
      ${VISIT_FIELDS}
    }
  }
`;

const INSERT_VISIT_GQL = `
  mutation InsertPharmacyOnboardingVisit($gphcNumber: String!, $pharmsmartPharmacyId: String, $tradingName: String) {
    pharmacyOnboardingVisit_insert(data: {
      gphcNumber: $gphcNumber
      pharmsmartPharmacyId: $pharmsmartPharmacyId
      tradingName: $tradingName
    })
  }
`;

const MARK_VISIT_SUBMITTED_GQL = `
  mutation MarkPharmacyOnboardingVisitSubmitted($gphcNumber: String!, $submittedAt: Timestamp!) {
    pharmacyOnboardingVisit_update(key: { gphcNumber: $gphcNumber }, data: { submittedAt: $submittedAt })
  }
`;

const LIST_UNSUBMITTED_VISITS_GQL = `
  query ListUnsubmittedPharmacyOnboardingVisits($cutoff: Timestamp!, $limit: Int!) {
    pharmacyOnboardingVisits(
      where: { submittedAt: { isNull: true }, firstVisitAt: { lt: $cutoff } }
      limit: $limit
    ) {
      ${VISIT_FIELDS}
    }
  }
`;

const DELETE_VISIT_GQL = `
  mutation DeletePharmacyOnboardingVisit($gphcNumber: String!) {
    pharmacyOnboardingVisit_delete(key: { gphcNumber: $gphcNumber })
  }
`;

type RawVisit = Omit<PharmacyOnboardingVisitRecord, 'pharmsmartPharmacyId' | 'tradingName' | 'submittedAt'> & {
  pharmsmartPharmacyId?: string | null;
  tradingName?: string | null;
  submittedAt?: string | null;
};

function toVisit(row: RawVisit | null | undefined): PharmacyOnboardingVisitRecord | null {
  if (!row) return null;
  return {
    gphcNumber: row.gphcNumber,
    pharmsmartPharmacyId: row.pharmsmartPharmacyId ?? null,
    tradingName: row.tradingName ?? null,
    firstVisitAt: row.firstVisitAt,
    submittedAt: row.submittedAt ?? null,
  };
}

export class SqlPharmacyOnboardingVisitRepository implements PharmacyOnboardingVisitRepositoryPort {
  async findVisit(gphcNumber: string): Promise<PharmacyOnboardingVisitRecord | null> {
    const result = await dataConnect.executeGraphql<{ pharmacyOnboardingVisit: RawVisit | null }, { gphcNumber: string }>(
      VISIT_BY_GPHC_GQL,
      { variables: { gphcNumber } },
    );
    return toVisit(result.data.pharmacyOnboardingVisit);
  }

  async insertVisit(input: { gphcNumber: string; pharmsmartPharmacyId: string | null; tradingName: string | null }) {
    if (await this.findVisit(input.gphcNumber)) return { created: false };
    try {
      await dataConnect.executeGraphql(INSERT_VISIT_GQL, { variables: input });
      return { created: true };
    } catch (error) {
      // A second tab raced this one: the primary key let one through.
      if (await this.findVisit(input.gphcNumber)) return { created: false };
      throw error;
    }
  }

  async markSubmitted(gphcNumber: string, submittedAt: string): Promise<void> {
    await dataConnect.executeGraphql(MARK_VISIT_SUBMITTED_GQL, { variables: { gphcNumber, submittedAt } });
  }

  async listUnsubmittedBefore(cutoff: string, limit: number): Promise<PharmacyOnboardingVisitRecord[]> {
    const result = await dataConnect.executeGraphql<{ pharmacyOnboardingVisits: RawVisit[] }, { cutoff: string; limit: number }>(
      LIST_UNSUBMITTED_VISITS_GQL,
      { variables: { cutoff, limit } },
    );
    return (result.data.pharmacyOnboardingVisits ?? []).map(row => toVisit(row)!);
  }

  async deleteVisit(gphcNumber: string): Promise<void> {
    await dataConnect.executeGraphql(DELETE_VISIT_GQL, { variables: { gphcNumber } });
  }
}
