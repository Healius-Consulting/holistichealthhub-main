import { z } from 'zod';

const configSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.string().default('8080'),
  FIREBASE_PROJECT_ID: z.string().default('hhh26-4ebd2'),
  DATA_CONNECT_SERVICE_ID: z.string().default('hhh-platform-service'),
  DATA_CONNECT_LOCATION: z.string().default('europe-west2'),
  // Break-glass override only. Leave unset in deployed environments so each
  // pharmacy is routed by its own connection environment (TEST vs PRODUCTION),
  // the way Worldpay already works. Setting this pins every pharmacy to one host.
  CURALEAF_BASE_URL: z.url().optional(),
  WORLDPAY_HPP_BASE_URL: z.url().optional(),
  WORLDPAY_PAYMENT_QUERIES_BASE_URL: z.url().optional(),
  EMAIL_FROM_ADDRESS: z.string().email().optional(),
  RESEND_API_KEY_SECRET_RESOURCE_NAME: z.string().optional(),
  IP_HASH_SECRET: z.string().optional(),
  SECURE_SESSION_COOKIES: z.string().default('true'),
  // `.live` is the brand. `.cc` stays permitted because it remains an attachable
  // host for preview/flicker testing, and `hhh.thinktimeless.co.uk` is the printed
  // pharmacy QR origin before Cloudflare redirects. Removing either breaks live traffic.
  ALLOWED_ORIGINS: z.string().default(
    'https://holistichealthhub.live,https://www.holistichealthhub.live,' +
    'https://portal.holistichealthhub.live,' +
    'https://holistichealthhub.cc,https://www.holistichealthhub.cc,' +
    'https://portal.holistichealthhub.cc,' +
    'https://hhh.thinktimeless.co.uk,https://www.hhh.thinktimeless.co.uk'
  ),
  ALLOWED_HOSTS: z.string().default(
    'holistichealthhub.live,www.holistichealthhub.live,' +
    'portal.holistichealthhub.live,' +
    'holistichealthhub.cc,www.holistichealthhub.cc,' +
    'portal.holistichealthhub.cc,' +
    'hhh.thinktimeless.co.uk,www.hhh.thinktimeless.co.uk,' +
    'localhost,127.0.0.1'
  ),
  // Domain backends are SQL Connect only. Firestore is not a valid runtime.
  REQUIRE_APP_CHECK: z.enum(['true', 'false']).optional(),
  STORAGE_BACKEND: z.literal('sql').default('sql'),
  AUTH_BACKEND: z.literal('sql').default('sql'),
  INTAKE_BACKEND: z.literal('sql').default('sql'),
  ORDERS_BACKEND: z.literal('sql').default('sql'),
  PAYMENTS_BACKEND: z.literal('sql').default('sql'),
  FULFILMENT_BACKEND: z.literal('sql').default('sql'),
});

export type RuntimeConfig = z.infer<typeof configSchema>;

export const config: RuntimeConfig = configSchema.parse(process.env);

export const secureSessionCookies = config.NODE_ENV === 'production' || config.SECURE_SESSION_COOKIES === 'true';

export const portalAppOrigins = new Set(
  config.ALLOWED_ORIGINS.split(',').map(o => o.trim()).filter(Boolean)
);

export const portalAppHostnames = new Set(
  config.ALLOWED_HOSTS.split(',').map(h => h.trim().toLowerCase()).filter(Boolean)
);
