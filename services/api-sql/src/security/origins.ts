import { config, portalAppOrigins } from '../bootstrap/config.js';

function originFrom(value: string): string | null {
  try {
    return new URL(value).origin;
  } catch {
    return null;
  }
}

/** Vercel www redirects mean apex and www must be treated as the same site. */
export function wwwTwinOrigin(origin: string): string | null {
  try {
    const url = new URL(origin);
    const host = url.hostname.toLowerCase();
    if (!host || host === 'localhost' || host === '127.0.0.1') return null;
    const twinHost = host.startsWith('www.') ? host.slice(4) : `www.${host}`;
    if (!twinHost || twinHost === host) return null;
    return `${url.protocol}//${twinHost}`;
  } catch {
    return null;
  }
}

export function isPermittedWebOrigin(origin: string | undefined): boolean {
  if (!origin) return true;
  const normalised = originFrom(origin);
  if (!normalised) return false;
  if (portalAppOrigins.has(normalised)) return true;
  const twin = wwwTwinOrigin(normalised);
  if (twin && portalAppOrigins.has(twin)) return true;
  if (config.NODE_ENV === 'production') return false;

  try {
    const host = new URL(normalised).hostname.toLowerCase();
    return host === 'localhost' || host === '127.0.0.1';
  } catch {
    return false;
  }
}
