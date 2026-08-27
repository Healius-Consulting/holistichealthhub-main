export type IntegrationName = 'CURALEAF' | 'WORLDPAY';
export type IntegrationEnvironment = 'TEST' | 'PRODUCTION';
export type IntegrationStatus = 'DISCONNECTED' | 'PENDING_VALIDATION' | 'ACTIVE' | 'PAUSED' | 'ERROR';

export interface IntegrationConnectionRecord {
  id: string;
  organisationId: string;
  integration: IntegrationName;
  environment: IntegrationEnvironment;
  status: IntegrationStatus;
  secretResourceName: string | null;
  externalCustomerId: string | null;
  maskedCredential: string | null;
  validatedAt: string | null;
  lastSuccessfulAt: string | null;
  lastErrorCode: string | null;
  version: number;
  createdAt: string;
  updatedAt: string;
}

export interface RestoreIntegrationConnectionInput {
  organisationId: string;
  integration: IntegrationName;
  environment: IntegrationEnvironment;
  status: IntegrationStatus;
  secretResourceName: string;
  externalCustomerId: string | null;
  maskedCredential: string | null;
}

export interface IntegrationRepositoryPort {
  listConnections(): Promise<IntegrationConnectionRecord[]>;
  findConnection(organisationId: string, integration: IntegrationName): Promise<IntegrationConnectionRecord | null>;
  restoreConnection(input: RestoreIntegrationConnectionInput): Promise<IntegrationConnectionRecord>;
  /**
   * Stamp `lastSuccessfulAt` because the vendor just answered a real call.
   *
   * This is the only thing the Overview's integration chips accept as evidence
   * that an integration works — stored credentials are not evidence — so every
   * successful call to Curaleaf or Worldpay has to come through here or the
   * pharmacy is told the supply chain is unverified while it is plainly working.
   */
  recordSuccessfulCall(organisationId: string, integration: IntegrationName): Promise<void>;
}
