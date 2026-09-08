# ADR-001: Fail-closed platform surfaces

Status: amended for low-cost staging; production activation remains gated by independent assurance.

## Decision

For synthetic-data staging, HHH uses one public Vercel project and one combined staff portal Vercel project plus the Firebase Functions API in `europe-west2`. The portal has one exact origin, with pharmacy routes under `/pharmacy/...`, administration routes under `/admin/...`, and shared authentication at `/login` and `/reset-password`. Vercel Functions run in London (`lhr1`), and namespaced same-origin API requests are externally rewritten to `apiLondon`. There is no browser-configured API hostname.

Both protected HTML entry points are removed from static output during the portal build. A London Vercel page-gate function derives the workspace from the `/pharmacy` or `/admin` pathname, then verifies the session cookie and server registry before reading and returning the matching HTML. Protected HTML and API responses emit `no-store`; only fingerprinted assets receive immutable cache headers. Exact host checks prevent an arbitrary hostname from reaching either workspace.

The combined portal gateway authenticates a Firebase server session and its server-side `staffSessions` record before returning protected HTML. Anonymous page requests receive a `303` to `/login` with a validated relative return target. Anonymous API calls receive JSON `401`; role/surface mismatches receive `403`; tenant record mismatches receive `404`.

Production authentication is `cookie-enforced`. Bearer modes exist only to observe and validate the migration in non-production environments. A rollback may move traffic to an earlier cookie-capable revision, but may not restore bearer-only production access.

## Consequences

- A copied SPA URL cannot bypass the protected-page check.
- Pharmacy and administration ship as different client bundles inside one protected portal artefact. A host-only cookie is shared only by the exact portal origin; role and tenant checks select the permitted namespace.
- Vercel page-gate, API, and repository checks remain independently testable controls.
- Firebase Authentication, App Check, Firestore, Vercel Firewall/TLS/DNS, logging, and alerting must be configured before the application can be promoted.
- This repository does not claim invulnerability. Production remains blocked until penetration testing, DPIA, operational recovery, partner, regulatory, and legal gates are signed off.
- Vercel Hobby is personal/non-commercial only and is permitted here solely for owner-operated evaluation with synthetic data. Client or commercial use requires an appropriate paid account and a renewed platform/data-processing review.

## Implementation map

- Active Vercel protected gateway: `api/page-gate.ts`
- Deferred Cloud Run gateway: `services/web/src/server.ts`
- Session/CSRF boundary: `services/api-sql/src/security/csrf.ts`
- Authentication middleware: `services/api-sql/src/security/require-staff.ts`
- Overview computation: `services/api-sql/src/transport/portal/pharmacy-contracts.ts`
- Deferred Cloud Run resources: `infra/terraform`
- Deployable surfaces: `public` and `portal`; internal portal bundles: `apps/pharmacy`, `apps/admin`
