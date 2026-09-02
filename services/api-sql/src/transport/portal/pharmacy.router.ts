import { Router, type NextFunction, type Request, type Response } from 'express';
import { z } from 'zod';
import { buildOrganisationProfileUpdate, syncDirectoryProfileFromOrganisation } from '../../application/organisation/profile-sync.js';
import { HttpError } from '../../domain/common/errors.js';
import { pharmacyPortalRecordAccess } from '../../domain/organisation/access.js';
import { SqlOrderRepository } from '../../repositories/sql/order.sql.js';
import { SqlOrganisationRepository } from '../../repositories/sql/organisation.sql.js';
import { SqlDirectoryRepository } from '../../repositories/sql/directory.sql.js';
import { SqlPatientRepository } from '../../repositories/sql/patient.sql.js';
import { SqlIntakeRepository } from '../../repositories/sql/intake.sql.js';
import { SqlIdentityRepository } from '../../repositories/sql/identity.sql.js';
import { SqlIntegrationRepository } from '../../repositories/sql/integration.sql.js';
import { SqlPaymentRepository } from '../../repositories/sql/payment.sql.js';
import { SqlCuraleafQuoteBankRepository } from '../../repositories/sql/curaleaf-quote-bank.sql.js';
import { buildPharmacyLedgerRows } from '../../application/finance/pharmacy-ledger.js';
import { rewritePatientConditions } from '../../application/eligibility/rewrite-patient-conditions.js';
import { requireCsrf } from '../../security/csrf.js';
import { assertTenantScope } from '../../security/request-context.js';
import { requireStaff } from '../../security/require-staff.js';
import { buildPharmacyPatientDirectory, buildSqlPharmacyOverview, toPortalOrganisation, toPortalPatient, toPortalPendingEnquiry } from './pharmacy-contracts.js';

const patientConditionParamsSchema = z.object({
  patientId: z.string().regex(/^(?:[0-9a-f]{32}|[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/i),
}).strict();

/*
 * No maximum. The public eligibility form caps a patient at three conditions to
 * keep an unsupervised intake short; staff transcribing a clinic letter are not
 * capped, or the pharmacy record could not match the prescription it dispenses
 * against. The upper bound here is a denial-of-service guard, not a clinical one.
 */
const patientConditionsInputSchema = z.object({
  conditionCodes: z.array(z.string().trim().min(1).max(120)).min(1).max(200),
  primaryConditionCode: z.string().trim().min(1).max(120),
}).strict();

const pharmacyProfileInputSchema = z.object({
  tradingName: z.string().trim().min(2).max(160).optional(),
  name: z.string().trim().min(2).max(160).optional(),
  gphcNumber: z.string().trim().min(3).max(40).optional(),
  superintendent: z.string().trim().min(2).max(160).optional(),
  addressLine1: z.string().trim().min(1).max(250).optional(),
  addressLine2: z.string().trim().max(250).optional(),
  locality: z.string().trim().min(1).max(120).optional(),
  county: z.string().trim().max(120).optional(),
  postcode: z.string().trim().min(2).max(16).optional(),
  mainContactName: z.string().trim().max(160).optional(),
  mainContactPhone: z.string().trim().max(40).optional(),
  mainContactEmail: z.string().trim().email().max(254).optional().or(z.literal('')),
}).strict().refine(value => Object.keys(value).length > 0, { message: 'At least one pharmacy detail must be supplied.' });

export function createPortalPharmacyRouter(): Router {
  const router = Router();
  const patientRepo = new SqlPatientRepository();
  const orderRepo = new SqlOrderRepository();
  const organisationRepo = new SqlOrganisationRepository();
  const directoryRepo = new SqlDirectoryRepository();
  const intakeRepo = new SqlIntakeRepository();
  const identityRepo = new SqlIdentityRepository();
  const integrationRepo = new SqlIntegrationRepository();
  const paymentRepo = new SqlPaymentRepository();
  const quoteBankRepo = new SqlCuraleafQuoteBankRepository();

  /**
   * Wholesale pack prices used to cost orders that never froze a paid quote.
   * Never fatal — a bank outage just leaves those orders uncosted, which the
   * snapshot reports honestly rather than counting as zero-cost profit.
   */
  async function quoteBankWholesaleByPack(organisationId: string) {
    try {
      const connection = await integrationRepo.findConnection(organisationId, 'CURALEAF');
      if (!connection) return new Map<string, number>();
      const entries = await quoteBankRepo.listEntries(connection.environment);
      return new Map(entries.map(entry => [entry.packId, entry.wholesalePackPricePence]));
    } catch (error) {
      console.warn('[Overview] Curaleaf quote bank unavailable for cost estimates:', error);
      return new Map<string, number>();
    }
  }

  async function operationalRecords(organisationId: string) {
    const organisation = await organisationRepo.findOrganisationById(organisationId);
    if (!organisation) {
      throw new HttpError(404, 'Pharmacy record not found.', 'NOT_FOUND');
    }
    const access = pharmacyPortalRecordAccess(organisation);
    if (!access.patients && !access.orders && !access.pendingEnquiries) {
      return { organisation, patients: [], orders: [], pendingEnquiries: [] };
    }
    const [patients, orders, pendingEnquiries] = await Promise.all([
      access.patients ? patientRepo.listTenantPatients(organisationId) : Promise.resolve([]),
      access.orders ? orderRepo.listTenantOrders(organisationId) : Promise.resolve([]),
      access.pendingEnquiries ? intakeRepo.listTenantPendingEnquiries(organisationId) : Promise.resolve([]),
    ]);
    return { organisation, patients, orders, pendingEnquiries };
  }

  router.get('/portal/patient-directory', requireStaff('pharmacy'), async (req: Request, res: Response, next: NextFunction) => {
    try {
      const scope = assertTenantScope(req.context!);
      const { patients, pendingEnquiries } = await operationalRecords(scope.organisationId);
      res.setHeader('Cache-Control', 'private, no-store');
      res.status(200).json(buildPharmacyPatientDirectory({ patients, pendingEnquiries }));
    } catch (error) {
      next(error);
    }
  });

  router.get('/portal/patients', requireStaff('pharmacy'), async (req: Request, res: Response, next: NextFunction) => {
    try {
      const scope = assertTenantScope(req.context!);
      const { patients } = await operationalRecords(scope.organisationId);
      res.status(200).json(patients.map(toPortalPatient));
    } catch (error) {
      next(error);
    }
  });

  router.get('/portal/enquiries', requireStaff('pharmacy'), async (req: Request, res: Response, next: NextFunction) => {
    try {
      const scope = assertTenantScope(req.context!);
      const { pendingEnquiries } = await operationalRecords(scope.organisationId);
      res.setHeader('Cache-Control', 'private, no-store');
      res.status(200).json(pendingEnquiries.map(toPortalPendingEnquiry));
    } catch (error) {
      next(error);
    }
  });

  router.get('/portal/overview', requireStaff('pharmacy'), async (req: Request, res: Response, next: NextFunction) => {
    try {
      const scope = assertTenantScope(req.context!);
      const [{ organisation, patients, orders, pendingEnquiries }, curaleaf, worldpay] = await Promise.all([
        operationalRecords(scope.organisationId),
        integrationRepo.findConnection(scope.organisationId, 'CURALEAF'),
        integrationRepo.findConnection(scope.organisationId, 'WORLDPAY'),
      ]);

      /*
       * The money headline comes from the same ledger rows the Finance page
       * renders, so the two can never disagree. Costing inputs are best-effort:
       * if they cannot be read the snapshot is omitted rather than published
       * with revenue counted and cost missing, which would overstate profit.
       */
      let financeRows: ReturnType<typeof buildPharmacyLedgerRows> | undefined;
      try {
        const [allocations, bankWholesalePenceByPackId] = await Promise.all([
          paymentRepo.listTenantPaymentAllocations(scope.organisationId, 4000),
          quoteBankWholesaleByPack(scope.organisationId),
        ]);
        const activeAllocationByOrder = new Map<string, number>();
        for (const allocation of allocations) {
          if (allocation.status !== 'ACTIVE') continue;
          activeAllocationByOrder.set(
            allocation.orderId,
            (activeAllocationByOrder.get(allocation.orderId) ?? 0) + Number(allocation.amountPence),
          );
        }
        financeRows = buildPharmacyLedgerRows({
          orders,
          patientNameById: new Map(),
          activeAllocationByOrder,
          bankWholesalePenceByPackId,
        });
      } catch (error) {
        console.warn('[Overview] Finance snapshot unavailable:', error);
      }

      res.setHeader('Cache-Control', 'private, no-store');
      res.status(200).json(buildSqlPharmacyOverview({
        organisation,
        patients,
        orders,
        pendingEnquiries,
        financeRows,
        connections: [curaleaf, worldpay].filter((connection): connection is NonNullable<typeof connection> => Boolean(connection)),
      }));
    } catch (error) {
      next(error);
    }
  });

  /*
   * Any pharmacy staff member may correct a patient's conditions — this is
   * record-keeping against the clinic letter in front of them, not a clinical
   * decision reserved to a role, and making them wait for an admin is what left
   * records wrong. Every edit is audited with what actually changed.
   */
  router.patch('/portal/patients/:patientId/conditions', requireCsrf, requireStaff('pharmacy'), async (req: Request, res: Response, next: NextFunction) => {
    try {
      const scope = assertTenantScope(req.context!);
      const { patientId } = patientConditionParamsSchema.parse(req.params);
      const input = patientConditionsInputSchema.parse(req.body);
      const patient = await patientRepo.findPatientById(scope.organisationId, patientId);
      if (!patient) {
        throw new HttpError(404, 'Patient record not found.', 'NOT_FOUND');
      }
      const result = await rewritePatientConditions({
        patient,
        conditionCodes: input.conditionCodes,
        primaryConditionCode: input.primaryConditionCode,
        intakeRepo,
        patientRepo,
      });
      await identityRepo.appendAudit({
        organisationId: scope.organisationId,
        actorUid: scope.uid,
        actorRole: scope.role,
        event: 'patient.conditions_updated',
        recordType: 'Patient',
        recordId: patient.id,
        requestId: scope.requestId,
        sessionHashPrefix: scope.sessionHash.slice(0, 12),
        surface: scope.surface,
        details: {
          added: result.diff.added,
          removed: result.diff.removed,
          primaryBefore: result.diff.primaryBefore,
          primaryAfter: result.diff.primaryAfter,
          rewroteSubmission: Boolean(patient.sourceSubmissionId),
        },
      });
      res.setHeader('Cache-Control', 'private, no-store');
      res.status(200).json({
        patientId: patient.id,
        conditions: result.conditions,
        primaryConditionCode: result.primaryConditionCode,
        changed: result.changed,
      });
    } catch (error) {
      next(error);
    }
  });

  router.patch('/portal/organisation/profile', requireCsrf, requireStaff('pharmacy'), async (req: Request, res: Response, next: NextFunction) => {
    try {
      const scope = assertTenantScope(req.context!);
      const input = pharmacyProfileInputSchema.parse(req.body);
      const current = await organisationRepo.findOrganisationById(scope.organisationId);
      if (!current) {
        throw new HttpError(404, 'Pharmacy record not found.', 'NOT_FOUND');
      }
      const profileUpdate = await buildOrganisationProfileUpdate(current, input);
      await organisationRepo.updateOrganisationProfile(scope.organisationId, profileUpdate);
      await syncDirectoryProfileFromOrganisation(directoryRepo, scope.organisationId, profileUpdate);
      const updated = await organisationRepo.findOrganisationById(scope.organisationId);
      if (!updated) {
        throw new HttpError(404, 'Pharmacy record not found.', 'NOT_FOUND');
      }
      await identityRepo.appendAudit({
        organisationId: scope.organisationId,
        actorUid: scope.uid,
        actorRole: scope.role,
        event: 'organisation.profile_updated',
        recordType: 'Organisation',
        recordId: scope.organisationId,
        requestId: scope.requestId,
        sessionHashPrefix: scope.sessionHash.slice(0, 12),
        surface: scope.surface,
        details: { changedFields: Object.keys(input) },
      });
      res.setHeader('Cache-Control', 'private, no-store');
      res.status(200).json(toPortalOrganisation(updated));
    } catch (error) {
      next(error);
    }
  });

  return router;
}
