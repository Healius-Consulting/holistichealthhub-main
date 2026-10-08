export const PHARMSMART_PHARMACY_INFO_URL = 'https://pharmsmart.co.uk/api/ext/v1/pharmacy/pharmacy/index.php';

/**
 * PharmSmart's Cloudflare rejects a request that has no browser User-Agent (error 1010).
 * The body must be form fields. JSON and GET both return status_code 400.
 */
const PHARMSMART_USER_AGENT = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

export async function fetchPharmsmartPharmacyInfo(token: string, fetchImpl: typeof fetch = globalThis.fetch) {
  const response = await fetchImpl(PHARMSMART_PHARMACY_INFO_URL, {
    method: 'POST',
    redirect: 'error',
    signal: AbortSignal.timeout(12_000),
    headers: {
      Accept: 'application/json',
      'Content-Type': 'application/x-www-form-urlencoded',
      'User-Agent': PHARMSMART_USER_AGENT,
    },
    body: new URLSearchParams({
      request_type: 'get_pharmacy_info',
      token,
    }),
  });
  if (!response.ok) {
    throw new Error('PharmSmart did not accept the pharmacy lookup.');
  }
  return response.text();
}
