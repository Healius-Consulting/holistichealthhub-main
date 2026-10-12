export const CONTENT_SECURITY_POLICY = "default-src 'self'; base-uri 'none'; object-src 'none'; frame-ancestors 'none'; form-action 'self'; script-src 'self' https://www.google.com/recaptcha/ https://www.gstatic.com/recaptcha/; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob: https://storage.googleapis.com https://firebasestorage.googleapis.com https://hhh26-4ebd2.firebasestorage.app; font-src 'self'; connect-src 'self' https://identitytoolkit.googleapis.com https://securetoken.googleapis.com https://firebaseappcheck.googleapis.com https://content-firebaseappcheck.googleapis.com https://storage.googleapis.com https://firebasestorage.googleapis.com https://hhh26-4ebd2.firebasestorage.app https://www.google.com/recaptcha/ https://europe-west2-hhh26-4ebd2.cloudfunctions.net https://apilondon-jorrgrz4nq-nw.a.run.app https://public.ecologi.com; frame-src 'self' https://www.google.com/recaptcha/ https://recaptcha.google.com/recaptcha/ https://calendly.com; worker-src 'self' blob:; upgrade-insecure-requests";

/** Public pharmacy onboarding is the only document another site may frame. */
export const PHARMACY_ONBOARDING_PATH = '/pharmacy-onboarding';

export const EMBEDDABLE_CONTENT_SECURITY_POLICY = CONTENT_SECURITY_POLICY.replace(
  "frame-ancestors 'none'",
  'frame-ancestors *',
);

export const embeddableDocumentHeaders = [
  { key: 'Content-Security-Policy', value: EMBEDDABLE_CONTENT_SECURITY_POLICY },
  { key: 'Cross-Origin-Opener-Policy', value: 'unsafe-none' },
  { key: 'Cross-Origin-Resource-Policy', value: 'cross-origin' },
  { key: 'Permissions-Policy', value: 'camera=(), microphone=(), geolocation=(), payment=(), usb=()' },
  { key: 'Referrer-Policy', value: 'no-referrer' },
  { key: 'X-Content-Type-Options', value: 'nosniff' },
];
