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
  revokeWorldpayCredential,
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

const worldpayCredentialSchema = z.object({
  organisationId: z.string().optional(),
  username: z.string().trim().min(1).max(500),
  password: z.string().min(8).max(1_000),
  entityId: z.string().trim().min(1).max(200),
});
const curaleafCredentialSchema = z.object({
  organisationId: z.string().optional(),
  customerId: z.string().trim().min(1).max(128),
  apiKey: z.string().trim().min(16).max(500).optional(),
  writeApiKey: z.string().trim().min(16).max(500).optional(),
  // Optional. Left out, the estate is discovered from whichever host accepts
  // the key, so a sandbox pharmacy and a live one can be connected side by side.
  environment: z.enum(['TEST', 'PRODUCTION']).optional(),
}).refine(value => Boolean(value.apiKey || value.writeApiKey), { message: 'API key is required.', path: ['apiKey'] });
const curaleafOrganisationSchema = z.object({
  organisationId: z.string().optional(),
});
const curaleafScanSchema = z.object({
  organisationId: z.string().optional(),
  fileId: organisationIdSchema,
}).strict();
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
    // A plain status read is not a check. Stamping "now" here made every screen that
    // showed checkedAt claim the credential had just been confirmed against Curaleaf.
    // Only a probe or a validation supplies a timestamp; otherwise report the last
    // real success, or null when there has never been one.
    checkedAt: extras?.checkedAt ?? connection?.lastSuccessfulAt ?? null,
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
  return {
    configured,
    connected,
    status: disconnected || !configured ? 'verification_required' as const : connected ? 'connected' as const : 'attention' as const,
    environment: connection?.environment === 'PRODUCTION' ? 'live' as const : 'try' as const,
    maskedIdentifier: connection?.maskedCredential ?? undefined,
    updatedAt: connection?.updatedAt,
  };
}

export function createPortalIntegrationRouter(): Router {
  const router = Router();
  const integrationRepo = new SqlIntegrationRepository();

  /**
   * The vendor answered, so the Overview may now say so.
   *
   * Deliberately fire-and-forget: this is health bookkeeping, and a failure to
   * write it must never turn a successful catalogue fetch or quote into an error
   * for the pharmacy. A missed stamp costs one stale chip until the next call.
   */
  function noteVendorSuccess(organisationId: string, integration: IntegrationName) {
    void integrationRepo.recordSuccessfulCall(organisationId, integration).catch(error => {
      console.warn(`Could not record ${integration} success for ${organisationId}:`, error);
    });
  }
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
      const existing = await integrationRepo.findConnection(organisationId, 'CURALEAF');
      const validation = await validateCuraleafCredentials(credential, input.environment ?? null);
      const secretResourceName = await writeCuraleafCredential(organisationId, credential, existing?.secretResourceName);
      const restored = await integrationRepo.restoreConnection({
        organisationId,
        integration: 'CURALEAF',
        environment: validation.connectionEnvironment,
        status: 'ACTIVE',
        secretResourceName,
        externalCustomerId: credential.customerId,
        maskedCredential: maskCuraleafIdentifier(credential.customerId),
      });
      // Validation is a real call to Curaleaf that came back, which is exactly
      // the evidence the Overview chip is asking for.
      noteVendorSuccess(organisationId, 'CURALEAF');
      res.status(200).json(curaleafStatusPayload(restored, {
        message: validation.message,
        checkedAt: validation.checkedAt,
      }));
    } catch (error) { next(error); }
  });

  // Pharmacy-safe: this re-probes the credential already on file for the caller's own
  // tenant and records the result. It never accepts, returns or rewrites a secret, so
  // pharmacy staff may run it to clear a stale connection without an HHH admin.
  router.post('/portal/integrations/curaleaf/refresh', requireCsrf, requireStaff('any'), async (req: Request, res: Response, next: NextFunction) => {
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
      noteVendorSuccess(organisationId, 'CURALEAF');
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
      };
      const existing = await integrationRepo.findConnection(organisationId, 'WORLDPAY');
      const validation = await validateWorldpayCredentials(credential);
      noteVendorSuccess(organisationId, 'WORLDPAY');
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
      const { organisationId, connection } = await requireCuraleafConnection(req.context, req.query.organisationId);
      const catalogue = await fetchCuraleafCatalogue(connection);
      noteVendorSuccess(organisationId, 'CURALEAF');
      const quoteBank = await quoteBankRepo.listEntries(connection.environment);
      // Deliberately shorter than the portal's fifteen-minute catalogue window:
      // the client decides when a catalogue is stale, and this header must always
      // have expired by then so that decision actually reaches Curaleaf. A staff
      // refresh steps around it entirely with a cache-busting query parameter.
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

      const { organisationId, connection } = await requireCuraleafConnection(req.context, input.organisationId);
      const quote = await fetchCuraleafQuote(connection, input.items);
      noteVendorSuccess(organisationId, 'CURALEAF');
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
      noteVendorSuccess(organisationId, 'CURALEAF');
      res.setHeader('Cache-Control', 'no-store');
      res.status(result.status === 'processing' ? 202 : 200).json(result);
    } catch (error) { next(error); }
  });

  return router;
}
