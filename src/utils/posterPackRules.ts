/**
 * Brief 2.9: the poster pack from Settings → Assets. Three print-ready PDFs (A4 poster,
 * A5 leaflet, A6 counter card), each with the branch's logo and its tokenised
 * eligibility QR. The pharmacy orders printing itself.
 *
 * HHH has not supplied its templates or the approved patient wording yet, and the
 * medicine is prescription-only, so the patient copy is a marked placeholder block and
 * the download stays off until both arrive. To switch it on: put HHH's wording in
 * POSTER_COPY and set POSTER_TEMPLATES_READY to true.
 */
export const POSTER_TEMPLATES_READY = false;

export const POSTER_COPY = {
  headline: 'Poster text — to be supplied by HHH',
  body: 'HHH\'s approved patient wording goes here once it is signed off.',
  scan: 'Scan with your phone camera',
} as const;

/**
 * The QR opens the eligibility form, which is open from Awaiting Curaleaf onwards. A
 * suspended or Not available pharmacy's link is off, so it gets no posters.
 */
export function posterPackAvailable(status: string | null | undefined): boolean {
  return status === 'onboarding' || status === 'intake_live' || status === 'live';
}

