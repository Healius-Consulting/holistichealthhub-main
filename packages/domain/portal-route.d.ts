export type PortalSurface = 'pharmacy' | 'admin';
export type AdminView = 'overview' | 'referrals' | 'patients' | 'finance' | 'pharmacyRequests';

export const ADMIN_VIEW_PATHS: Readonly<Record<AdminView, string>>;
export const PHARMACY_VIEW_PATHS: readonly string[];

export type AdminRoute =
  | { kind: 'view'; view: AdminView }
  | { kind: 'organisation'; organisationId: string };

export function parseAdminRelativePath(relativePath: string): AdminRoute | null;
export function isSupportedPortalRelativePath(surface: PortalSurface, relativePath: string): boolean;
