import { Router, type Request, type Response, type NextFunction } from 'express';
import { z } from 'zod';
import { ReferralLinkService } from '../../application/referrals/referral-link.service.js';
import {
  activatePharmacyOnboardingRequest,
  declinePharmacyOnboardingRequest,
} from '../../application/pharmacy-onboarding/decide-request.js';
import { queuePharmacyDeclinedEmail, queuePharmacyOnboardingDeclined } from '../../application/pharmacy-onboarding/emails.js';
import { declineNewPharmacy } from '../../application/pharmacy-onboarding/decline-pharmacy.js';
import { safeDownloadName } from '../../application/pharmacy-onboarding/licence-file.js';
import { HttpError } from '../../domain/common/errors.js';
import { compactGphcNumber, publicOnboardingStatus, type PharmacyOnboardingRequestRecord } from '../../domain/pharmacy-onboarding/request.js';
import { StorageProvider } from '../../providers/storage/storage.provider.js';
import { SqlIdentityRepository } from '../../repositories/sql/identity.sql.js';
import { SqlNotificationRepository } from '../../repositories/sql/notification.sql.js';
import { SqlOrganisationRepository } from '../../repositories/sql/organisation.sql.js';
import { SqlPharmacyOnboardingRepository } from '../../repositories/sql/pharmacy-onboarding.sql.js';
import { requireCsrf } from '../../security/csrf.js';
import { assertPlatformScope } from '../../security/request-context.js';
import { requireStaff } from '../../security/require-staff.js';

const idSchema = z.string().uuid();

function toView(record: PharmacyOnboardingRequestRecord, worldpaySubmittedAt: string | null = null) {
  return {
    id: record.id,
    status: publicOnboardingStatus(record.status),
    pharmacistName: record.pharmacistName,
    pharmacyName: record.pharmacyName,
    registeredCompanyName: record.registeredCompanyName,
    invoiceAddress: record.invoiceAddress,
    deliveryAddress: record.deliveryAddress,
    gphcNumber: record.gphcNumber,
    wdaNumber: record.wdaNumber,
    licenceDetails: record.licenceDetails,
    pharmacyEmail: record.pharmacyEmail,
    accountsEmail: record.accountsEmail,
    pharmacyPhone: record.pharmacyPhone,
    accountsPhone: record.accountsPhone,
    faxNumber: record.faxNumber,
    signatureName: record.signatureName,
    signedOn: record.signedOn,
    licenceFilename: record.licenceFilename,
    organisationId: record.organisationId,
    declineReason: record.declineReason,
    decidedAt: record.decidedAt,
    createdAt: record.createdAt,
    /** Only the date: the Worldpay form itself is emailed and never stored. */
    worldpaySubmittedAt,
  };
}

/** Latest Worldpay note per GPhC, matched the same compact way the form stores it. */
function worldpayDates(notes: Array<{ gphcNumber: string; submittedAt: string }>) {
  const latest = new Map<string, string>();
  for (const note of notes) {
    const key = compactGphcNumber(note.gphcNumber) ?? note.gphcNumber;
    const current = latest.get(key);
    if (!current || note.submittedAt > current) latest.set(key, note.submittedAt);
  }
  return (gphcNumber: string) => latest.get(compactGphcNumber(gphcNumber) ?? gphcNumber) ?? null;
}

export function createPortalPharmacyOnboardingRouter(): Router {
  const router = Router();
  const repo = new SqlPharmacyOnboardingRepository();
  const organisationRepo = new SqlOrganisationRepository();
  const identityRepo = new SqlIdentityRepository();
  const notificationRepo = new SqlNotificationRepository();
  const storage = new StorageProvider();
  const referralLinks = new ReferralLinkService(organisationRepo);

  router.get('/portal/admin/pharmacy-onboarding-requests', requireStaff('admin'), async (_req: Request, res: Response, next: NextFunction) => {
    try {
      const [records, notes] = await Promise.all([repo.list(), repo.listWorldpaySubmissions()]);
      const worldpayFor = worldpayDates(notes);
      res.setHeader('Cache-Control', 'private, no-store');
      res.status(200).json({
        records: records.map(record => toView(record, worldpayFor(record.gphcNumber))),
        // Pharmacies already on the platform can send the Worldpay form too.
        worldpaySubmissions: notes.map(note => ({ gphcNumber: note.gphcNumber, submittedAt: note.submittedAt })),
      });
    } catch (error) {
      next(error);
    }
  });

  router.get('/portal/admin/pharmacy-onboarding-requests/:id/filled-form', requireStaff('admin'), async (req: Request, res: Response, next: NextFunction) => {
    try {
      await sendFile(repo, storage, idSchema.parse(req.params.id), 'form', res);
    } catch (error) {
      next(error);
    }
  });

  router.get('/portal/admin/pharmacy-onboarding-requests/:id/licence', requireStaff('admin'), async (req: Request, res: Response, next: NextFunction) => {
    try {
      await sendFile(repo, storage, idSchema.parse(req.params.id), 'licence', res);
    } catch (error) {
      next(error);
    }
  });

  // POST /v1/portal/admin/organisations/:id/decline - Curaleaf rejected a new pharmacy, or it should not be here
  router.post('/portal/admin/organisations/:id/decline', requireCsrf, requireStaff('admin'), async (req: Request, res: Response, next: NextFunction) => {
    try {
      const scope = assertPlatformScope(req.context!);
      const organisationId = idSchema.parse(req.params.id);
      const { reason } = z.object({ reason: z.string() }).parse(req.body);
      const result = await declineNewPharmacy({
        findOrganisation: id => organisationRepo.findOrganisationById(id),
        findRequestByOrganisation: id => repo.findByOrganisationId(id),
        archiveOrganisation: (id, note, at) => repo.archiveOrganisation(id, note, at),
        declineRequest: (id, note, at, actor) => repo.decline(id, note, at, actor),
        emailPharmacy: input => queuePharmacyDeclinedEmail(notificationRepo, input),
      }, { organisationId, reason, actorUid: scope.uid });
      await identityRepo.appendAudit({
        organisationId,
        actorUid: scope.uid,
        actorRole: scope.role,
        event: 'organisation.declined',
        recordType: 'Organisation',
        recordId: organisationId,
        requestId: scope.requestId,
        sessionHashPrefix: scope.sessionHash.slice(0, 12),
        surface: scope.surface,
        details: { requestId: result.requestId },
      });
      res.setHeader('Cache-Control', 'private, no-store');
      res.status(200).json(result);
    } catch (error) {
      next(error);
    }
  });

  router.post('/portal/admin/pharmacy-onboarding-requests/:id/activate', requireCsrf, requireStaff('admin'), async (req: Request, res: Response, next: NextFunction) => {
    try {
      const scope = assertPlatformScope(req.context!);
      const id = idSchema.parse(req.params.id);
      const result = await activatePharmacyOnboardingRequest(repo, organisationRepo, referralLinks, {
        id,
        actorUid: scope.uid,
      });
      await identityRepo.appendAudit({
        organisationId: result.organisation.id,
        actorUid: scope.uid,
        actorRole: scope.role,
        event: 'organisation.created',
        recordType: 'Organisation',
        recordId: result.organisation.id,
        requestId: scope.requestId,
        sessionHashPrefix: scope.sessionHash.slice(0, 12),
        surface: scope.surface,
        details: { source: 'pharmacy-onboarding-request', requestId: result.requestId },
      });
      const request = await repo.findById(result.requestId);
      res.setHeader('Cache-Control', 'private, no-store');
      res.status(200).json({
        request: request ? toView(request) : { id: result.requestId, status: 'activated', organisationId: result.organisation.id },
        organisation: result.organisation,
      });
    } catch (error) {
      next(error);
    }
  });

  router.post('/portal/admin/pharmacy-onboarding-requests/:id/decline', requireCsrf, requireStaff('admin'), async (req: Request, res: Response, next: NextFunction) => {
    try {
      const scope = assertPlatformScope(req.context!);
      const id = idSchema.parse(req.params.id);
      const reason = z.object({ reason: z.string().trim().min(2).max(500) }).parse(req.body).reason;
      const declined = await declinePharmacyOnboardingRequest(repo, { id, reason, actorUid: scope.uid });
      try {
        await queuePharmacyOnboardingDeclined(notificationRepo, declined, reason);
      } catch (error) {
        console.error('Pharmacy onboarding decline email was not queued', error instanceof Error ? error.message : 'unknown');
      }
      await identityRepo.appendAudit({
        organisationId: null,
        actorUid: scope.uid,
        actorRole: scope.role,
        event: 'pharmacy_onboarding.declined',
        recordType: 'PharmacyOnboardingRequest',
        recordId: declined.id,
        requestId: scope.requestId,
        sessionHashPrefix: scope.sessionHash.slice(0, 12),
        surface: scope.surface,
        details: { gphcNumber: declined.gphcNumber },
      });
      res.setHeader('Cache-Control', 'private, no-store');
      res.status(200).json({ request: toView(declined) });
    } catch (error) {
      next(error);
    }
  });

  return router;
}

async function sendFile(
  repo: SqlPharmacyOnboardingRepository,
  storage: StorageProvider,
  id: string,
  kind: 'form' | 'licence',
  res: Response,
) {
  const record = await repo.findById(id);
  if (!record) throw new HttpError(404, 'Pharmacy request not found.', 'NOT_FOUND');
  const storagePath = kind === 'form' ? record.filledFormStoragePath : record.licenceStoragePath;
  const contentType = kind === 'form' ? 'application/pdf' : record.licenceContentType;
  const filename = kind === 'form'
    ? safeDownloadName(`curaleaf-account-${record.gphcNumber}.pdf`, 'curaleaf-account.pdf')
    : safeDownloadName(record.licenceFilename, 'controlled-drug-licence');
  const file = await storage.downloadFile(storagePath);
  res.setHeader('Cache-Control', 'private, no-store');
  res.setHeader('Content-Type', contentType);
  res.setHeader('Content-Disposition', `inline; filename="${filename}"`);
  res.status(200).send(file.bytes);
}
