import { portalAppOrigins } from '../../bootstrap/config.js';

export function portalAppOrigin() {
  for (const origin of portalAppOrigins) {
    if (origin.includes('portal.')) return origin;
  }
  return 'https://portal.holistichealthhub.live';
}

export function firstPartyPasswordResetLink(firebaseLink: string, appOrigin = portalAppOrigin()) {
  const source = new URL(firebaseLink);
  const destination = new URL('/reset-password', appOrigin);
  for (const key of ['oobCode', 'apiKey', 'lang']) {
    const value = source.searchParams.get(key);
    if (value) destination.searchParams.set(key, value);
  }
  return destination.toString();
}
