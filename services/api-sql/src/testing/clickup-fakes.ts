import type {
  ClickupCardRecord,
  ClickupOutboxRecord,
  ClickupRepositoryPort,
  PharmacyOnboardingVisitRecord,
  PharmacyOnboardingVisitRepositoryPort,
} from '../repositories/ports/clickup.port.js';

/** In-memory ClickUp outbox and cards, for tests. */
export class FakeClickupRepository implements ClickupRepositoryPort {
  outbox: ClickupOutboxRecord[] = [];
  cards = new Map<string, ClickupCardRecord>();
  private clock = Date.parse('2026-11-18T09:00:00.000Z');

  async enqueue(input: Parameters<ClickupRepositoryPort['enqueue']>[0]) {
    if (this.outbox.some(row => row.idempotencyKey === input.idempotencyKey)) return { created: false };
    this.clock += 1_000;
    this.outbox.push({
      id: `outbox-${this.outbox.length + 1}`,
      ...input,
      status: 'PENDING',
      attemptCount: 0,
      nextAttemptAt: null,
      createdAt: new Date(this.clock).toISOString(),
    });
    return { created: true };
  }

  async listPending(limit: number) {
    return this.outbox
      .filter(row => row.status === 'PENDING')
      .sort((left, right) => left.createdAt.localeCompare(right.createdAt))
      .slice(0, limit)
      .map(row => ({ ...row }));
  }

  private row(id: string) {
    const row = this.outbox.find(item => item.id === id);
    if (!row) throw new Error(`No outbox row ${id}`);
    return row;
  }

  async markProcessing(id: string, attemptCount: number) {
    Object.assign(this.row(id), { status: 'PROCESSING', attemptCount });
  }

  async markSent(id: string) {
    this.row(id).status = 'SENT';
  }

  async markRetry(id: string, attemptCount: number, nextAttemptAt: string) {
    Object.assign(this.row(id), { status: 'PENDING', attemptCount, nextAttemptAt });
  }

  async markFailed(id: string, attemptCount: number) {
    Object.assign(this.row(id), { status: 'FAILED', attemptCount });
  }

  async findCard(keys: { gphcNumber: string; onboardingRequestId?: string | null; organisationId?: string | null }) {
    const cards = [...this.cards.values()];
    return this.cards.get(keys.gphcNumber)
      ?? cards.find(card => keys.onboardingRequestId && card.onboardingRequestId === keys.onboardingRequestId)
      ?? cards.find(card => keys.organisationId && card.organisationId === keys.organisationId)
      ?? null;
  }

  async saveCard(card: ClickupCardRecord) {
    this.cards.set(card.gphcNumber, { ...card });
  }
}

export class FakeVisitRepository implements PharmacyOnboardingVisitRepositoryPort {
  visits = new Map<string, PharmacyOnboardingVisitRecord>();
  firstVisitAt = '2026-11-18T09:00:00.000Z';

  async findVisit(gphcNumber: string) {
    return this.visits.get(gphcNumber) ?? null;
  }

  async insertVisit(input: { gphcNumber: string; pharmsmartPharmacyId: string | null; tradingName: string | null }) {
    if (this.visits.has(input.gphcNumber)) return { created: false };
    this.visits.set(input.gphcNumber, { ...input, firstVisitAt: this.firstVisitAt, submittedAt: null });
    return { created: true };
  }

  async markSubmitted(gphcNumber: string, submittedAt: string) {
    const visit = this.visits.get(gphcNumber);
    if (visit) visit.submittedAt = submittedAt;
  }

  async listUnsubmittedBefore(cutoff: string, limit: number) {
    return [...this.visits.values()]
      .filter(visit => !visit.submittedAt && visit.firstVisitAt < cutoff)
      .slice(0, limit);
  }

  async deleteVisit(gphcNumber: string) {
    this.visits.delete(gphcNumber);
  }
}
