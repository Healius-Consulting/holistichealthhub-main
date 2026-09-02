import type { AuthenticatedStaff } from '../auth/types';

function readLocalPortalPreview(): 'admin' | 'pharmacy' | null {
  if (typeof window === 'undefined') return null;
  if (!['localhost', '127.0.0.1', '::1', '[::1]'].includes(window.location.hostname)) return null;
  const params = new URLSearchParams(window.location.search);
  const requestedPortal = params.get('devPortal') ?? params.get('dev');
  return requestedPortal === 'admin' || requestedPortal === 'pharmacy' ? requestedPortal : null;
}

export const localPortalPreview = import.meta.env.DEV ? readLocalPortalPreview() : null;

export function withLocationSearch(path: string) {
  if (typeof window === 'undefined') return path;
  return `${path}${window.location.search}${window.location.hash}`;
}

export const isLocalPortalPreview = localPortalPreview !== null;

export const localPreviewStaff: AuthenticatedStaff | null = import.meta.env.DEV && localPortalPreview === 'admin'
  ? {
      uid: 'local-preview-admin',
      email: 'admin@local.hhh',
      name: 'Mihir Patel',
      role: 'hhh_admin',
      emailVerified: true,
      mfaEnrolled: false,
    }
  : import.meta.env.DEV && localPortalPreview === 'pharmacy'
    ? {
        uid: 'local-preview-pharmacy',
        email: 'owner@local.pharmacy',
        name: 'Alex Morgan',
        role: 'pharmacy_staff',
        organisationId: '70913a30-71c3-4a41-952e-d532927af58c',
        emailVerified: true,
        mfaEnrolled: false,
      }
    : null;
