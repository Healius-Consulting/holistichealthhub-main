import { z } from 'zod';
import { HttpError } from '../../domain/common/errors.js';
import type { DirectoryRepositoryPort } from '../../repositories/ports/directory.port.js';
import type {
  OrganisationRecord,
  OrganisationRepositoryPort,
} from '../../repositories/ports/organisation.port.js';
import { buildOrganisationProfileUpdate, syncDirectoryProfileFromOrganisation } from './profile-sync.js';

export const updateOrganisationInputSchema = z.object({
  name: z.string().trim().min(2).max(160).optional(),
  tradingName: z.string().trim().min(2).max(160).optional(),
  gphcNumber: z.string().trim().min(3).max(40).optional(),
  superintendent: z.string().trim().min(2).max(160).optional(),
  companyNumber: z.string().trim().max(40).optional(),
  mainContactName: z.string().trim().max(160).optional(),
  mainContactPhone: z.string().trim().max(40).optional(),
  mainContactEmail: z.string().trim().email().max(254).optional().or(z.literal('')),
  address: z.string().trim().min(5).max(500).optional(),
  addressLine1: z.string().trim().min(1).max(250).optional(),
  addressLine2: z.string().trim().max(250).optional(),
  locality: z.string().trim().min(1).max(120).optional(),
  county: z.string().trim().max(120).optional(),
  postcode: z.string().trim().min(2).max(16).optional(),
  primaryColour: z.string().regex(/^#[0-9a-f]{6}$/i).optional(),
  logoText: z.string().trim().min(1).max(4).regex(/^[A-Za-z0-9]+$/).optional(),
  websiteDomains: z.array(z.string().trim().min(1).max(300)).max(10).optional(),
  status: z.enum(['onboarding', 'intake_live', 'live', 'paused']).optional(),
  portalName: z.string().trim().min(1).max(200).optional(),
}).strict().refine(value => Object.keys(value).length > 0, {
  message: 'At least one pharmacy detail must be supplied.',
});

export type UpdateOrganisationInput = z.infer<typeof updateOrganisationInputSchema>;

const PROFILE_FIELDS = [
  'name',
  'tradingName',
  'gphcNumber',
  'superintendent',
  'mainContactName',
  'mainContactPhone',
  'mainContactEmail',
  'address',
  'addressLine1',
  'addressLine2',
  'locality',
  'county',
  'postcode',
] as const;

const BRAND_FIELDS = ['primaryColour', 'logoText', 'portalName'] as const;

export function resolveOrganisationStatusChange(
  current: OrganisationRecord['status'],
  requested: NonNullable<UpdateOrganisationInput['status']>,
): OrganisationRecord['status'] | null {
  if (requested === 'live' || requested === 'intake_live') {
    if (current.toLowerCase() === requested) return null;
    throw new HttpError(
      409,
      'Use the audited intake or full go-live action to activate this pharmacy.',
      'ACTIVATION_ACTION_REQUIRED',
    );
  }
  if (requested === 'paused') {
    return current === 'PAUSED' ? null : 'PAUSED';
  }
  // The admin form shows INTAKE_LIVE as onboarding, so resubmitting that
  // value must not demote the pharmacy off the eligibility path.
  if (current === 'ONBOARDING' || current === 'INTAKE_LIVE') return null;
  return 'ONBOARDING';
}

export async function replaceOrganisationDomains(
  organisationRepo: Pick<OrganisationRepositoryPort, 'listOrganisationDomains' | 'deleteOrganisationDomain' | 'createOrganisationDomain'>,
  organisationId: string,
  hostnames: string[],
): Promise<{ accepted: string[]; rejected: string[] }> {
  const current = await organisationRepo.listOrganisationDomains(organisationId);
  const next = [...new Set(hostnames)];
  const nextSet = new Set(next);
  const currentSet = new Set(current.map(domain => domain.hostname));

  for (const domain of current) {
    if (!nextSet.has(domain.hostname)) {
      await organisationRepo.deleteOrganisationDomain(domain.id);
    }
  }

  const rejected: string[] = [];
  for (const hostname of next) {
    if (currentSet.has(hostname)) continue;
    try {
      await organisationRepo.createOrganisationDomain(organisationId, hostname);
    } catch {
      rejected.push(hostname);
    }
  }

  return {
    accepted: next.filter(hostname => !rejected.includes(hostname)),
    rejected,
  };
}

function hasAny(input: UpdateOrganisationInput, fields: readonly (keyof UpdateOrganisationInput)[]) {
  return fields.some(field => input[field] !== undefined);
}

export async function updateAdminOrganisationDetails(
  organisationId: string,
  body: unknown,
  deps: {
    organisationRepo: Pick<
      OrganisationRepositoryPort,
      | 'findOrganisationById'
      | 'updateOrganisationProfile'
      | 'updateOrganisationBrand'
      | 'updateOrganisationStatus'
      | 'listOrganisationDomains'
      | 'deleteOrganisationDomain'
      | 'createOrganisationDomain'
    >;
    directoryRepo: Pick<DirectoryRepositoryPort, 'upsertProfile'>;
    normaliseHostname: (input: string) => string;
  },
): Promise<{ organisation: OrganisationRecord; changedFields: string[] }> {
  const input = updateOrganisationInputSchema.parse(body);
  const current = await deps.organisationRepo.findOrganisationById(organisationId);
  if (!current) {
    throw new HttpError(404, 'Pharmacy record not found.', 'NOT_FOUND');
  }

  const changedFields = Object.keys(input).filter(field => field !== 'companyNumber');
  const nextStatus = input.status ? resolveOrganisationStatusChange(current.status, input.status) : null;

  if (hasAny(input, PROFILE_FIELDS)) {
    const profileUpdate = await buildOrganisationProfileUpdate(current, input);
    await deps.organisationRepo.updateOrganisationProfile(organisationId, profileUpdate);
    await syncDirectoryProfileFromOrganisation(deps.directoryRepo, organisationId, profileUpdate);
  }

  if (hasAny(input, BRAND_FIELDS)) {
    await deps.organisationRepo.updateOrganisationBrand(organisationId, {
      primaryColour: (input.primaryColour ?? current.primaryColour).toLowerCase(),
      logoText: (input.logoText ?? current.logoText).toUpperCase(),
      portalName: (input.portalName ?? current.portalName).trim() || current.portalName,
    });
  }

  if (input.websiteDomains) {
    await replaceOrganisationDomains(
      deps.organisationRepo,
      organisationId,
      input.websiteDomains.map(deps.normaliseHostname),
    );
  }

  if (nextStatus) {
    await deps.organisationRepo.updateOrganisationStatus(organisationId, nextStatus);
  }

  const updated = await deps.organisationRepo.findOrganisationById(organisationId);
  if (!updated) {
    throw new HttpError(404, 'Pharmacy record not found.', 'NOT_FOUND');
  }

  return { organisation: updated, changedFields };
}
