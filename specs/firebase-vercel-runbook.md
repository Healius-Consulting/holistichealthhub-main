# Firebase and Vercel runbook

> **Hobby staging is retired.** Live frontend deploys come from GitHub `main` → HHH Vercel team only. See [`.agents/skills/production-hosting/SKILL.md`](../.agents/skills/production-hosting/SKILL.md).

Live hostnames: production public is `holistichealthhub.live`, portal is `portal.holistichealthhub.live`, `holistichealthhub.cc` / `portal.holistichealthhub.cc` are retired brand hosts kept for preview flicker, and `hhh.thinktimeless.co.uk` is a Cloudflare pharmacy QR redirect (not Vercel).

The sections below describe the **HHH production** Vercel topology. Historical Hobby staging notes are kept for reference only.

## Topology

Create two Vercel projects from this repository, both with the repository root as their Root Directory:

| Project | `HHH_SURFACE` | Build output | Intended hostname |
|---|---|---|---|
| HHH public | `public` | `dist-public` | `www.<base-domain>` |
| HHH staff portal | `portal` | `dist-portal` | `portal.<base-domain>` |

`vercel.ts` accepts only `public` or `portal`, runs server functions in London (`lhr1`), and proxies same-origin requests to `apiLondon`, the Firebase Function in `europe-west2`. The staff portal uses `/pharmacy/...` and `/admin/...`; `/login` and `/reset-password` are the only shared staff routes. Keep Firebase Functions for the API and scheduled reconciliation jobs; the Cloud Run/Terraform deployment is deferred and is not part of this staging path.

The protected build script compiles separate pharmacy and admin bundles into one portal artefact. It removes both `index.html` files from static output and packages them only with `api/page-gate.ts`. The gate derives the workspace from the pathname and verifies the Firebase session cookie, server-side session record, role, tenant, active staff profile, MFA, idle expiry, absolute expiry, and exact portal host before returning protected HTML. Anonymous page requests receive a `303` before protected HTML is returned. Static JavaScript is public by design and must contain no credentials or patient/tenant data.

## Vercel project settings

Do not override the Framework, Build Command, Output Directory, or Function Region in the dashboard; `vercel.ts` owns them. Use Node.js 22.

Set these non-secret variables on every project:

```text
HHH_SURFACE=public | portal
HHH_FIREBASE_API_ORIGIN=https://europe-west2-<firebase-project>.cloudfunctions.net/apiLondon
VITE_APP_ENV=staging
VITE_FIREBASE_API_KEY=<firebase-web-key>
VITE_FIREBASE_AUTH_DOMAIN=<firebase-project>.firebaseapp.com
VITE_FIREBASE_PROJECT_ID=<firebase-project>
VITE_FIREBASE_STORAGE_BUCKET=<firebase-project>.firebasestorage.app
VITE_FIREBASE_MESSAGING_SENDER_ID=<sender-id>
VITE_FIREBASE_APP_ID=<web-app-id>
VITE_FIREBASE_APP_CHECK_SITE_KEY=<recaptcha-enterprise-site-key>
VITE_REQUIRE_APP_CHECK=true
```

Set these encrypted runtime variables only on the portal project:

```text
HHH_ALLOWED_HOSTS=<exact-custom-hostname>[,<exact-staging-hostname>]
FIREBASE_PROJECT_ID=<firebase-project>
FIREBASE_SERVICE_ACCOUNT_JSON=<single-line-service-account-json>
IP_HASH_SECRET=<at-least-32-random-bytes>
```

The preferred portal configuration uses Vercel OIDC workload identity federation. If a service-account JSON fallback is temporarily required, use it only by the Vercel page gate, grant only Firebase Auth session verification and the minimum Firestore access needed for `staffSessions`, `staffUsers`, and PII-minimised `auditLogs`, and never expose it through a `VITE_*` variable. Rotate it immediately if it appears in a build log or client bundle.

`HHH_ALLOWED_HOSTS` is an exact comma-separated allow-list. Vercel's current deployment URL variables are also accepted for that deployment, but authenticated UAT should use fixed staging hostnames so Firebase authorised origins and API origin checks remain exact.

## Firebase API settings

Deploy `apiLondon` and the scheduled jobs to the staging Firebase project in `europe-west2`. Configure the API with:

```text
NODE_ENV=production
AUTH_MODE=cookie-enforced
SESSION_COOKIE_SECURE=true
REQUIRE_MFA=true
REQUIRE_APP_CHECK=true
PORTAL_APP_ORIGIN=https://<exact-portal-host>
PUBLIC_APP_ORIGIN=https://<exact-public-host>
ALLOWED_ORIGINS=https://<exact-public-host>,https://<exact-portal-host>
IP_HASH_SECRET=<at-least-32-random-bytes>
EMAIL_FROM_ADDRESS=noreply@holistichealthhub.live
RESEND_API_KEY_SECRET_RESOURCE_NAME=projects/<firebase-project>/secrets/hhh-resend-api-key-europe-west2
```

Register both exact custom hostnames in Firebase Authentication and register the portal hostname in App Check. Keep Firestore and Storage browser rules at deny-all. Curaleaf, Worldpay, Resend, message-provider, and service-account secrets remain server-side and must never use a `VITE_*` name. The Worldpay secret JSON is exactly `username`, `password`, and `entityId`; hosted-payment-page customisation was removed, and any `customisationId` left in an older stored secret is ignored.

Apply the exact-origin CORS policy required by the signed prescription and pharmacy-logo upload URLs (replace the bucket name when using another Firebase project):

```bash
gcloud storage buckets update gs://<firebase-storage-bucket> --cors-file=storage.cors.json
```

The Vercel build now fails closed if the required Firebase client configuration is absent, and requires `VITE_FIREBASE_APP_CHECK_SITE_KEY` whenever `VITE_REQUIRE_APP_CHECK=true`. Set the browser and API requirement flags together; do not enable API `REQUIRE_APP_CHECK=true` before the matching reCAPTCHA Enterprise App Check web registration exists.

Deploy after selecting the staging project:

```bash
firebase use <staging-project-id>
firebase deploy --only firestore:rules,firestore:indexes,storage,functions
```

## Hobby features and deferred paid features

Hobby-compatible and retained now:

- Separate public and combined-portal projects with automatic TLS.
- London Vercel Functions for the protected page gate.
- Vercel CDN for fingerprinted static assets only.
- Application-level MFA, fail-closed page/API auth, CSRF, App Check, role and tenant checks.
- Standard Vercel Authentication for preview/deployment URLs if enabled in the dashboard; it is supplemental and never replaces the page gate.
- Basic Vercel Firewall/DDoS protections within Hobby limits.

Not enabled now:

- Pro team collaboration and paid usage.
- Password-protected/shareable preview links.
- Advanced or managed WAF rules, advanced rate limiting, multi-region failover, Secure Compute, log drains, or enterprise controls.
- Any Vercel healthcare/compliance add-on or claim that the Hobby deployment is suitable for live health data.

The Cloud Run load balancer, Cloud Armor, private origin, and Terraform implementation remains in `infra/terraform` as a deferred alternative; it is not deployed by this runbook.

## Verification before any deployment is shared

Run:

```bash
npm ci
npm run lint
npm run build:vercel:public
npm run build:vercel:portal
npx tsx --test tests/**/*.test.ts
npm test --workspace @hhh/api
```

Then verify:

- `dist-portal/index.html`, `dist-pharmacy/index.html`, and `dist-admin/index.html` do not exist after portal preparation.
- `.vercel-private/pharmacy/index.html` and `.vercel-private/admin/index.html` are function-only and ignored by Git.
- Anonymous `/pharmacy/...` and `/admin/...` routes return `303` to `/login` and never return protected HTML.
- Wrong-role, wrong-tenant, expired, idle, revoked, non-MFA, and disabled staff sessions fail closed.
- Public, pharmacy, and admin client bundles contain only their intended surface, while only `public` and `portal` are deployable.
- `/pharmacy/v1/*`, `/admin/v1/*`, and shared `/v1/auth/*` remain same-origin and protected responses are never cached.
- Only synthetic records and payment sandboxes are present.

## Upgrade gate

Before client/commercial use, at minimum move the projects to Vercel Pro, assign ownership and billing to the correct legal entity, configure spend controls, review access and preview protection, and repeat the full security test. Pro alone does not authorise real patient data: penetration testing, DPIA, residency/data-processing review, recovery exercises, GPhC/GDPR/legal, Curaleaf, and Worldpay sign-off remain separate blockers.
