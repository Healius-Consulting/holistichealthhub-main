export type StaffRole = 'HHH_ADMIN' | 'PHARMACY_STAFF';
export type ProtectedSurface = 'pharmacy' | 'admin';

export interface TenantScope {
  readonly kind: 'tenant';
  readonly organisationId: string;
  readonly uid: string;
  readonly email: string | null;
  readonly role: 'PHARMACY_STAFF';
  readonly surface: 'pharmacy';
  readonly sessionHash: string;
  readonly requestId: string;
  readonly idleExpiresAt: string;
  readonly absoluteExpiresAt: string;
}

export interface PlatformScope {
  readonly kind: 'platform';
  readonly uid: string;
  readonly email: string | null;
  readonly role: 'HHH_ADMIN';
  readonly surface: 'admin';
  readonly sessionHash: string;
  readonly requestId: string;
  readonly idleExpiresAt: string;
  readonly absoluteExpiresAt: string;
  readonly targetOrganisationId?: string;
  readonly auditReason?: string;
}

export interface PublicScope {
  readonly kind: 'public';
  readonly surface: 'public';
  readonly requestId: string;
  readonly ipHash: string;
}

export type RequestContext = TenantScope | PlatformScope | PublicScope;

export function isTenantScope(context: RequestContext | undefined): context is TenantScope {
  return context?.kind === 'tenant';
}

export function isPlatformScope(context: RequestContext | undefined): context is PlatformScope {
  return context?.kind === 'platform';
}

export function assertTenantScope(context: RequestContext): TenantScope {
  if (!isTenantScope(context)) {
    throw new Error('Operation requires an authenticated tenant context.');
  }
  return context;
}

export function assertPlatformScope(context: RequestContext): PlatformScope {
  if (!isPlatformScope(context)) {
    throw new Error('Operation requires an authenticated HHH platform admin context.');
  }
  return context;
}
