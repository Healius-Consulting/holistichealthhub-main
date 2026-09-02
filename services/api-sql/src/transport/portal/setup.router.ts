import { Router, type Request, type Response, type NextFunction } from 'express';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { updateAdminOrganisationDetails } from '../../application/organisation/admin-update.js';
import {
  authoriseBrandLogoUpload,
  completeBrandLogoUpload,
  removeBrandLogo,
  resolveOrganisationLogo,
  resolveOrganisationLogos,
} from '../../application/organisation/brand-logo.js';
import { ReferralLinkService } from '../../application/referrals/referral-link.service.js';
import { HttpError } from '../../domain/common/errors.js';
import { canAcceptPublicIntake } from '../../domain/organisation/access.js';
import {
  buildGoLiveReadinessView,
  buildSetupStatusView,
  GO_LIVE_CURALEAF_TEST_ACK,
  goLiveBlockedMessage,
  goLiveRequiresCuraleafTestAcknowledgement,
  type PharmacySetupStatusView,
} from '../../domain/organisation/operational-readiness.js';
import type { OrganisationRecord, SetupTaskRecord } from '../../repositories/ports/organisation.port.js';
import { StorageProvider } from '../../providers/storage/storage.provider.js';
import { SqlDirectoryRepository } from '../../repositories/sql/directory.sql.js';
import { SqlIdentityRepository } from '../../repositories/sql/identity.sql.js';
import { SqlIntegrationRepository } from '../../repositories/sql/integration.sql.js';
import { SqlOrganisationRepository } from '../../repositories/sql/organisation.sql.js';
import { requireCsrf } from '../../security/csrf.js';
import { assertPlatformScope, assertTenantScope, type RequestContext } from '../../security/request-context.js';
import { requireStaff } from '../../security/require-staff.js';
import { toPortalOrganisation } from './pharmacy-contracts.js';

const setupDefinitions = [
  { id: 'pharmacy_profile', required: true },
  { id: 'curaleaf_account', required: true },
  { id: 'payment_route', required: true },
  { id: 'pricing', required: true },
  { id: 'notifications', required: true },
  { id: 'intake_call', required: true },
  { id: 'operational_readiness', required: true },
] as const;

const setupTaskIdSchema = z.enum(setupDefinitions.map(task => task.id) as [
  typeof setupDefinitions[number]['id'],
  ...Array<typeof setupDefinitions[number]['id']>,
]);

const setupTaskInputSchema = z.object({
  taskId: z.string().min(1).max(100),
  completed: z.boolean(),
  evidence: z.string().max(2000).nullable().optional(),
});

const preferencesInputSchema = z.object({
  theme: z.enum(['light', 'dark']),
  textScale: z.enum(['default', 'large', 'larger']),
  reduceMotion: z.boolean(),
  enhancedFocus: z.boolean(),
  underlineLinks: z.boolean(),
  overviewView: z.enum(['today', 'handover', 'operations', 'pipeline']).optional(),
  workspaceTourCompleted: z.boolean().optional(),
}).strict();

const organisationIdSchema = z.string().regex(/^(?:[a-f\d]{32}|[a-f\d]{8}(?:-[a-f\d]{4}){3}-[a-f\d]{12})$/i);

const createOrganisationInputSchema = z.object({
  name: z.string().trim().min(2).max(160),
  tradingName: z.string().trim().min(2).max(160),
  gphcNumber: z.string().trim().min(3).max(40),
  superintendent: z.string().trim().min(2).max(160),
  companyNumber: z.string().trim().max(40).optional(),
  mainContactName: z.string().trim().max(160).optional(),
  mainContactPhone: z.string().trim().max(40).optional(),
  mainContactEmail: z.string().trim().email().max(254).optional().or(z.literal('')),
  address: z.string().trim().min(5).max(500),
  primaryColour: z.string().regex(/^#[0-9a-f]{6}$/i),
  logoText: z.string().trim().min(1).max(4).regex(/^[A-Za-z0-9]+$/),
  websiteDomains: z.array(z.string().trim().min(1).max(300)).max(10),
  status: z.literal('onboarding'),
}).strict();

function normaliseHostname(input: string) {
  let url: URL;
  try {
    url = new URL(/^https?:\/\//i.test(input) ? input : `https://${input}`);
  } catch {
    throw new HttpError(400, 'A pharmacy website domain is invalid.', 'INVALID_DOMAIN');
  }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.port || (url.pathname !== '/' && url.pathname !== '')) {
    throw new HttpError(400, 'Enter website hostnames without paths, credentials or ports.', 'INVALID_DOMAIN');
  }
  const hostname = url.hostname.toLowerCase().replace(/\.$/, '');
  if (!hostname.includes('.') || hostname.length > 253 || !/^[a-z0-9.-]+$/.test(hostname)) {
    throw new HttpError(400, 'A pharmacy website domain is invalid.', 'INVALID_DOMAIN');
  }
  return hostname;
}

const defaultPreferences = {
  theme: 'light' as const,
  textScale: 'default' as const,
  reduceMotion: false,
  enhancedFocus: false,
  underlineLinks: false,
};

function authenticatedStaff(context: RequestContext | undefined) {
  if (!context || context.kind === 'public') {
    throw new HttpError(401, 'A valid staff session is required.', 'UNAUTHENTICATED');
  }
  return context;
}

function evidenceOf(input: { evidence?: string | null }): string {
  return (input.evidence ?? '').trim();
}

function assertPharmacyTaskEvidence(
  taskId: typeof setupDefinitions[number]['id'],
  completed: boolean,
  evidence: string,
  organisation: OrganisationRecord,
  worldpayConnected: boolean,
) {
  if (!completed) return;
  if (taskId === 'pharmacy_profile' && !evidence.includes(organisation.gphcNumber)) {
    throw new HttpError(400, 'Confirm the live GPhC number, superintendent and address before completing this step.', 'PREMISES_CONFIRMATION_REQUIRED');
  }
  if (taskId === 'pricing' && !/acknowledged/i.test(evidence)) {
    throw new HttpError(400, 'Acknowledge Curaleaf-supplied patient prices and save a dispensing-fee policy.', 'CHARGES_POLICY_REQUIRED');
  }
  if (taskId === 'notifications' && !/published/i.test(evidence)) {
    throw new HttpError(400, 'Download the content pack, then mark the eligibility link as published.', 'WEBSITE_PACK_REQUIRED');
  }
  if (taskId === 'intake_call' && evidence.length < 8) {
    throw new HttpError(400, 'Log that HHH completed the intake call.', 'INTAKE_CALL_REQUIRED');
  }
  if (taskId === 'operational_readiness' && evidence.length < 8) {
    throw new HttpError(400, 'Log that HHH completed the platform walkthrough.', 'WALKTHROUGH_EVIDENCE_REQUIRED');
  }
  if (taskId === 'payment_route' && organisation.defaultPaymentRoute === 'WORLDPAY' && !worldpayConnected) {
    throw new HttpError(409, 'Verify the Worldpay merchant connection before making it the default payment route.', 'WORLDPAY_VERIFICATION_REQUIRED');
  }
}

export function createPortalSetupRouter(): Router {
  const router = Router();
  const organisationRepo = new SqlOrganisationRepository();
  const identityRepo = new SqlIdentityRepository();
  const integrationRepo = new SqlIntegrationRepository();
  const directoryRepo = new SqlDirectoryRepository();
  const storage = new StorageProvider();
  const referralLinks = new ReferralLinkService(organisationRepo);

  async function portalOrganisationView(organisation: OrganisationRecord) {
    const [domains, logo] = await Promise.all([
      organisationRepo.listOrganisationDomains(organisation.id),
      resolveOrganisationLogo(storage, organisation.id),
    ]);
    return toPortalOrganisation(organisation, {
      websiteDomains: domains.map(domain => domain.hostname),
      ...logo,
    });
  }

  async function setupSnapshot(organisation: OrganisationRecord, records?: SetupTaskRecord[]): Promise<PharmacySetupStatusView> {
    const [taskRecords, staff, curaleaf, worldpay] = await Promise.all([
      records ? Promise.resolve(records) : organisationRepo.listSetupTasks(organisation.id),
      identityRepo.listPharmacyStaffByOrganisationId(organisation.id),
      integrationRepo.findConnection(organisation.id, 'CURALEAF'),
      integrationRepo.findConnection(organisation.id, 'WORLDPAY'),
    ]);
    return buildSetupStatusView({
      organisation,
      tasks: taskRecords,
      staff,
      curaleaf,
      worldpay,
      legacyLiveFallback: organisation.status === 'LIVE' && taskRecords.length === 0,
    });
  }

  async function goLiveSnapshot(organisation: OrganisationRecord) {
    const setup = await setupSnapshot(organisation);
    return buildGoLiveReadinessView({
      organisation,
      operational: setup.operational,
      curaleaf: await integrationRepo.findConnection(organisation.id, 'CURALEAF'),
    });
  }

  // Legacy-compatible setup status used by the current pharmacy shell. A
  // pre-cutover LIVE organisation with no migrated task rows remains live;
  // this is a read projection only and does not manufacture compliance rows.
  router.get('/portal/setup', requireStaff('pharmacy'), async (req: Request, res: Response, next: NextFunction) => {
    try {
      const scope = assertTenantScope(req.context!);
      const organisation = await organisationRepo.findOrganisationById(scope.organisationId);
      if (!organisation) throw new HttpError(404, 'Pharmacy record not found.', 'NOT_FOUND');
      res.status(200).json(await setupSnapshot(organisation));
    } catch (error) {
      next(error);
    }
  });

  // Platform staff need an aggregate, read-only projection. Calling the
  // tenant-only endpoint above from admin was both incorrect and noisy.
  router.get('/portal/admin/setup-status', requireStaff('admin'), async (req: Request, res: Response, next: NextFunction) => {
    try {
      assertPlatformScope(req.context!);
      const organisations = await organisationRepo.listOrganisations();
      const statuses = await Promise.all(organisations.map(organisation => setupSnapshot(organisation)));
      res.setHeader('Cache-Control', 'no-store');
      res.status(200).json({ records: statuses });
    } catch (error) {
      next(error);
    }
  });

  router.patch('/portal/admin/organisations/:id/setup/:taskId', requireCsrf, requireStaff('admin'), async (req: Request, res: Response, next: NextFunction) => {
    try {
      const scope = assertPlatformScope(req.context!);
      const organisationId = organisationIdSchema.parse(req.params.id);
      const taskId = setupTaskIdSchema.parse(req.params.taskId);
      if (taskId === 'curaleaf_account') {
        throw new HttpError(403, 'Record Curaleaf from the connection panel. The pharmacy never types credentials.', 'FORBIDDEN');
      }
      const input = z.object({
        completed: z.boolean(),
        evidence: z.string().trim().max(1000).nullable().optional(),
      }).parse(req.body);
      const [organisation, worldpay] = await Promise.all([
        organisationRepo.findOrganisationById(organisationId),
        integrationRepo.findConnection(organisationId, 'WORLDPAY'),
      ]);
      if (!organisation) throw new HttpError(404, 'Pharmacy record not found.', 'NOT_FOUND');
      assertPharmacyTaskEvidence(
        taskId,
        input.completed,
        evidenceOf(input),
        organisation,
        Boolean(worldpay && worldpay.status === 'ACTIVE' && worldpay.secretResourceName),
      );
      await organisationRepo.upsertSetupTask({
        organisationId,
        taskCode: taskId,
        completed: input.completed,
        evidence: input.evidence,
        completedByUid: scope.uid,
      });
      const records = await organisationRepo.listSetupTasks(organisationId);
      res.status(200).json(await setupSnapshot(organisation, records));
    } catch (error) {
      next(error);
    }
  });

  router.patch('/portal/setup/:taskId', requireCsrf, requireStaff('pharmacy'), async (req: Request, res: Response, next: NextFunction) => {
    try {
      const scope = assertTenantScope(req.context!);
      const taskId = setupTaskIdSchema.parse(req.params.taskId);
      if (taskId === 'curaleaf_account' || taskId === 'intake_call' || taskId === 'operational_readiness') {
        throw new HttpError(403, 'HHH administrators log the intake call.', 'FORBIDDEN');
      }
      const input = z.object({
        completed: z.boolean(),
        evidence: z.string().trim().max(1000).nullable().optional(),
      }).parse(req.body);
      const [organisation, worldpay] = await Promise.all([
        organisationRepo.findOrganisationById(scope.organisationId),
        integrationRepo.findConnection(scope.organisationId, 'WORLDPAY'),
      ]);
      if (!organisation) throw new HttpError(404, 'Pharmacy record not found.', 'NOT_FOUND');
      assertPharmacyTaskEvidence(
        taskId,
        input.completed,
        evidenceOf(input),
        organisation,
        Boolean(worldpay && worldpay.status === 'ACTIVE' && worldpay.secretResourceName),
      );
      await organisationRepo.upsertSetupTask({
        organisationId: scope.organisationId,
        taskCode: taskId,
        completed: input.completed,
        evidence: input.evidence,
        completedByUid: scope.uid,
      });
      const records = await organisationRepo.listSetupTasks(scope.organisationId);
      res.status(200).json(await setupSnapshot(organisation, records));
    } catch (error) {
      next(error);
    }
  });

  // GET /v1/portal/setup/tasks - List setup checklist tasks for tenant
  router.get('/portal/setup/tasks', requireStaff('pharmacy'), async (req: Request, res: Response, next: NextFunction) => {
    try {
      const scope = assertTenantScope(req.context!);
      const tasks = await organisationRepo.listSetupTasks(scope.organisationId);
      res.status(200).json({ tasks });
    } catch (error) {
      next(error);
    }
  });

  // POST /v1/portal/setup/tasks - Update task completion status
  router.post('/portal/setup/tasks', requireCsrf, requireStaff('pharmacy'), async (req: Request, res: Response, next: NextFunction) => {
    try {
      const scope = assertTenantScope(req.context!);
      const input = setupTaskInputSchema.parse(req.body);
      const taskId = setupTaskIdSchema.parse(input.taskId);
      if (taskId === 'curaleaf_account' || taskId === 'intake_call' || taskId === 'operational_readiness') {
        throw new HttpError(403, 'HHH administrators log the intake call.', 'FORBIDDEN');
      }
      const [organisation, worldpay] = await Promise.all([
        organisationRepo.findOrganisationById(scope.organisationId),
        integrationRepo.findConnection(scope.organisationId, 'WORLDPAY'),
      ]);
      if (!organisation) throw new HttpError(404, 'Pharmacy record not found.', 'NOT_FOUND');
      assertPharmacyTaskEvidence(
        taskId,
        input.completed,
        evidenceOf(input),
        organisation,
        Boolean(worldpay && worldpay.status === 'ACTIVE' && worldpay.secretResourceName),
      );

      await organisationRepo.upsertSetupTask({
        organisationId: scope.organisationId,
        taskCode: taskId,
        completed: input.completed,
        evidence: input.evidence,
        completedByUid: scope.uid,
      });

      res.status(200).json({ status: 'ok', taskId, completed: input.completed });
    } catch (error) {
      next(error);
    }
  });

  // GET /v1/portal/preferences - Get user UI preferences
  router.get('/portal/preferences', requireStaff('any'), async (req: Request, res: Response, next: NextFunction) => {
    try {
      const scope = authenticatedStaff(req.context);
      const staff = await identityRepo.findStaffUser(scope.uid);
      res.status(200).json(staff?.preferences ?? defaultPreferences);
    } catch (error) {
      next(error);
    }
  });

  // PATCH /v1/portal/preferences - Update the current staff member's UI preferences
  const updatePreferences = async (req: Request, res: Response, next: NextFunction) => {
    try {
      const scope = authenticatedStaff(req.context);
      const preferences = preferencesInputSchema.parse(req.body);

      await organisationRepo.updateStaffPreferences(scope.uid, preferences);
      res.status(200).json(preferences);
    } catch (error) {
      next(error);
    }
  };
  router.patch('/portal/preferences', requireCsrf, requireStaff('any'), updatePreferences);
  router.post('/portal/preferences', requireCsrf, requireStaff('any'), updatePreferences);

  // GET /v1/portal/admin/organisations - Platform-scoped pharmacy directory
  router.get('/portal/admin/organisations', requireStaff('admin'), async (req: Request, res: Response, next: NextFunction) => {
    try {
      assertPlatformScope(req.context!);
      const organisations = await organisationRepo.listOrganisations();
      const domains = await organisationRepo.listAllOrganisationDomains();
      const logos = await resolveOrganisationLogos(storage, organisations.map(organisation => organisation.id)).catch(() => new Map());
      const domainsByOrganisation = new Map<string, string[]>();
      for (const domain of domains) {
        const key = domain.organisationId.toLowerCase();
        const list = domainsByOrganisation.get(key) ?? [];
        list.push(domain.hostname);
        domainsByOrganisation.set(key, list);
      }
      res.setHeader('Cache-Control', 'private, no-store');
      res.status(200).json(organisations.map(organisation => toPortalOrganisation(organisation, {
        websiteDomains: domainsByOrganisation.get(organisation.id.toLowerCase()) ?? [],
        ...logos.get(organisation.id),
      })));
    } catch (error) {
      next(error);
    }
  });

  router.put('/portal/payment-settings', requireCsrf, requireStaff('pharmacy'), async (req: Request, res: Response, next: NextFunction) => {
    try {
      const scope = assertTenantScope(req.context!);
      const input = z.object({
        organisationId: organisationIdSchema.optional(),
        defaultPaymentRoute: z.enum(['manual', 'worldpay']).optional(),
        worldpayEnabled: z.boolean().optional(),
        pharmacyDeliveryEnabled: z.boolean().optional(),
      }).refine(value => value.defaultPaymentRoute !== undefined || value.worldpayEnabled !== undefined || value.pharmacyDeliveryEnabled !== undefined, {
        message: 'Choose a payment or delivery setting.',
      }).parse(req.body);
      if (input.organisationId && input.organisationId.replaceAll('-', '').toLowerCase() !== scope.organisationId.replaceAll('-', '').toLowerCase()) {
        throw new HttpError(403, 'A pharmacy may only update its own payment settings.', 'TENANT_SCOPE_VIOLATION');
      }
      const organisation = await organisationRepo.findOrganisationById(scope.organisationId);
      if (!organisation) throw new HttpError(404, 'Pharmacy record not found.', 'NOT_FOUND');
      const currentPaymentRoute = organisation.defaultPaymentRoute === 'WORLDPAY' ? 'worldpay' : 'manual';
      const defaultPaymentRoute = input.defaultPaymentRoute
        ?? (input.worldpayEnabled === undefined ? currentPaymentRoute : input.worldpayEnabled ? 'worldpay' : 'manual');
      const paymentRouteChanged = defaultPaymentRoute !== currentPaymentRoute;
      const pharmacyDeliveryEnabled = input.pharmacyDeliveryEnabled ?? organisation.pharmacyDeliveryEnabled;
      const pharmacyDeliveryChanged = pharmacyDeliveryEnabled !== organisation.pharmacyDeliveryEnabled;
      if ((input.defaultPaymentRoute !== undefined || input.worldpayEnabled !== undefined) && defaultPaymentRoute === 'worldpay') {
        const worldpay = await integrationRepo.findConnection(scope.organisationId, 'WORLDPAY');
        if (!worldpay || worldpay.status !== 'ACTIVE' || !worldpay.secretResourceName) {
          throw new HttpError(409, 'Verify this pharmacy’s Worldpay connection before making it the default payment route.', 'WORLDPAY_VERIFICATION_REQUIRED');
        }
      }
      if (input.defaultPaymentRoute !== undefined || input.worldpayEnabled !== undefined) {
        const route = defaultPaymentRoute === 'worldpay' ? 'WORLDPAY' as const : 'MANUAL' as const;
        await organisationRepo.updateOrganisationPaymentRoute(scope.organisationId, route, defaultPaymentRoute === 'worldpay');
      }
      if (input.pharmacyDeliveryEnabled !== undefined) {
        await organisationRepo.updateOrganisationPharmacyDelivery(scope.organisationId, pharmacyDeliveryEnabled);
      }
      await identityRepo.appendAudit({
        organisationId: scope.organisationId,
        actorUid: scope.uid,
        actorRole: scope.role,
        event: 'payment.settings_updated',
        recordType: 'Organisation',
        recordId: scope.organisationId,
        requestId: scope.requestId,
        sessionHashPrefix: scope.sessionHash.slice(0, 12),
        surface: scope.surface,
        details: {
          ...(paymentRouteChanged ? { defaultPaymentRoute: { from: currentPaymentRoute, to: defaultPaymentRoute } } : {}),
          ...(pharmacyDeliveryChanged ? { pharmacyDeliveryEnabled: { from: organisation.pharmacyDeliveryEnabled, to: pharmacyDeliveryEnabled } } : {}),
        },
      });
      res.status(200).json({
        organisationId: scope.organisationId,
        defaultPaymentRoute,
        worldpayEnabled: defaultPaymentRoute === 'worldpay',
        pharmacyDeliveryEnabled,
        updatedAt: new Date().toISOString(),
      });
    } catch (error) {
      next(error);
    }
  });

  router.get('/portal/admin/organisations/:id/go-live-readiness', requireStaff('admin'), async (req: Request, res: Response, next: NextFunction) => {
    try {
      assertPlatformScope(req.context!);
      const organisationId = organisationIdSchema.parse(req.params.id);
      const organisation = await organisationRepo.findOrganisationById(organisationId);
      if (!organisation) throw new HttpError(404, 'Pharmacy record not found.', 'NOT_FOUND');
      res.setHeader('Cache-Control', 'no-store');
      res.status(200).json(await goLiveSnapshot(organisation));
    } catch (error) {
      next(error);
    }
  });

  router.post('/portal/admin/organisations/:id/intake-live', requireCsrf, requireStaff('admin'), async (req: Request, res: Response, next: NextFunction) => {
    try {
      const scope = assertPlatformScope(req.context!);
      const organisationId = organisationIdSchema.parse(req.params.id);
      const organisation = await organisationRepo.findOrganisationById(organisationId);
      if (!organisation) throw new HttpError(404, 'Pharmacy record not found.', 'NOT_FOUND');
      if (organisation.status === 'PAUSED' || organisation.archivedAt) {
        throw new HttpError(409, 'Unpause this pharmacy before turning the eligibility link on.', 'INTAKE_LIVE_GATE_INCOMPLETE');
      }
      if (!organisation.intakeEnabled) {
        await organisationRepo.updateOrganisationIntakeEnabled(organisationId, true);
      }
      const updated = await organisationRepo.findOrganisationById(organisationId);
      if (!updated || !canAcceptPublicIntake(updated)) {
        throw new HttpError(409, 'Public intake is not available for this pharmacy.', 'INTAKE_LIVE_GATE_INCOMPLETE');
      }
      await identityRepo.appendAudit({
        organisationId,
        actorUid: scope.uid,
        actorRole: scope.role,
        event: 'organisation.intake_went_live',
        recordType: 'Organisation',
        recordId: organisationId,
        requestId: scope.requestId,
        sessionHashPrefix: scope.sessionHash.slice(0, 12),
        surface: scope.surface,
      });
      res.status(200).json(await goLiveSnapshot(updated));
    } catch (error) {
      next(error);
    }
  });

  router.post('/portal/admin/organisations/:id/go-live', requireCsrf, requireStaff('admin'), async (req: Request, res: Response, next: NextFunction) => {
    try {
      const scope = assertPlatformScope(req.context!);
      const organisationId = organisationIdSchema.parse(req.params.id);
      const organisation = await organisationRepo.findOrganisationById(organisationId);
      if (!organisation) throw new HttpError(404, 'Pharmacy record not found.', 'NOT_FOUND');
      const input = z.object({
        acknowledgedCuraleafTest: z.boolean().optional(),
      }).parse(req.body ?? {});
      const readiness = await goLiveSnapshot(organisation);
      if (organisation.status === 'LIVE' && readiness.ready) {
        res.status(200).json(readiness);
        return;
      }
      if (!readiness.ready) {
        throw new HttpError(409, goLiveBlockedMessage(readiness.operational), 'GO_LIVE_GATES_INCOMPLETE', {
          missingGates: readiness.operational.missingGates,
        });
      }
      const curaleafTestAckRequired = goLiveRequiresCuraleafTestAcknowledgement(readiness.operational);
      if (curaleafTestAckRequired && input.acknowledgedCuraleafTest !== true) {
        throw new HttpError(409, GO_LIVE_CURALEAF_TEST_ACK, 'GO_LIVE_CURALEAF_TEST_ACK_REQUIRED');
      }
      await organisationRepo.updateOrganisationStatus(organisationId, 'LIVE');
      await identityRepo.appendAudit({
        organisationId,
        actorUid: scope.uid,
        actorRole: scope.role,
        event: 'organisation.went_live',
        recordType: 'Organisation',
        recordId: organisationId,
        requestId: scope.requestId,
        sessionHashPrefix: scope.sessionHash.slice(0, 12),
        surface: scope.surface,
        details: {
          missingGates: readiness.operational.missingGates,
          acknowledgedCuraleafTest: curaleafTestAckRequired,
          curaleafLabel: readiness.operational.curaleaf.label,
        },
      });
      const updated = await organisationRepo.findOrganisationById(organisationId);
      if (!updated) throw new HttpError(404, 'Pharmacy record not found.', 'NOT_FOUND');
      res.status(200).json(await goLiveSnapshot(updated));
    } catch (error) {
      next(error);
    }
  });

  router.post('/portal/admin/organisations/:id/revert-live', requireCsrf, requireStaff('admin'), async (req: Request, res: Response, next: NextFunction) => {
    try {
      const scope = assertPlatformScope(req.context!);
      const organisationId = organisationIdSchema.parse(req.params.id);
      const organisation = await organisationRepo.findOrganisationById(organisationId);
      if (!organisation) throw new HttpError(404, 'Pharmacy record not found.', 'NOT_FOUND');
      if (organisation.status !== 'LIVE') {
        res.status(200).json(await goLiveSnapshot(organisation));
        return;
      }
      await organisationRepo.updateOrganisationStatus(organisationId, 'ONBOARDING');
      await identityRepo.appendAudit({
        organisationId,
        actorUid: scope.uid,
        actorRole: scope.role,
        event: 'organisation.reverted_from_live',
        recordType: 'Organisation',
        recordId: organisationId,
        requestId: scope.requestId,
        sessionHashPrefix: scope.sessionHash.slice(0, 12),
        surface: scope.surface,
      });
      const updated = await organisationRepo.findOrganisationById(organisationId);
      if (!updated) throw new HttpError(404, 'Pharmacy record not found.', 'NOT_FOUND');
      res.status(200).json(await goLiveSnapshot(updated));
    } catch (error) {
      next(error);
    }
  });

  // Only the authenticated tenant or an HHH platform administrator selecting a
  // tenant may retrieve a pharmacy's public referral link. It is never included
  // in the broad organisation directory response.
  router.get('/portal/referral-link', requireStaff('any'), async (req: Request, res: Response, next: NextFunction) => {
    try {
      const context = authenticatedStaff(req.context);
      const requestedOrganisationId = typeof req.query.organisationId === 'string'
        ? organisationIdSchema.parse(req.query.organisationId)
        : null;
      let organisationId: string;
      if (context.kind === 'tenant') {
        if (requestedOrganisationId && requestedOrganisationId.replaceAll('-', '').toLowerCase() !== context.organisationId.replaceAll('-', '').toLowerCase()) {
          throw new HttpError(403, 'A pharmacy may only access its own eligibility link.', 'TENANT_SCOPE_VIOLATION');
        }
        organisationId = context.organisationId;
      } else {
        assertPlatformScope(context);
        if (!requestedOrganisationId) {
          throw new HttpError(400, 'Select a pharmacy before requesting its eligibility link.', 'ORGANISATION_REQUIRED');
        }
        organisationId = requestedOrganisationId;
      }

      const url = await referralLinks.getEligibilityLink(organisationId);
      res.setHeader('Cache-Control', 'private, no-store, max-age=0');
      res.setHeader('Pragma', 'no-cache');
      await identityRepo.appendAudit({
        organisationId,
        actorUid: context.uid,
        actorRole: context.role,
        event: 'referral_link.accessed',
        recordType: 'Organisation',
        recordId: organisationId,
        requestId: context.requestId,
        sessionHashPrefix: context.sessionHash.slice(0, 12),
        surface: context.surface,
      });
      res.status(200).json({ url });
    } catch (error) {
      next(error);
    }
  });

  router.patch('/portal/admin/organisations/:id', requireCsrf, requireStaff('admin'), async (req: Request, res: Response, next: NextFunction) => {
    try {
      const scope = assertPlatformScope(req.context!);
      const organisationId = organisationIdSchema.parse(req.params.id);
      const { organisation, changedFields } = await updateAdminOrganisationDetails(organisationId, req.body, {
        organisationRepo,
        directoryRepo,
        normaliseHostname,
      });
      if (changedFields.length > 0) {
        await identityRepo.appendAudit({
          organisationId,
          actorUid: scope.uid,
          actorRole: scope.role,
          event: 'organisation.updated',
          recordType: 'Organisation',
          recordId: organisationId,
          requestId: scope.requestId,
          sessionHashPrefix: scope.sessionHash.slice(0, 12),
          surface: scope.surface,
          details: { changedFields },
        });
      }
      res.setHeader('Cache-Control', 'private, no-store');
      res.status(200).json(await portalOrganisationView(organisation));
    } catch (error) {
      next(error);
    }
  });

  router.post('/portal/admin/organisations/:id/logo/upload-url', requireCsrf, requireStaff('admin'), async (req: Request, res: Response, next: NextFunction) => {
    try {
      const scope = assertPlatformScope(req.context!);
      const organisationId = organisationIdSchema.parse(req.params.id);
      const organisation = await organisationRepo.findOrganisationById(organisationId);
      if (!organisation) throw new HttpError(404, 'Pharmacy record not found.', 'NOT_FOUND');
      const input = z.object({
        filename: z.string().trim().min(1).max(180),
        contentType: z.string().trim().min(1).max(80),
        sizeBytes: z.number().int().positive(),
      }).parse(req.body);
      const target = await authoriseBrandLogoUpload(storage, organisationId, input);
      await identityRepo.appendAudit({
        organisationId,
        actorUid: scope.uid,
        actorRole: scope.role,
        event: 'organisation.logo_upload_authorised',
        recordType: 'Organisation',
        recordId: organisationId,
        requestId: scope.requestId,
        sessionHashPrefix: scope.sessionHash.slice(0, 12),
        surface: scope.surface,
        details: { storagePath: target.storagePath, sourceFilename: target.sourceFilename },
      });
      res.setHeader('Cache-Control', 'private, no-store');
      res.status(200).json({
        uploadUrl: target.uploadUrl,
        storagePath: target.storagePath,
        requiredHeaders: target.requiredHeaders,
      });
    } catch (error) {
      next(error);
    }
  });

  router.post('/portal/admin/organisations/:id/logo/complete', requireCsrf, requireStaff('admin'), async (req: Request, res: Response, next: NextFunction) => {
    try {
      const scope = assertPlatformScope(req.context!);
      const organisationId = organisationIdSchema.parse(req.params.id);
      const organisation = await organisationRepo.findOrganisationById(organisationId);
      if (!organisation) throw new HttpError(404, 'Pharmacy record not found.', 'NOT_FOUND');
      const input = z.object({ storagePath: z.string().trim().min(1).max(500) }).parse(req.body);
      const logo = await completeBrandLogoUpload(storage, organisationId, input.storagePath);
      await identityRepo.appendAudit({
        organisationId,
        actorUid: scope.uid,
        actorRole: scope.role,
        event: 'organisation.logo_updated',
        recordType: 'Organisation',
        recordId: organisationId,
        requestId: scope.requestId,
        sessionHashPrefix: scope.sessionHash.slice(0, 12),
        surface: scope.surface,
        details: { storagePath: logo.emailLogoStoragePath },
      });
      res.setHeader('Cache-Control', 'private, no-store');
      res.status(200).json(toPortalOrganisation(organisation, {
        websiteDomains: (await organisationRepo.listOrganisationDomains(organisationId)).map(domain => domain.hostname),
        ...logo,
      }));
    } catch (error) {
      next(error);
    }
  });

  router.delete('/portal/admin/organisations/:id/logo', requireCsrf, requireStaff('admin'), async (req: Request, res: Response, next: NextFunction) => {
    try {
      const scope = assertPlatformScope(req.context!);
      const organisationId = organisationIdSchema.parse(req.params.id);
      const organisation = await organisationRepo.findOrganisationById(organisationId);
      if (!organisation) throw new HttpError(404, 'Pharmacy record not found.', 'NOT_FOUND');
      const logo = await removeBrandLogo(storage, organisationId);
      await identityRepo.appendAudit({
        organisationId,
        actorUid: scope.uid,
        actorRole: scope.role,
        event: 'organisation.logo_removed',
        recordType: 'Organisation',
        recordId: organisationId,
        requestId: scope.requestId,
        sessionHashPrefix: scope.sessionHash.slice(0, 12),
        surface: scope.surface,
      });
      res.setHeader('Cache-Control', 'private, no-store');
      res.status(200).json(toPortalOrganisation(organisation, {
        websiteDomains: (await organisationRepo.listOrganisationDomains(organisationId)).map(domain => domain.hostname),
        ...logo,
      }));
    } catch (error) {
      next(error);
    }
  });

  router.post('/portal/admin/organisations', requireCsrf, requireStaff('admin'), async (req: Request, res: Response, next: NextFunction) => {
    try {
      const scope = assertPlatformScope(req.context!);
      const input = createOrganisationInputSchema.parse(req.body);
      const websiteDomains = [...new Set(input.websiteDomains.map(normaliseHostname))];
      const id = randomUUID();
      const now = new Date().toISOString();

      await organisationRepo.createOrganisation({
        id,
        name: input.name,
        tradingName: input.tradingName,
        gphcNumber: input.gphcNumber,
        superintendentName: input.superintendent,
        mainContactName: input.mainContactName || null,
        mainContactPhone: input.mainContactPhone || null,
        mainContactEmail: input.mainContactEmail || null,
        address: input.address,
        primaryColour: input.primaryColour.toLowerCase(),
        logoText: input.logoText.toUpperCase(),
        portalName: input.name,
      });

      const referralLink = await referralLinks.ensureEligibilityLink({
        organisationId: id,
        createdByUid: scope.uid,
      });
      const rejectedDomains: string[] = [];
      for (const hostname of websiteDomains) {
        try {
          await organisationRepo.createOrganisationDomain(id, hostname);
        } catch {
          rejectedDomains.push(hostname);
        }
      }

      await identityRepo.appendAudit({
        organisationId: id,
        actorUid: scope.uid,
        actorRole: scope.role,
        event: 'organisation.created',
        recordType: 'Organisation',
        recordId: id,
        requestId: scope.requestId,
        sessionHashPrefix: scope.sessionHash.slice(0, 12),
        surface: scope.surface,
        details: { acceptedDomainCount: websiteDomains.length - rejectedDomains.length, rejectedDomains },
      });

      res.setHeader('Cache-Control', 'private, no-store, max-age=0');
      res.status(201).json({
        ...input,
        websiteDomains: websiteDomains.filter(hostname => !rejectedDomains.includes(hostname)),
        id,
        referralToken: referralLink.token,
        createdAt: now,
        updatedAt: now,
      });
    } catch (error) {
      next(error);
    }
  });

  return router;
}
