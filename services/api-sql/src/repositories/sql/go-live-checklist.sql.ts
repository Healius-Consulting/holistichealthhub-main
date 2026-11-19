import { SqlWorldpayApplicationRepository } from './worldpay-application.sql.js';
import { dataConnect } from '../../bootstrap/firebase.js';
import { asUuid } from '../../domain/common/uuid.js';
import { checklistItemId, type ChecklistTickRecord } from '../../domain/organisation/go-live-checklist.js';

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

/**
 * One row per branch and item (unique on both), so a tick or untick replaces the last one.
 * The upsert matches on the table key, so it carries the row's fixed id (see checklistItemId).
 */
const UPSERT_TICK_GQL = `
  mutation UpsertOrganisationChecklistItem(
    $id: UUID!
    $organisationId: UUID!
    $itemKey: String!
    $status: String!
    $tickedByUid: String
    $tickedAt: Timestamp
  ) {
    organisationChecklistItem_upsert(data: {
      id: $id
      organisationId: $organisationId
      itemKey: $itemKey
      status: $status
      tickedByUid: $tickedByUid
      tickedAt: $tickedAt
    })
  }
`;

const TERMS_FOR_DOCUMENT_GQL = `
  query PartnerTermsSignedForOrganisation($organisationId: UUID!, $documentId: UUID!) {
    partnerTermsAcceptances(
      where: { organisationId: { eq: $organisationId }, documentId: { eq: $documentId } }
      orderBy: [{ acceptedAt: ASC }]
      limit: 1
    ) {
      acceptedAt
    }
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
    await dataConnect.executeGraphql<unknown, ChecklistTickRecord & { id: string }>(UPSERT_TICK_GQL, {
      variables: { ...tick, id: checklistItemId(tick.organisationId, tick.itemKey), organisationId: asUuid(tick.organisationId) },
    });
  }

  /** When this branch signed the given Terms version; without one, its first acceptance of any version. */
  async termsAcceptedAt(organisationId: string, documentId?: string | null): Promise<string | null> {
    const result = documentId
      ? await dataConnect.executeGraphql<{ partnerTermsAcceptances: Array<{ acceptedAt: string }> }, { organisationId: string; documentId: string }>(
        TERMS_FOR_DOCUMENT_GQL,
        { variables: { organisationId: asUuid(organisationId), documentId: asUuid(documentId) } },
      )
      : await dataConnect.executeGraphql<{ partnerTermsAcceptances: Array<{ acceptedAt: string }> }, { organisationId: string }>(
        TERMS_FOR_ORGANISATION_GQL,
        { variables: { organisationId: asUuid(organisationId) } },
      );
    return result.data.partnerTermsAcceptances?.[0]?.acceptedAt ?? null;
  }

  /**
   * When this branch started with Worldpay: the latest old-form note for this GPhC
   * (stored compact, as that form writes it), or its Worldpay application once
   * submitted, or once it said it already takes online payments with Worldpay
   * (spec G-01). From then the checklist shows "Worldpay credentials validated".
   */
  async worldpayFormSubmittedAt(compactGphc: string, organisationId?: string): Promise<string | null> {
    const [result, application] = await Promise.all([
      dataConnect.executeGraphql<{ pharmacyWorldpaySubmissions: Array<{ submittedAt: string }> }, { gphcNumber: string }>(
        WORLDPAY_FORM_FOR_GPHC_GQL,
        { variables: { gphcNumber: compactGphc } },
      ),
      organisationId ? new SqlWorldpayApplicationRepository().findForOrganisation(organisationId).catch(() => null) : Promise.resolve(null),
    ]);
    const note = result.data.pharmacyWorldpaySubmissions?.[0]?.submittedAt ?? null;
    const applied = application?.submittedAt
      ?? (application?.status === 'DRAFT' && application.answers.existingAccount === 'online' ? application.updatedAt : null);
    return [note, applied].filter((value): value is string => Boolean(value)).sort().at(-1) ?? null;
  }
}
