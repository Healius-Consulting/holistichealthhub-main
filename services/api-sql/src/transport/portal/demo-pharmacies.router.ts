import { Router, type NextFunction, type Request, type Response } from 'express';
import { z } from 'zod';
import { deleteDemoPharmacy, readDemoGphcNumbers } from '../../application/pharmacy-onboarding/demo-pharmacies.js';
import { DEMO_PHARMACIES_KEY, demoGphcNumbersSchema } from '../../domain/pharmacy-onboarding/demo.js';
import { StorageProvider } from '../../providers/storage/storage.provider.js';
import { SqlDemoPharmacyRepository } from '../../repositories/sql/demo-pharmacy.sql.js';
import { SqlIdentityRepository } from '../../repositories/sql/identity.sql.js';
import { SqlPlatformContentRepository } from '../../repositories/sql/worldpay-application.sql.js';
import { requireCsrf } from '../../security/csrf.js';
import { assertPlatformScope } from '../../security/request-context.js';
import { requireStaff } from '../../security/require-staff.js';

const gphcParam = z.string().trim().regex(/^\d{7}$/);

/**
 * Admin: demo pharmacies, the GPhC numbers HHH uses to show onboarding on production.
 * Their Curaleaf email goes to HHH only, a new Curaleaf form from one wipes its last
 * run, and admin can wipe one here at any time.
 */
export function createPortalDemoPharmaciesRouter(): Router {
  const router = Router();
  const content = new SqlPlatformContentRepository();
  const repo = new SqlDemoPharmacyRepository();
  const storage = new StorageProvider();
  const identityRepo = new SqlIdentityRepository();

  const view = async () => {
    const gphcNumbers = await readDemoGphcNumbers(content);
    const pharmacies = await Promise.all(gphcNumbers.map(async gphc => {
      const found = await repo.find(gphc);
      const branch = found.organisations[0] ?? null;
      const request = [...found.requests].sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0] ?? null;
      return {
        gphcNumber: gphc,
        branch: branch ? { name: branch.name, status: branch.status, createdAt: branch.createdAt } : null,
        request: request ? { pharmacyName: request.pharmacyName, status: request.status, createdAt: request.createdAt } : null,
        hasPatientsOrOrders: found.hasPatientsOrOrders,
      };
    }));
    return { gphcNumbers, pharmacies };
  };

  // GET /v1/portal/admin/demo-pharmacies - the demo GPhC numbers and what each has on the platform
  router.get('/portal/admin/demo-pharmacies', requireStaff('admin'), async (req: Request, res: Response, next: NextFunction) => {
    try {
      assertPlatformScope(req.context!);
      res.setHeader('Cache-Control', 'private, no-store');
      res.status(200).json(await view());
    } catch (error) {
      next(error);
    }
  });

  // PUT /v1/portal/admin/demo-pharmacies - change the list
  router.put('/portal/admin/demo-pharmacies', requireCsrf, requireStaff('admin'), async (req: Request, res: Response, next: NextFunction) => {
    try {
      const scope = assertPlatformScope(req.context!);
      const gphcNumbers = demoGphcNumbersSchema.parse((req.body as { gphcNumbers?: unknown })?.gphcNumbers);
      await content.write(DEMO_PHARMACIES_KEY, [...new Set(gphcNumbers)], scope.uid);
      res.setHeader('Cache-Control', 'private, no-store');
      res.status(200).json(await view());
    } catch (error) {
      next(error);
    }
  });

  // POST /v1/portal/admin/demo-pharmacies/:gphc/delete - wipe one demo pharmacy so it can start again
  router.post('/portal/admin/demo-pharmacies/:gphc/delete', requireCsrf, requireStaff('admin'), async (req: Request, res: Response, next: NextFunction) => {
    try {
      const scope = assertPlatformScope(req.context!);
      const gphc = gphcParam.parse(req.params.gphc);
      const result = await deleteDemoPharmacy({ repo, content, storage }, gphc);
      await identityRepo.appendAudit({
        organisationId: null,
        actorUid: scope.uid,
        actorRole: scope.role,
        event: 'demo_pharmacy.deleted',
        recordType: 'Organisation',
        recordId: gphc,
        requestId: scope.requestId,
        sessionHashPrefix: scope.sessionHash.slice(0, 12),
        surface: scope.surface,
        details: { gphcNumber: gphc, deleted: result.deleted, files: result.files },
      }).catch(() => undefined);
      res.setHeader('Cache-Control', 'private, no-store');
      res.status(200).json({ result, ...(await view()) });
    } catch (error) {
      next(error);
    }
  });

  return router;
}
