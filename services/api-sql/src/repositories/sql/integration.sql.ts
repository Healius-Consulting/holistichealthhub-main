import { randomUUID } from 'node:crypto';
import { dataConnect } from '../../bootstrap/firebase.js';
import { HttpError } from '../../domain/common/errors.js';
import type {
  IntegrationConnectionRecord,
  IntegrationEnvironment,
  IntegrationName,
  IntegrationRepositoryPort,
  IntegrationStatus,
  RestoreIntegrationConnectionInput,
} from '../ports/integration.port.js';
import { planConnectionRestore, preferIntegrationConnection } from './connection-restore.js';

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
    $environment: IntegrationEnvironment!
    $status: IntegrationStatus!
    $secretResourceName: String!
    $externalCustomerId: String
    $maskedCredential: String
    $version: Int!
  ) {
    integrationConnection_update(
      key: { id: $id }
      data: {
        environment: $environment
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

  private async connectionsFor(organisationId: string, integration: IntegrationName) {
    const result = await dataConnect.executeGraphql<{ integrationConnections: IntegrationConnectionRecord[] }, any>(
      FIND_CONNECTION_GQL,
      { variables: { organisationId, integration } },
    );
    return result.data.integrationConnections ?? [];
  }

  async findConnection(organisationId: string, integration: IntegrationName): Promise<IntegrationConnectionRecord | null> {
    return preferIntegrationConnection(await this.connectionsFor(organisationId, integration));
  }

  private async updateConnection(input: {
    id: string;
    environment: IntegrationEnvironment;
    status: IntegrationStatus;
    secretResourceName: string;
    externalCustomerId: string | null;
    maskedCredential: string | null;
    version: number;
  }) {
    await dataConnect.executeGraphql(UPDATE_CONNECTION_GQL, { variables: input });
  }

  async restoreConnection(input: RestoreIntegrationConnectionInput): Promise<IntegrationConnectionRecord> {
    const rows = await this.connectionsFor(input.organisationId, input.integration);
    const plan = planConnectionRestore(rows, input.environment);
    const writtenId = plan.update?.id ?? randomUUID();
    try {
      if (plan.update) {
        await this.updateConnection({
          id: plan.update.id,
          environment: input.environment,
          status: input.status,
          secretResourceName: input.secretResourceName,
          externalCustomerId: input.externalCustomerId,
          maskedCredential: input.maskedCredential,
          version: plan.update.version,
        });
      } else {
        await dataConnect.executeGraphql(INSERT_CONNECTION_GQL, {
          variables: { id: writtenId, ...input },
        });
      }
      for (const staleId of plan.disconnectIds) {
        const stale = rows.find(row => row.id === staleId);
        if (!stale) continue;
        await this.updateConnection({
          id: stale.id,
          environment: stale.environment,
          status: 'DISCONNECTED',
          secretResourceName: stale.secretResourceName || input.secretResourceName,
          externalCustomerId: stale.externalCustomerId,
          maskedCredential: stale.maskedCredential,
          version: Number(stale.version) + 1,
        });
      }
    } catch (error) {
      if (error instanceof HttpError) throw error;
      console.error('Integration connection could not be saved', error);
      throw new HttpError(503, 'The connection could not be saved. Try again.', 'INTEGRATION_SAVE_FAILED');
    }
    const restored = (await this.connectionsFor(input.organisationId, input.integration))
      .find(row => row.id === writtenId);
    if (!restored) {
      throw new HttpError(503, 'The connection could not be confirmed after saving.', 'INTEGRATION_SAVE_FAILED');
    }
    return restored;
  }

  async recordSuccessfulCall(organisationId: string, integration: IntegrationName): Promise<void> {
    const existing = await this.findConnection(organisationId, integration);
    if (!existing) return;
    await dataConnect.executeGraphql(RECORD_SUCCESS_GQL, { variables: { id: existing.id } });
  }
}
