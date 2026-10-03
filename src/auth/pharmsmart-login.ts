/**
 * A Pharmsmart `?token=` on /login is not a session. Drop it from the address
 * bar and leave email-and-password invitation sign-in in place.
 */
let pharmsmartSignInLink = false;

export function pharmsmartLoginQuery(search: string) {
  const params = new URLSearchParams(search.startsWith('?') ? search.slice(1) : search);
  const hasToken = Boolean(params.get('token')?.trim());
  params.delete('token');
  const rest = params.toString();
  return {
    hasToken,
    searchWithoutToken: rest ? `?${rest}` : '',
  };
}

export function rememberPharmsmartLogin(search: string) {
  if (pharmsmartLoginQuery(search).hasToken) pharmsmartSignInLink = true;
  return pharmsmartSignInLink;
}

export function resetPharmsmartLoginNotice() {
  pharmsmartSignInLink = false;
}
