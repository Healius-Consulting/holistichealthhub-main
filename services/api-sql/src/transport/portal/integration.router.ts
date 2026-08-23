import { Router, type NextFunction, type Request, type Response } from 'express';
import { z } from 'zod';
import { HttpError } from '../../domain/common/errors.js';
import { fetchCuraleafCatalogue, fetchCuraleafQuote, maskCuraleafIdentifier, probeCuraleafConnection, scanClinicPrescriptionFromStoredFile, validateCuraleafCredentials, writeCuraleafCredential } from '../../application/integrations/curaleaf.service.js';
import {
  mergeQuoteBankIntoCatalogue,
  upsertCuraleafQuoteBankFromQuote,
} from '../../application/integrations/curaleaf-quote-bank.service.js';
import {
  maskWorldpayIdentifier,
  readStoredWorldpayCredential,
  revokeWorldpayCredential,
  updateStoredWorldpayCustomisation,
  validateWorldpayCredentials,
  writeWorldpayCredential,
  type WorldpayCredential,
} from '../../application/integrations/worldpay.service.js';
import type { IntegrationConnectionRecord, IntegrationName } from '../../repositories/ports/integration.port.js';
import { SqlCuraleafQuoteBankRepository } from '../../repositories/sql/curaleaf-quote-bank.sql.js';
import { SqlIntegrationRepository } from '../../repositories/sql/integration.sql.js';
import { SqlOrganisationRepository } from '../../repositories/sql/organisation.sql.js';
import { requireCsrf } from '../../security/csrf.js';
import { requireStaff } from '../../security/require-staff.js';
import type { RequestContext } from '../../security/request-context.js';

const organisationIdSchema = z.string().regex(/^(?:[0-9a-f]{32}|[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})$/i);

function compact(value: string) {
  return value.toLowerCase().replaceAll('-', '');
}

export async function authorisedOrganisationId(
  context: RequestContext | undefined,
  requested: unknown,
  organisationRepo: SqlOrganisationRepository,
) {
  if (!context || context.kind === 'public') throw new HttpError(401, 'A valid staff session is required.', 'UNAUTHENTICATED');
  if (context.kind === 'tenant') {
    if (requested && compact(String(requested)) !== compact(context.organisationId)) {
      throw new HttpError(403, 'Cross-pharmacy access is not permitted.', 'TENANT_SCOPE_VIOLATION');
    }
    return context.organisationId;
  }
  const organisationId = organisationIdSchema.parse(requested);
  if (!await organisationRepo.findOrganisationById(organisationId)) {
    throw new HttpError(404, 'Pharmacy record not found.', 'NOT_FOUND');
  }
  return organisationId;
}

const customisationIdSchema = z.string().trim().max(64).regex(/^[A-Za-z0-9_-]*$/);
const worldpayCredentialSchema = z.object({
  organisationId: z.string().optional(),
  username: z.string().trim().min(1).max(500),
  password: z.string().min(8).max(1_000),
  entityId: z.string().trim().min(1).max(200),
  customisationId: customisationIdSchema.optional(),
});
const curaleafCredentialSchema = z.object({
  organisationId: z.string().optional(),
  customerId: z.string().trim().min(1).max(128),
  apiKey: z.string().trim().min(16).max(500).optional(),
  writeApiKey: z.string().trim().min(16).max(500).optional(),
}).refine(value => Boolean(value.apiKey || value.writeApiKey), { message: 'API key is required.', path: ['apiKey'] });
const curaleafOrganisationSchema = z.object({
  organisationId: z.string().optional(),
});
const curaleafScanSchema = z.object({
  organisationId: z.string().optional(),
  fileId: organisationIdSchema,
}).strict();
const worldpayBrandingSchema = z.object({
  organisationId: z.string().optional(),
  customisationId: customisationIdSchema.optional(),
});

function worldpayEnvironmentFromValidation(environment: 'try' | 'live'): 'TEST' | 'PRODUCTION' {
  return environment === 'live' ? 'PRODUCTION' : 'TEST';
}

function curaleafStatusPayload(
  connection: IntegrationConnectionRecord | null,
  extras?: { message?: string; checkedAt?: string },
) {
  const configured = Boolean(connection?.secretResourceName);
  const connected = connection?.status === 'ACTIVE';
  return {
    configured,
    connected,
    status: !configured ? 'not_configured' as const : connected ? 'connected' as const : connection?.status === 'PENDING_VALIDATION' ? 'validated' as const : 'attention' as const,
    environment: connection?.environment === 'PRODUCTION' ? 'production' as const : 'test' as const,
    checkedAt: extras?.checkedAt ?? new Date().toISOString(),
    message: extras?.message ?? (!configured
      ? 'Curaleaf is not connected for this pharmacy.'
      : connected
        ? 'The existing Curaleaf credential is securely linked.'
        : 'The existing Curaleaf credential is securely linked and awaiting re-validation.'),
    maskedIdentifier: connection?.maskedCredential ?? undefined,
    customerId: connection?.externalCustomerId ?? undefined,
  };
}

async function worldpayConnectionStatus(
  connection: IntegrationConnectionRecord | null,
  organisationId: string,
) {
  const disconnected = !connection || connection.status === 'DISCONNECTED';
  const configured = !disconnected && Boolean(connection?.secretResourceName);
  const connected = connection?.status === 'ACTIVE';
  const stored = configured ? await readStoredWorldpayCredential(connection, organisationId) : null;
  return {
    configured,
    connected,
    status: disconnected || !configured ? 'verification_required' as const : connected ? 'connected' as const : 'attention' as const,
    maskedIdentifier: connection?.maskedCredential ?? undefined,
    brandingConfigured: Boolean(stored?.customisationId),
    updatedAt: connection?.updatedAt,
    validation: connected && connection?.externalCustomerId ? {
      passed: true as const,
      checkedAt: connection.updatedAt,
      environment: connection.environment === 'PRODUCTION' ? 'live' as const : 'try' as const,
      entityId: connection.maskedCredential ?? '',
    } : null,
  };
}

export function createPortalIntegrationRouter(): Router {
  const router = Router();
  const integrationRepo = new SqlIntegrationRepository();
  const quoteBankRepo = new SqlCuraleafQuoteBankRepository();
  const organisationRepo = new SqlOrganisationRepository();

  const status = (integration: IntegrationName) => async (req: Request, res: Response, next: NextFunction) => {
    try {
      const organisationId = await authorisedOrganisationId(req.context, req.query.organisationId, organisationRepo);
      const connection = await integrationRepo.findConnection(organisationId, integration);
      res.setHeader('Cache-Control', 'no-store');
      if (integration === 'CURALEAF') {
        res.status(200).json(curaleafStatusPayload(connection));
        return;
      }
      res.status(200).json(await worldpayConnectionStatus(connection, organisationId));
    } catch (error) { next(error); }
  };

  router.get('/portal/integrations/curaleaf/status', requireStaff('any'), status('CURALEAF'));
  router.get('/portal/integrations/worldpay/status', requireStaff('any'), status('WORLDPAY'));

  router.put('/portal/integrations/curaleaf/credentials', requireCsrf, requireStaff('admin'), async (req: Request, res: Response, next: NextFunction) => {
    try {
      const input = curaleafCredentialSchema.parse(req.body);
      const organisationId = await authorisedOrganisationId(req.context, input.organisationId, organisationRepo);
      const apiKey = (input.apiKey ?? input.writeApiKey)!;
      const credential = {
        customerId: input.customerId,
        writeApiKey: apiKey,
      };
      const validation = await validateCuraleafCredentials(credential);
      const existing = await integrationRepo.findConnection(organisationId, 'CURALEAF');
      const secretResourceName = await writeCuraleafCredential(organisationId, credential, existing?.secretResourceName);
      const restored = await integrationRepo.restoreConnection({
        organisationId,
        integration: 'CURALEAF',
        environment: validation.environment === 'production' ? 'PRODUCTION' : 'TEST',
        status: 'ACTIVE',
        secretResourceName,
        externalCustomerId: credential.customerId,
        maskedCredential: maskCuraleafIdentifier(credential.customerId),
      });
      res.status(200).json(curaleafStatusPayload(restored, {
        message: validation.message,
        checkedAt: validation.checkedAt,
      }));
    } catch (error) { next(error); }
  });

  router.post('/portal/integrations/curaleaf/refresh', requireCsrf, requireStaff('admin'), async (req: Request, res: Response, next: NextFunction) => {
    try {
      const input = curaleafOrganisationSchema.parse(req.body ?? {});
      const organisationId = await authorisedOrganisationId(req.context, input.organisationId, organisationRepo);
      const connection = await integrationRepo.findConnection(organisationId, 'CURALEAF');
      if (!connection?.secretResourceName) {
        res.status(200).json(curaleafStatusPayload(connection, {
          message: 'Curaleaf is not connected for this pharmacy.',
        }));
        return;
      }
      const probe = await probeCuraleafConnection(connection);
      const restored = await integrationRepo.restoreConnection({
        organisationId,
        integration: 'CURALEAF',
        environment: probe.environment === 'production' ? 'PRODUCTION' : 'TEST',
        status: 'ACTIVE',
        secretResourceName: connection.secretResourceName,
        externalCustomerId: connection.externalCustomerId,
        maskedCredential: connection.maskedCredential,
      });
      res.status(200).json(curaleafStatusPayload(restored, {
        message: probe.message,
        checkedAt: probe.checkedAt,
      }));
    } catch (error) { next(error); }
  });

  router.put('/portal/integrations/worldpay/credentials', requireCsrf, requireStaff('any'), async (req: Request, res: Response, next: NextFunction) => {
    try {
      const input = worldpayCredentialSchema.parse(req.body);
      const organisationId = await authorisedOrganisationId(req.context, input.organisationId, organisationRepo);
      const credential: WorldpayCredential = {
        username: input.username,
        password: input.password,
        entityId: input.entityId,
        ...(input.customisationId ? { customisationId: input.customisationId } : {}),
      };
      const existing = await integrationRepo.findConnection(organisationId, 'WORLDPAY');
      if (!credential.customisationId) {
        const stored = await readStoredWorldpayCredential(existing, organisationId);
        if (stored?.customisationId) credential.customisationId = stored.customisationId;
      }
      const validation = await validateWorldpayCredentials(credential);
      const secretResourceName = await writeWorldpayCredential(organisationId, credential, existing?.secretResourceName);
      const restored = await integrationRepo.restoreConnection({
        organisationId,
        integration: 'WORLDPAY',
        environment: worldpayEnvironmentFromValidation(validation.environment),
        status: 'ACTIVE',
        secretResourceName,
        externalCustomerId: credential.entityId,
        maskedCredential: maskWorldpayIdentifier(credential.entityId),
      });
      res.status(200).json(await worldpayConnectionStatus(restored, organisationId));
    } catch (error) { next(error); }
  });

  router.patch('/portal/integrations/worldpay/credentials', requireCsrf, requireStaff('any'), async (req: Request, res: Response, next: NextFunction) => {
    try {
      const input = worldpayBrandingSchema.parse(req.body);
      const organisationId = await authorisedOrganisationId(req.context, input.organisationId, organisationRepo);
      const existing = await integrationRepo.findConnection(organisationId, 'WORLDPAY');
      if (!existing || existing.status === 'DISCONNECTED') {
        throw new HttpError(404, 'Worldpay is not connected for this pharmacy.', 'INTEGRATION_NOT_CONNECTED');
      }
      const customisationId = input.customisationId?.trim() || undefined;
      const updated = await updateStoredWorldpayCustomisation(existing, organisationId, customisationId);
      const restored = await integrationRepo.restoreConnection({
        organisationId,
        integration: 'WORLDPAY',
        environment: existing.environment,
        status: 'ACTIVE',
        secretResourceName: updated.resourceName,
        externalCustomerId: existing.externalCustomerId,
        maskedCredential: existing.maskedCredential,
      });
      res.status(200).json(await worldpayConnectionStatus(restored, organisationId));
    } catch (error) { next(error); }
  });

  router.delete('/portal/integrations/worldpay/credentials', requireCsrf, requireStaff('any'), async (req: Request, res: Response, next: NextFunction) => {
    try {
      const organisationId = await authorisedOrganisationId(req.context, req.body?.organisationId ?? req.query.organisationId, organisationRepo);
      const existing = await integrationRepo.findConnection(organisationId, 'WORLDPAY');
      if (!existing || existing.status === 'DISCONNECTED') {
        res.status(200).json(await worldpayConnectionStatus(existing, organisationId));
        return;
      }
      await revokeWorldpayCredential(existing.secretResourceName);
      const restored = await integrationRepo.restoreConnection({
        organisationId,
        integration: 'WORLDPAY',
        environment: existing.environment,
        status: 'DISCONNECTED',
        secretResourceName: existing.secretResourceName || `projects/${organisationId}/secrets/hhh-worldpay-revoked`,
        externalCustomerId: null,
        maskedCredential: null,
      });
      res.status(200).json(await worldpayConnectionStatus(restored, organisationId));
    } catch (error) { next(error); }
  });

  async function requireCuraleafConnection(context: RequestContext | undefined, requestedOrganisationId: unknown) {
    const organisationId = await authorisedOrganisationId(context, requestedOrganisationId, organisationRepo);
    const connection = await integrationRepo.findConnection(organisationId, 'CURALEAF');
    if (!connection?.secretResourceName) {
      throw new HttpError(503, 'Curaleaf is not connected for this pharmacy.', 'INTEGRATION_NOT_CONNECTED');
    }
    return { organisationId, connection };
  }

  router.get('/portal/integrations/curaleaf/catalog', requireStaff('any'), async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { connection } = await requireCuraleafConnection(req.context, req.query.organisationId);
      const catalogue = await fetchCuraleafCatalogue(connection);
      const quoteBank = await quoteBankRepo.listEntries(connection.environment);
      res.setHeader('Cache-Control', 'private, max-age=300');
      res.status(200).json(mergeQuoteBankIntoCatalogue(
        catalogue as { products: Array<Record<string, unknown>>; fetchedAt: string; [key: string]: unknown },
        quoteBank,
      ));
    } catch (error) { next(error); }
  });

  router.post('/portal/integrations/curaleaf/quote', requireCsrf, requireStaff('any'), async (req: Request, res: Response, next: NextFunction) => {
    try {
      const input = z.object({
        organisationId: z.string().optional(),
        items: z.array(z.object({
          packId: z.string(),
          quantity: z.number().int().positive().max(100),
        })).min(1),
      }).parse(req.body);

      const { connection } = await requireCuraleafConnection(req.context, input.organisationId);
      const quote = await fetchCuraleafQuote(connection, input.items);
      try {
        await upsertCuraleafQuoteBankFromQuote(connection, quote, 'LIVE_QUOTE', quoteBankRepo);
      } catch (error) {
        console.warn('[Curaleaf] Quote bank upsert failed after live quote:', error);
      }
      res.status(200).json(quote);
    } catch (error) { next(error); }
  });

  router.post('/portal/integrations/curaleaf/prescriptions/scan', requireCsrf, requireStaff('any'), async (req: Request, res: Response, next: NextFunction) => {
    try {
      const input = curaleafScanSchema.parse(req.body);
      const { organisationId, connection } = await requireCuraleafConnection(req.context, input.organisationId);
      const result = await scanClinicPrescriptionFromStoredFile(connection, organisationId, input.fileId);
      res.setHeader('Cache-Control', 'no-store');
      res.status(result.status === 'processing' ? 202 : 200).json(result);
    } catch (error) { next(error); }
  });

  return router;
}
