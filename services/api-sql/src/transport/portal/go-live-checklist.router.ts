import { partnerTermsState } from '../../application/pharmacy-onboarding/partner-terms.service.js';
import { SqlPartnerTermsRepository } from '../../repositories/sql/partner-terms.sql.js';
import { SqlPlatformContentRepository } from '../../repositories/sql/worldpay-application.sql.js';
import { Router, type NextFunction, type Request, type Response } from 'express';
import { z } from 'zod';
import { sqlClickupHooks } from '../../application/clickup/clickup-hooks.js';
import {
  loadGoLiveChecklist,
  setGoLiveChecklistItem,
  type GoLiveChecklistDeps,
} from '../../application/organisation/go-live-checklist.js';
import type { GoLiveChecklistView } from '../../domain/organisation/go-live-checklist.js';
import { SqlGoLiveChecklistRepository } from '../../repositories/sql/go-live-checklist.sql.js';
import { SqlIdentityRepository } from '../../repositories/sql/identity.sql.js';
import { SqlIntegrationRepository } from '../../repositories/sql/integration.sql.js';
import { SqlOrganisationRepository } from '../../repositories/sql/organisation.sql.js';
import { requireCsrf } from '../../security/csrf.js';
import { assertPlatformScope, assertTenantScope } from '../../security/request-context.js';
import { requireStaff } from '../../security/require-staff.js';
import { uuidParam } from './uuid-param.js';

const itemKeySchema = z.string().trim().min(1).max(80).regex(/^[a-z0-9_]+$/);
const tickSchema = z.object({ done: z.boolean() });

/** Admin sees who ticked each item by name, not only by uid. */
function withNames(view: GoLiveChecklistView, names: Map<string, string>) {
  return {
    ...view,
    items: view.items.map(item => ({
      ...item,
      tickedByName: item.tickedByUid ? names.get(item.tickedByUid) ?? null : null,
    })),
  };
}

export function createPortalGoLiveChecklistRouter(): Router {
  const router = Router();
  const organisationRepo = new SqlOrganisationRepository();
  const integrationRepo = new SqlIntegrationRepository();
  const identityRepo = new SqlIdentityRepository();
  const deps: GoLiveChecklistDeps = {
    findOrganisation: id => organisationRepo.findOrganisationById(id),
    checklistRepo: new SqlGoLiveChecklistRepository(),
    findWorldpayConnection: id => integrationRepo.findConnection(id, 'WORLDPAY'),
    partnerTerms: async () => {
      const state = await partnerTermsState({ content: new SqlPlatformContentRepository(), repo: new SqlPartnerTermsRepository() });
      return { on: state.on, documentId: state.document?.id ?? null };
    },
    clickup: sqlClickupHooks(),
  };

  // The pharmacy's own branch only: the organisation comes from the session, never the request.
  router.get('/portal/go-live-checklist', requireStaff('pharmacy'), async (req: Request, res: Response, next: NextFunction) => {
    try {
      const tenant = assertTenantScope(req.context!);
      res.setHeader('Cache-Control', 'private, no-store');
      res.status(200).json(await loadGoLiveChecklist(deps, tenant.organisationId));
    } catch (error) {
      next(error);
    }
  });

  // Tick ({ done: true }) or untick ({ done: false }) a self-declared item.
  router.post('/portal/go-live-checklist/items/:itemKey', requireCsrf, requireStaff('pharmacy'), async (req: Request, res: Response, next: NextFunction) => {
    try {
      const tenant = assertTenantScope(req.context!);
      const itemKey = itemKeySchema.parse(req.params.itemKey);
      const { done } = tickSchema.parse(req.body ?? {});
      res.setHeader('Cache-Control', 'private, no-store');
      res.status(200).json(await setGoLiveChecklistItem(deps, {
        organisationId: tenant.organisationId,
        itemKey,
        done,
        uid: tenant.uid,
      }));
    } catch (error) {
      next(error);
    }
  });

  router.get('/portal/admin/organisations/:id/go-live-checklist', requireStaff('admin'), async (req: Request, res: Response, next: NextFunction) => {
    try {
      assertPlatformScope(req.context!);
      const organisationId = uuidParam.parse(req.params.id);
      const view = await loadGoLiveChecklist(deps, organisationId);
      const staff = view.items.some(item => item.tickedByUid)
        ? await identityRepo.listPharmacyStaffByOrganisationId(organisationId)
        : [];
      const names = new Map(staff.map(member => [member.uid, member.displayName || member.email]));
      res.setHeader('Cache-Control', 'private, no-store');
      res.status(200).json(withNames(view, names));
    } catch (error) {
      next(error);
    }
  });

  return router;
}
