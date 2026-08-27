import { auth } from '../../bootstrap/firebase.js';
import { portalAppOrigins } from '../../bootstrap/config.js';
import { HttpError } from '../../domain/common/errors.js';

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

function firebaseAuthErrorCode(error: unknown) {
  if (!error || typeof error !== 'object') return null;
  const candidate = error as { code?: unknown; errorInfo?: { code?: unknown } };
  return typeof candidate.code === 'string'
    ? candidate.code
    : typeof candidate.errorInfo?.code === 'string'
      ? candidate.errorInfo.code
      : null;
}

/**
 * Mint the setup/reset link an invited staff member follows.
 *
 * The portal serves `/reset-password` itself and reads `oobCode` straight off the query
 * string, so Firebase's own continue URL is discarded by `firstPartyPasswordResetLink`.
 * It is still passed because the reset origin must stay pinned to the portal that owns
 * the page — which means the origin has to be on the project's Firebase Auth authorized
 * domain list. When it is not, Firebase rejects the call with
 * `auth/unauthorized-continue-uri`, and an unmapped rejection surfaced to the admin as a
 * bare "An unexpected error occurred." Name the actual cause instead so the operator
 * knows this is a console setting rather than a bad email address.
 */
export async function generateStaffPasswordResetLink(email: string) {
  const appOrigin = portalAppOrigin();
  let firebaseLink: string;
  try {
    firebaseLink = await auth.generatePasswordResetLink(email, {
      url: new URL('/reset-password', appOrigin).toString(),
      handleCodeInApp: true,
    });
  } catch (error) {
    const code = firebaseAuthErrorCode(error);
    if (code === 'auth/unauthorized-continue-uri') {
      throw new HttpError(
        502,
        `The setup email could not be created because ${new URL(appOrigin).hostname} is not an authorised domain for this Firebase project. `
        + 'Add it under Firebase Authentication → Settings → Authorised domains, then invite again.',
        'RESET_LINK_DOMAIN_NOT_AUTHORISED',
      );
    }
    if (code === 'auth/user-not-found') {
      throw new HttpError(404, 'No sign-in account exists for that email address.', 'RESET_LINK_USER_NOT_FOUND');
    }
    throw new HttpError(
      502,
      'The setup link could not be created by Firebase Authentication. No invitation email was sent.',
      'RESET_LINK_UNAVAILABLE',
    );
  }
  return firstPartyPasswordResetLink(firebaseLink, appOrigin);
}
