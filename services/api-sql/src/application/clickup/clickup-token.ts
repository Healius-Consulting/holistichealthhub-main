import { SecretManagerServiceClient } from '@google-cloud/secret-manager';
import { config } from '../../bootstrap/config.js';
import type { IntegrationConnectionRecord } from '../../repositories/ports/integration.port.js';

/**
 * The ClickUp API token lives in Secret Manager, named by the CLICKUP
 * IntegrationConnection (the board is HHH's, so the row sits on HHH's own
 * organisation). The secret is `hhh-clickup-…-europe-west2` in this project and
 * holds the token itself, or JSON `{ "token": "…" }`.
 */
export function allowedClickupSecretResource(name: string) {
  return name.startsWith(`projects/${config.FIREBASE_PROJECT_ID}/secrets/hhh-clickup`)
    && name.endsWith('-europe-west2');
}

export function clickupConnection(connections: IntegrationConnectionRecord[]) {
  return connections.find(connection => connection.integration === 'CLICKUP'
    && connection.status === 'ACTIVE'
    && connection.secretResourceName
    && allowedClickupSecretResource(connection.secretResourceName)) ?? null;
}

export function tokenFromSecret(raw: string | null | undefined): string | null {
  const text = raw?.trim();
  if (!text) return null;
  if (text.startsWith('{')) {
    try {
      const parsed = JSON.parse(text) as { token?: unknown };
      return typeof parsed.token === 'string' && parsed.token.trim() ? parsed.token.trim() : null;
    } catch {
      return null;
    }
  }
  return text;
}

let secretClient: SecretManagerServiceClient | null = null;

/** Null when there is no connection or the secret can't be read: the worker then waits. */
export async function readClickupToken(listConnections: () => Promise<IntegrationConnectionRecord[]>): Promise<string | null> {
  const connection = clickupConnection(await listConnections());
  if (!connection?.secretResourceName) return null;
  try {
    secretClient ??= new SecretManagerServiceClient();
    const [version] = await secretClient.accessSecretVersion({ name: `${connection.secretResourceName}/versions/latest` });
    return tokenFromSecret(version.payload?.data?.toString());
  } catch (error) {
    console.warn('ClickUp token could not be read', error instanceof Error ? error.message : 'unknown');
    return null;
  }
}
