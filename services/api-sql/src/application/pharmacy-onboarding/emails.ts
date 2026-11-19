/**
 * Payload keys of the application to Curaleaf (queued by onboarding-emails.service.ts):
 * the delivery worker reads them to attach the filled form and the licence.
 */
export const FILLED_FORM_PATH_KEY = 'filledFormStoragePath';
/** The filename the filled Curaleaf form is attached under (see curaleafFormFilename). */
export const FILLED_FORM_NAME_KEY = 'filledFormFilename';
export const LICENCE_PATH_KEY = 'licenceStoragePath';
export const LICENCE_TYPE_KEY = 'licenceContentType';
export const LICENCE_NAME_KEY = 'licenceFilename';

/** The signed Partner Terms copy attached to the confirmation email (pharmacy_partner_terms_signed). */
export const SIGNED_TERMS_PATH_KEY = 'signedTermsStoragePath';
export const SIGNED_TERMS_NAME_KEY = 'signedTermsFilename';
