export type ProtectedSurface = 'pharmacy' | 'admin';

export const SESSION_IDLE_MS = 15 * 60 * 1_000;
export const SESSION_TOUCH_INTERVAL_MS = 60 * 1_000;

export interface SessionClaims {
  uid?: string;
  role?: unknown;
  organisationId?: unknown;
  pharmacyId?: unknown;
  email_verified?: unknown;
  firebase?: unknown;
}

export interface SessionRecord {
  sessionHash?: unknown;
  uid?: unknown;
  surface?: unknown;
  role?: unknown;
  organisationId?: unknown;
  revokedAt?: unknown;
  idleExpiresAt?: unknown;
  absoluteExpiresAt?: unknown;
  lastActivityAt?: unknown;
}

export interface StaffRecord {
  role?: unknown;
  organisationId?: unknown;
  pharmacyId?: unknown;
  status?: unknown;
  disabled?: unknown;
}

export interface GateFailure {
  status: 401 | 403;
  event: 'auth.session_rejected' | 'auth.session_expired_idle' | 'auth.session_expired_absolute' | 'auth.role_denied' | 'auth.tenant_mismatch';
  code: string;
}

export function parseCookieHeader(header: string | null) {
  const parsed: Record<string, string> = {};
  for (const item of (header ?? '').split(';')) {
    const separator = item.indexOf('=');
    if (separator < 1) continue;
    try {
      parsed[item.slice(0, separator).trim()] = decodeURIComponent(item.slice(separator + 1).trim());
    } catch {
      // Ignore malformed cookies; authentication will fail closed.
    }
  }
  return parsed;
}

export function safeReturnTo(value: unknown, fallback = '/') {
  if (typeof value !== 'string' || !value.startsWith('/') || value.startsWith('//')) return fallback;
  try {
    const decoded = decodeURIComponent(decodeURIComponent(value));
    if (
      decoded.startsWith('//')
      || decoded.includes('\\')
      || [...decoded].some(character => character.charCodeAt(0) <= 31 || character.charCodeAt(0) === 127)
    ) return fallback;
    const parsed = new URL(value, 'https://protected.invalid');
    if (parsed.origin !== 'https://protected.invalid') return fallback;
    return `${parsed.pathname}${parsed.search}${parsed.hash}`;
  } catch {
    return fallback;
  }
}

export function requestHost(request: Request) {
  const forwarded = request.headers.get('x-forwarded-host')?.split(',')[0]?.trim();
  const host = request.headers.get('host') || forwarded || new URL(request.url).host;
  return host.split(':')[0]!.toLowerCase();
}

export const DEFAULT_ALLOWED_HOSTS = [
  'portal.holistichealthhub.cc',
  'portal.holistichealthhub.live',
  'holistichealthhub.cc',
  'www.holistichealthhub.cc',
  'holistichealthhub.live',
  'www.holistichealthhub.live',
  'localhost',
  '127.0.0.1',
];

export function allowedHosts(environment: NodeJS.ProcessEnv) {
  const configured = (environment.HHH_ALLOWED_HOSTS ?? '').split(',').map(value => value.trim().toLowerCase()).filter(Boolean);
  const vercelHosts = [environment.VERCEL_URL, environment.VERCEL_BRANCH_URL, environment.VERCEL_PROJECT_PRODUCTION_URL]
    .map(value => value?.trim().toLowerCase())
    .filter((value): value is string => Boolean(value));
  return new Set([...DEFAULT_ALLOWED_HOSTS, ...configured, ...vercelHosts]);
}


export function organisationId(claims: SessionClaims | StaffRecord) {
  if (typeof claims.organisationId === 'string' && claims.organisationId) return claims.organisationId;
  if (typeof claims.pharmacyId === 'string' && claims.pharmacyId) return claims.pharmacyId;
  return null;
}

function secondFactor(claims: SessionClaims) {
  if (!claims.firebase || typeof claims.firebase !== 'object') return null;
  const factor = (claims.firebase as Record<string, unknown>).sign_in_second_factor;
  return typeof factor === 'string' ? factor : null;
}

function validDate(value: unknown) {
  if (typeof value !== 'string') return null;
  const milliseconds = Date.parse(value);
  return Number.isFinite(milliseconds) ? milliseconds : null;
}

export function normalizeRole(role: unknown): 'hhh_admin' | 'pharmacy_staff' | null {
  if (typeof role !== 'string') return null;
  const lower = role.toLowerCase().replace(/[-_]/g, '_');
  if (lower === 'hhh_admin' || lower === 'admin' || lower === 'hhhadmin') return 'hhh_admin';
  if (lower === 'pharmacy_staff' || lower === 'pharmacy' || lower === 'pharmacystaff') return 'pharmacy_staff';
  return null;
}

export function validateGateSession(input: {
  claims: SessionClaims;
  record: SessionRecord | null;
  staff: StaffRecord | null;
  sessionHash: string;
  surface: ProtectedSurface;
  now: number;
}): GateFailure | null {
  const { claims, record, staff, sessionHash, surface, now } = input;
  const expectedRole = surface === 'pharmacy' ? 'pharmacy_staff' : 'hhh_admin';
  const claimsOrganisationId = organisationId(claims);
  const staffOrganisationId = staff ? organisationId(staff) : null;
  const idleExpiry = validDate(record?.idleExpiresAt);
  const absoluteExpiry = validDate(record?.absoluteExpiresAt);

  if (claims.email_verified !== true) return { status: 403, event: 'auth.role_denied', code: 'EMAIL_NOT_VERIFIED' };
  if (secondFactor(claims) !== 'totp') return { status: 403, event: 'auth.role_denied', code: 'MFA_TOTP_REQUIRED' };
  if (normalizeRole(claims.role) !== expectedRole) return { status: 403, event: 'auth.role_denied', code: 'SURFACE_FORBIDDEN' };
  if (surface === 'pharmacy' && !claimsOrganisationId) return { status: 403, event: 'auth.tenant_mismatch', code: 'TENANT_REQUIRED' };
  if (!record || record.sessionHash !== sessionHash || record.uid !== claims.uid) {
    return { status: 401, event: 'auth.session_rejected', code: 'SESSION_RECORD_INVALID' };
  }
  if (record.surface !== surface || normalizeRole(record.role) !== expectedRole) {
    return { status: 403, event: 'auth.role_denied', code: 'SESSION_SURFACE_FORBIDDEN' };
  }
  if (record.organisationId !== claimsOrganisationId) {
    return { status: 403, event: 'auth.tenant_mismatch', code: 'SESSION_TENANT_MISMATCH' };
  }
  if (record.revokedAt) return { status: 401, event: 'auth.session_rejected', code: 'SESSION_REVOKED' };
  if (absoluteExpiry === null || absoluteExpiry <= now) {
    return { status: 401, event: 'auth.session_expired_absolute', code: 'SESSION_EXPIRED' };
  }
  if (idleExpiry === null || idleExpiry <= now) {
    return { status: 401, event: 'auth.session_expired_idle', code: 'SESSION_IDLE_EXPIRED' };
  }
  if (!staff || staff.disabled === true || (typeof staff.status === 'string' && staff.status.toLowerCase() !== 'active')) {
    return { status: 401, event: 'auth.session_rejected', code: 'ACCOUNT_DISABLED' };
  }
  if (normalizeRole(staff.role) !== expectedRole || staffOrganisationId !== claimsOrganisationId) {
    return { status: 403, event: 'auth.tenant_mismatch', code: 'STAFF_SCOPE_INVALID' };
  }
  return null;
}


export function shouldTouchSession(lastActivityAt: unknown, now: number) {
  const activity = validDate(lastActivityAt);
  return activity !== null && now - activity >= SESSION_TOUCH_INTERVAL_MS;
}
