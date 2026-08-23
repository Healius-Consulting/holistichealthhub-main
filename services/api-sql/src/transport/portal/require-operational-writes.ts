import type { NextFunction, Request, Response } from 'express';
import { HttpError } from '../../domain/common/errors.js';
import { pharmacyOperationalAccess } from '../../domain/organisation/access.js';
import { SqlOrganisationRepository } from '../../repositories/sql/organisation.sql.js';
import { isTenantScope } from '../../security/request-context.js';

const organisationRepo = new SqlOrganisationRepository();

/** Training and pre-live workspaces must not persist CRM, orders, payments, or goods-in. */
export async function requirePharmacyOperationalWrites(req: Request, _res: Response, next: NextFunction) {
  if (req.method === 'GET' || req.method === 'HEAD' || req.method === 'OPTIONS') {
    next();
    return;
  }
  const context = req.context;
  if (!isTenantScope(context)) {
    next();
    return;
  }
  try {
    const organisation = await organisationRepo.findOrganisationById(context.organisationId);
    if (!pharmacyOperationalAccess(organisation)) {
      throw new HttpError(409, 'This pharmacy workspace cannot save live records until HHH flips it live.', 'WORKSPACE_NOT_LIVE');
    }
    next();
  } catch (error) {
    next(error);
  }
}
