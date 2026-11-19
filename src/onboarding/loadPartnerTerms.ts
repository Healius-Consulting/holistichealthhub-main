import { ApiRequestError, getPartnerTerms } from '../shared/api';
import { partnerTermsFromResponse, type PartnerTermsLoad } from './partnerTerms';

/** The published Partner Terms. A 404 means not published yet; anything else failed. */
export async function loadPartnerTerms(): Promise<PartnerTermsLoad> {
  try {
    return partnerTermsFromResponse(await getPartnerTerms());
  } catch (error) {
    return error instanceof ApiRequestError && error.status === 404 ? { state: 'unpublished' } : { state: 'failed' };
  }
}
