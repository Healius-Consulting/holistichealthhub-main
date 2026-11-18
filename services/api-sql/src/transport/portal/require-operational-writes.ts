import type { NextFunction, Request, Response } from 'express';
import { HttpError } from '../../domain/common/errors.js';
import { pharmacyOperationalAccess } from '../../domain/organisation/access.js';
import { SqlOrganisationRepository } from '../../repositories/sql/organisation.sql.js';
import { isTenantScope } from '../../security/request-context.js';

const organisationRepo = new SqlOrganisationRepository();

/**
 * A pharmacy awaiting Curaleaf (or any other not-live workspace) takes eligible
 * patients but never orders, pays, reaches Curaleaf or records goods-in. Admin
 * (platform) requests pass: they are not a pharmacy acting on its own account.
 */
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
      throw new HttpError(409, 'Ordering, payments and Curaleaf open once this pharmacy is live. Until then it can take eligible patients only.', 'WORKSPACE_NOT_LIVE');
    }
    next();
  } catch (error) {
    next(error);
  }
}
