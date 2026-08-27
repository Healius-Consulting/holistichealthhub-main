import 'dotenv/config';
import { z } from 'zod';

const schema = z.object({
  PORT: z.coerce.number().int().positive().default(8080),
  // `.live` is the brand; `.cc` stays allowed as a preview/flicker host.
  ALLOWED_ORIGINS: z.string().default('https://holistichealthhub.live,https://www.holistichealthhub.live,https://portal.holistichealthhub.live,https://holistichealthhub.cc,https://www.holistichealthhub.cc,https://portal.holistichealthhub.cc,http://localhost:5173,http://localhost:5174,http://127.0.0.1:5173,http://127.0.0.1:5174'),
  APP_BASE_URL: z.url().default('https://holistichealthhub.live'),
  FIREBASE_PROJECT_ID: z.string().min(1).optional(),
  FIREBASE_STORAGE_BUCKET: z.string().min(1).optional(),
  REQUIRE_APP_CHECK: z.enum(['true', 'false']).default('false'),
  REQUIRE_MFA: z.enum(['true', 'false']).default('false'),
  AUTH_MODE: z.enum(['bearer-observe', 'cookie-dual', 'cookie-enforced']).optional(),
  SESSION_COOKIE_SECURE: z.enum(['true', 'false']).optional(),
  PUBLIC_APP_ORIGIN: z.url().default('https://holistichealthhub.live'),
  PUBLIC_APP_ORIGINS: z.string().default('https://holistichealthhub.live,https://www.holistichealthhub.live,https://holistichealthhub.cc,https://www.holistichealthhub.cc'),
  PORTAL_APP_ORIGIN: z.url().default('https://portal.holistichealthhub.live'),
  PORTAL_APP_ORIGINS: z.string().default('https://portal.holistichealthhub.live,https://portal.holistichealthhub.cc'),
  IP_HASH_SECRET: z.string().min(32).optional(),
  V2_PUBLIC_INTAKE_ENABLED: z.enum(['true', 'false']).default('false'),
  V2_DIRECTORY_ADMIN_ENABLED: z.enum(['true', 'false']).default('false'),
  CURALEAF_BASE_URL: z.url().default('https://api.curaleaflaboratories.dev'),
  CURALEAF_READ_API_KEY: z.string().min(16).max(500).optional(),
  CURALEAF_WRITE_API_KEY: z.string().min(16).max(500).optional(),
  // Legacy single-key deployments remain supported during secret rotation.
  CURALEAF_API_KEY: z.string().min(16).max(500).optional(),
  CURALEAF_EVENT_POLLING_ENABLED: z.enum(['true', 'false']).default('false'),
  WORLDPAY_HPP_BASE_URL: z.url().optional(),
  WORLDPAY_PAYMENT_QUERIES_BASE_URL: z.url().optional(),
  PATIENT_MESSAGE_PROVIDER_URL: z.url().optional(),
  PATIENT_MESSAGE_PROVIDER_KEY: z.string().min(8).max(1000).optional(),
  CURALEAF_HOLD_URL_TEMPLATE: z.string().url().optional(),
  CURALEAF_RENEWAL_ATTACH_URL_TEMPLATE: z.string().url().optional(),
  CURALEAF_LINE_EXCLUSION_URL_TEMPLATE: z.string().url().optional(),
  /** @deprecated Use WORLDPAY_PAYMENT_QUERIES_BASE_URL. */
  WORLDPAY_VERIFY_BASE_URL: z.url().optional(),
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
});

export const config = schema.parse(process.env);
export const allowedOrigins = new Set(config.ALLOWED_ORIGINS.split(',').map(origin => origin.trim()).filter(Boolean));
export const publicAppHostnames = new Set(
  config.PUBLIC_APP_ORIGINS.split(',').map(origin => new URL(origin.trim()).hostname.toLowerCase()),
);
export const portalAppOrigins = new Set(
  config.PORTAL_APP_ORIGINS.split(',').map(origin => new URL(origin.trim()).origin),
);
export const portalAppHostnames = new Set(
  [...portalAppOrigins].map(origin => new URL(origin).hostname.toLowerCase()),
);
export const authMode = config.AUTH_MODE ?? (config.NODE_ENV === 'production' ? 'cookie-enforced' : 'bearer-observe');
export const secureSessionCookies = config.SESSION_COOKIE_SECURE
  ? config.SESSION_COOKIE_SECURE === 'true'
  : config.NODE_ENV === 'production';
