import { dataConnect } from '../../bootstrap/firebase.js';
import { asUuid } from '../../domain/common/uuid.js';
import type { ChecklistTickRecord } from '../../domain/organisation/go-live-checklist.js';

const LIST_TICKS_GQL = `
  query ListOrganisationChecklistItems($organisationId: UUID!) {
    organisationChecklistItems(where: { organisationId: { eq: $organisationId } }, limit: 100) {
      organisationId
      itemKey
      status
      tickedByUid
      tickedAt
    }
  }
`;

/** One row per branch and item (unique on both), so a tick or untick replaces the last one. */
const UPSERT_TICK_GQL = `
  mutation UpsertOrganisationChecklistItem(
    $organisationId: UUID!
    $itemKey: String!
    $status: String!
    $tickedByUid: String
    $tickedAt: Timestamp
  ) {
    organisationChecklistItem_upsert(data: {
      organisationId: $organisationId
      itemKey: $itemKey
      status: $status
      tickedByUid: $tickedByUid
      tickedAt: $tickedAt
    })
  }
`;

const TERMS_FOR_ORGANISATION_GQL = `
  query PartnerTermsAcceptedForOrganisation($organisationId: UUID!) {
    partnerTermsAcceptances(
      where: { organisationId: { eq: $organisationId } }
      orderBy: [{ acceptedAt: ASC }]
      limit: 1
    ) {
      acceptedAt
    }
  }
`;

const WORLDPAY_FORM_FOR_GPHC_GQL = `
  query WorldpayFormSubmittedForGphc($gphcNumber: String!) {
    pharmacyWorldpaySubmissions(
      where: { gphcNumber: { eq: $gphcNumber } }
      orderBy: [{ submittedAt: DESC }]
      limit: 1
    ) {
      submittedAt
    }
  }
`;

type RawTick = Omit<ChecklistTickRecord, 'status'> & { status: string };

export class SqlGoLiveChecklistRepository {
  async listTicks(organisationId: string): Promise<ChecklistTickRecord[]> {
    const result = await dataConnect.executeGraphql<{ organisationChecklistItems: RawTick[] }, { organisationId: string }>(
      LIST_TICKS_GQL,
      { variables: { organisationId: asUuid(organisationId) } },
    );
    return (result.data.organisationChecklistItems ?? []).map(row => ({
      organisationId: row.organisationId,
      itemKey: row.itemKey,
      status: row.status === 'DONE' ? 'DONE' : 'OPEN',
      tickedByUid: row.tickedByUid ?? null,
      tickedAt: row.tickedAt ?? null,
    }));
  }

  async saveTick(tick: ChecklistTickRecord): Promise<void> {
    await dataConnect.executeGraphql<unknown, ChecklistTickRecord>(UPSERT_TICK_GQL, {
      variables: { ...tick, organisationId: asUuid(tick.organisationId) },
    });
  }

  /** The first Partner Terms acceptance Activate linked to this branch. */
  async termsAcceptedAt(organisationId: string): Promise<string | null> {
    const result = await dataConnect.executeGraphql<{ partnerTermsAcceptances: Array<{ acceptedAt: string }> }, { organisationId: string }>(
      TERMS_FOR_ORGANISATION_GQL,
      { variables: { organisationId: asUuid(organisationId) } },
    );
    return result.data.partnerTermsAcceptances?.[0]?.acceptedAt ?? null;
  }

  /** The latest Worldpay form note for this GPhC (stored compact, as the form writes it). */
  async worldpayFormSubmittedAt(compactGphc: string): Promise<string | null> {
    const result = await dataConnect.executeGraphql<{ pharmacyWorldpaySubmissions: Array<{ submittedAt: string }> }, { gphcNumber: string }>(
      WORLDPAY_FORM_FOR_GPHC_GQL,
      { variables: { gphcNumber: compactGphc } },
    );
    return result.data.pharmacyWorldpaySubmissions?.[0]?.submittedAt ?? null;
  }
}
