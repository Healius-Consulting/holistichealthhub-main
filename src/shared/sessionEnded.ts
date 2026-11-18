export function shouldDispatchSessionEnded(status: number, code: string | undefined, pathname: string): boolean {
  // HHH suspended this pharmacy, or marked it Not available: end the session wherever the staff member is.
  if (status === 403 && (code === 'PHARMACY_SUSPENDED' || code === 'PHARMACY_NOT_AVAILABLE')) return pathname !== '/login' && pathname !== '/reset-password';
  if (status !== 401) return false;
  // A vendor rejecting API keys is not a staff-session failure. Older API builds
  // still return that rejection as 401, which was signing the user out on save.
  if (code === 'APP_CHECK_REQUIRED' || code === 'WORLDPAY_CREDENTIALS_REJECTED' || code === 'CURALEAF_CREDENTIALS_REJECTED') return false;
  if (pathname === '/login' || pathname === '/reset-password') return false;
  return true;
}
