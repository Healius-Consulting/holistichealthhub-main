/**
 * Brief 2.9: the poster pack from Settings → Assets. HHH's own A3 poster and two-sided
 * A5 leaflet (public/posters/), each stamped with the branch's eligibility QR and its
 * logo, or its name when there is no usable logo. The pharmacy orders printing itself.
 *
 * Switched on 18 Nov 2026, after HHH saw sample packs. Set to false to hide the
 * download again (for example while a template is being replaced).
 */
export const POSTER_TEMPLATES_READY = true;

/**
 * The QR opens the eligibility form, which is open from Awaiting Curaleaf onwards. A
 * suspended or on-hold pharmacy's link is off, so it gets no posters.
 */
export function posterPackAvailable(status: string | null | undefined): boolean {
  return status === 'onboarding' || status === 'intake_live' || status === 'live';
}
