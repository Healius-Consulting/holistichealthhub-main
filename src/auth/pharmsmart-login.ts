/**
 * A PharmSmart login is only the opaque `?token=` value.
 * Email and name in the query string are not credentials. The token is removed
 * from the address bar as soon as it has been read for the server redemption.
 */
let pharmsmartSignInLink = false;

export function pharmsmartLoginQuery(search: string) {
  const params = new URLSearchParams(search.startsWith('?') ? search.slice(1) : search);
  const token = params.get('token')?.trim() ?? '';
  params.delete('token');
  const rest = params.toString();
  return {
    token,
    hasToken: token.length > 0,
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
