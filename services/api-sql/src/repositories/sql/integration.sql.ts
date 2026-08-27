import { randomUUID } from 'node:crypto';
import { dataConnect } from '../../bootstrap/firebase.js';
import type {
  IntegrationConnectionRecord,
  IntegrationName,
  IntegrationRepositoryPort,
  RestoreIntegrationConnectionInput,
} from '../ports/integration.port.js';

const CONNECTION_FIELDS = `
  id organisationId integration environment status secretResourceName externalCustomerId
  maskedCredential validatedAt lastSuccessfulAt lastErrorCode version createdAt updatedAt
`;

const LIST_CONNECTIONS_GQL = `
  query ListIntegrationConnections {
    integrationConnections { ${CONNECTION_FIELDS} }
  }
`;

const FIND_CONNECTION_GQL = `
  query FindIntegrationConnection($organisationId: UUID!, $integration: IntegrationName!) {
    integrationConnections(
      where: { organisationId: { eq: $organisationId }, integration: { eq: $integration } }
      limit: 10
    ) { ${CONNECTION_FIELDS} }
  }
`;

const INSERT_CONNECTION_GQL = `
  mutation InsertIntegrationConnection(
    $id: UUID!
    $organisationId: UUID!
    $integration: IntegrationName!
    $environment: IntegrationEnvironment!
    $status: IntegrationStatus!
    $secretResourceName: String!
    $externalCustomerId: String
    $maskedCredential: String
  ) {
    integrationConnection_insert(data: {
      id: $id
      organisationId: $organisationId
      integration: $integration
      environment: $environment
      status: $status
      secretResourceName: $secretResourceName
      externalCustomerId: $externalCustomerId
      maskedCredential: $maskedCredential
    })
  }
`;

const UPDATE_CONNECTION_GQL = `
  mutation UpdateIntegrationConnection(
    $id: UUID!
    $status: IntegrationStatus!
    $secretResourceName: String!
    $externalCustomerId: String
    $maskedCredential: String
    $version: Int!
  ) {
    integrationConnection_update(
      key: { id: $id }
      data: {
        status: $status
        secretResourceName: $secretResourceName
        externalCustomerId: $externalCustomerId
        maskedCredential: $maskedCredential
        version: $version
        updatedAt_expr: "request.time"
      }
    )
  }
`;

/*
 * Records that the vendor answered. `lastErrorCode` and `consecutiveFailures`
 * are cleared in the same write: a call that succeeded now makes an older
 * failure history misleading rather than informative.
 */
const RECORD_SUCCESS_GQL = `
  mutation RecordIntegrationSuccess($id: UUID!) {
    integrationConnection_update(
      key: { id: $id }
      data: {
        lastSuccessfulAt_expr: "request.time"
        lastErrorCode: null
        consecutiveFailures: 0
        updatedAt_expr: "request.time"
      }
    )
  }
`;

export class SqlIntegrationRepository implements IntegrationRepositoryPort {
  async listConnections(): Promise<IntegrationConnectionRecord[]> {
    const result = await dataConnect.executeGraphql<{ integrationConnections: IntegrationConnectionRecord[] }, any>(
      LIST_CONNECTIONS_GQL,
    );
    return result.data.integrationConnections ?? [];
  }

  async findConnection(organisationId: string, integration: IntegrationName): Promise<IntegrationConnectionRecord | null> {
    const result = await dataConnect.executeGraphql<{ integrationConnections: IntegrationConnectionRecord[] }, any>(
      FIND_CONNECTION_GQL,
      { variables: { organisationId, integration } },
    );
    const connections = result.data.integrationConnections ?? [];
    return connections.find(connection => connection.status === 'ACTIVE')
      ?? connections.find(connection => connection.status === 'PENDING_VALIDATION')
      ?? connections[0]
      ?? null;
  }

  async restoreConnection(input: RestoreIntegrationConnectionInput): Promise<IntegrationConnectionRecord> {
    const existing = await this.findConnection(input.organisationId, input.integration);
    if (existing) {
      await dataConnect.executeGraphql(UPDATE_CONNECTION_GQL, {
        variables: {
          id: existing.id,
          status: input.status,
          secretResourceName: input.secretResourceName,
          externalCustomerId: input.externalCustomerId,
          maskedCredential: input.maskedCredential,
          version: existing.version + 1,
        },
      });
    } else {
      await dataConnect.executeGraphql(INSERT_CONNECTION_GQL, {
        variables: { id: randomUUID(), ...input },
      });
    }
    const restored = await this.findConnection(input.organisationId, input.integration);
    if (!restored) throw new Error('Integration connection could not be verified after restoration.');
    return restored;
  }

  async recordSuccessfulCall(organisationId: string, integration: IntegrationName): Promise<void> {
    const existing = await this.findConnection(organisationId, integration);
    if (!existing) return;
    await dataConnect.executeGraphql(RECORD_SUCCESS_GQL, { variables: { id: existing.id } });
  }
}
