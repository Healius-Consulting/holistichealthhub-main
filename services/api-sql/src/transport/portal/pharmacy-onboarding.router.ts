import { Router, type Request, type Response, type NextFunction } from 'express';
import { z } from 'zod';
import { ReferralLinkService } from '../../application/referrals/referral-link.service.js';
import { pharmacyRequestActions } from '../../application/pharmacy-onboarding/request-actions.js';
import { queuePharmacyDeclinedEmail } from '../../application/pharmacy-onboarding/emails.js';
import { declineNewPharmacy } from '../../application/pharmacy-onboarding/decline-pharmacy.js';
import { safeDownloadName } from '../../application/pharmacy-onboarding/licence-file.js';
import { HttpError } from '../../domain/common/errors.js';
import { compactGphcNumber, publicOnboardingStatus, type PharmacyOnboardingRequestRecord } from '../../domain/pharmacy-onboarding/request.js';
import type { PartnerTermsAcceptanceRecord } from '../../domain/pharmacy-onboarding/terms.js';
import { StorageProvider } from '../../providers/storage/storage.provider.js';
import { SqlIdentityRepository } from '../../repositories/sql/identity.sql.js';
import { SqlNotificationRepository } from '../../repositories/sql/notification.sql.js';
import { SqlOrganisationRepository } from '../../repositories/sql/organisation.sql.js';
import { SqlPharmacyOnboardingRepository } from '../../repositories/sql/pharmacy-onboarding.sql.js';
import { requireCsrf } from '../../security/csrf.js';
import { assertPlatformScope, type RequestContext } from '../../security/request-context.js';
import { requireStaff } from '../../security/require-staff.js';
import { uuidParam } from './uuid-param.js';

const idSchema = uuidParam;
/** Admin-only: the pharmacy never sees the hold reason. */
const holdSchema = z.object({ reason: z.string().trim().min(2).max(500) });

/** What admin sees of a Partner Terms acceptance. The IP hash stays in the database. */
function termsView(row: PartnerTermsAcceptanceRecord) {
  return {
    termsVersion: row.termsVersion,
    signerName: row.signerName,
    signerRole: row.signerRole,
    signerEmail: row.signerEmail,
    signerGphcNumber: row.signerGphcNumber,
    registeredCompanyName: row.registeredCompanyName,
    acceptedAt: row.acceptedAt,
    source: row.source,
    nameMatchesPharmsmart: row.nameMatchesPharmsmart,
  };
}

function toView(
  record: PharmacyOnboardingRequestRecord,
  worldpaySubmittedAt: string | null = null,
  terms: PartnerTermsAcceptanceRecord[] = [],
) {
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
    /** Newest first. Empty until the pharmacy accepts the Partner Terms. */
    termsAcceptances: terms.map(termsView),
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
      const [records, notes, acceptances] = await Promise.all([repo.list(), repo.listWorldpaySubmissions(), repo.listTermsAcceptances()]);
      const worldpayFor = worldpayDates(notes);
      const termsFor = (requestId: string) => acceptances.filter(row => row.onboardingRequestId === requestId);
      res.setHeader('Cache-Control', 'private, no-store');
      res.status(200).json({
        records: records.map(record => toView(record, worldpayFor(record.gphcNumber), termsFor(record.id))),
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
        holdRequest: (id, note, at, actor) => repo.hold(id, note, at, actor),
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

  const actionsFor = (context: RequestContext) => {
    const scope = assertPlatformScope(context);
    return {
      scope,
      actions: pharmacyRequestActions({
        repo,
        organisations: organisationRepo,
        referralLinks,
        notificationRepo,
        audit: input => identityRepo.appendAudit({
          ...input,
          actorUid: scope.uid,
          actorRole: scope.role,
          requestId: scope.requestId,
          sessionHashPrefix: scope.sessionHash.slice(0, 12),
          surface: scope.surface,
        }),
      }),
    };
  };

  // POST /v1/portal/admin/pharmacy-onboarding-requests/:id/activate - pending only; creates the pharmacy and emails it
  router.post('/portal/admin/pharmacy-onboarding-requests/:id/activate', requireCsrf, requireStaff('admin'), async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { scope, actions } = actionsFor(req.context!);
      const id = idSchema.parse(req.params.id);
      const result = await actions.activate({ id, actorUid: scope.uid });
      res.setHeader('Cache-Control', 'private, no-store');
      res.status(200).json({
        request: result.request ? toView(result.request, null, await repo.findTermsAcceptances(result.requestId)) : { id: result.requestId, status: 'activated', organisationId: result.organisation.id },
        organisation: result.organisation,
      });
    } catch (error) {
      next(error);
    }
  });

  // POST /v1/portal/admin/pharmacy-onboarding-requests/:id/hold - pending only; reason required, admin-only
  router.post('/portal/admin/pharmacy-onboarding-requests/:id/hold', requireCsrf, requireStaff('admin'), async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { scope, actions } = actionsFor(req.context!);
      const id = idSchema.parse(req.params.id);
      const { reason } = holdSchema.parse(req.body);
      const held = await actions.hold({ id, reason, actorUid: scope.uid });
      res.setHeader('Cache-Control', 'private, no-store');
      res.status(200).json({ request: toView(held, null, await repo.findTermsAcceptances(held.id)) });
    } catch (error) {
      next(error);
    }
  });

  // POST /v1/portal/admin/pharmacy-onboarding-requests/:id/unhold - on hold only; back to pending, no email
  router.post('/portal/admin/pharmacy-onboarding-requests/:id/unhold', requireCsrf, requireStaff('admin'), async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { actions } = actionsFor(req.context!);
      const id = idSchema.parse(req.params.id);
      const unheld = await actions.unhold({ id });
      res.setHeader('Cache-Control', 'private, no-store');
      res.status(200).json({ request: toView(unheld, null, await repo.findTermsAcceptances(unheld.id)) });
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
