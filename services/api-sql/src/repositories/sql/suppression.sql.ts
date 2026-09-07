import { dataConnect } from '../../bootstrap/firebase.js';
import { asUuid } from '../../domain/common/uuid.js';
import type { SuppressionRepositoryPort } from '../ports/suppression.port.js';

const UPSERT_SUPPRESSION_GQL = `
  mutation UpsertMarketingSuppression(
    $contactHash: String!
    $channel: String!
    $organisationId: UUID
    $reason: String!
  ) {
    marketingSuppression_upsert(data: {
      contactHash: $contactHash
      channel: $channel
      organisationId: $organisationId
      reason: $reason
    })
  }
`;

const GET_SUPPRESSION_GQL = `
  query GetMarketingSuppression($contactHash: String!) {
    marketingSuppression(key: { contactHash: $contactHash }) {
      contactHash
    }
  }
`;

export class SqlSuppressionRepository implements SuppressionRepositoryPort {
  async suppress(input: {
    contactHash: string;
    channel: 'EMAIL' | 'SMS';
    organisationId?: string | null;
    reason: string;
  }): Promise<void> {
    await dataConnect.executeGraphql(UPSERT_SUPPRESSION_GQL, {
      variables: {
        contactHash: input.contactHash,
        channel: input.channel,
        organisationId: input.organisationId ? asUuid(input.organisationId) : null,
        reason: input.reason,
      },
    });
  }

  async isSuppressed(contactHash: string): Promise<boolean> {
    const result = await dataConnect.executeGraphql<{
      marketingSuppression: { contactHash: string } | null;
    }, any>(GET_SUPPRESSION_GQL, { variables: { contactHash } });
    return Boolean(result.data.marketingSuppression);
  }
}
