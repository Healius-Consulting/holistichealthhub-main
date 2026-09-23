export const ADMIN_VIEW_PATHS = Object.freeze({
  overview: '/',
  referrals: '/referrals',
  patients: '/patients',
  finance: '/finance',
});

export const PHARMACY_VIEW_PATHS = Object.freeze([
  '/',
  '/formulary',
  '/create',
  '/orders',
  '/patients',
  '/finance',
  '/settings',
  '/contacts',
]);

const adminPaths = new Map(Object.entries(ADMIN_VIEW_PATHS).map(([view, path]) => [path, view]));
const pharmacyPaths = new Set(PHARMACY_VIEW_PATHS);
const organisationRoute = /^\/pharmacy\/([A-Za-z0-9_-]{1,128})$/;

export function parseAdminRelativePath(relativePath) {
  const view = adminPaths.get(relativePath);
  if (view) return { kind: 'view', view };
  if (relativePath === '/platform') return { kind: 'view', view: 'overview' };
  const organisationMatch = organisationRoute.exec(relativePath);
  return organisationMatch ? { kind: 'organisation', organisationId: organisationMatch[1] } : null;
}

export function isSupportedPortalRelativePath(surface, relativePath) {
  return surface === 'pharmacy'
    ? pharmacyPaths.has(relativePath)
    : surface === 'admin' && parseAdminRelativePath(relativePath) !== null;
}
