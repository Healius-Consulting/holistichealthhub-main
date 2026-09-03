# Pharmacy UI surface register

Read this register before changing any pharmacy-facing screen. “Fixed” items may not be visually removed, obscured, re-labelled into ambiguity, or made conditional by client state. Flexible composition must retain the stated data and state behaviour.

## Global protected shell

| Item | Audience / access | Data class and source | Status | Interaction / audit | Required states and access behaviour |
|---|---|---|---|---|---|
| Sign-in, verified-email and TOTP enrol/challenge | Invited active staff; unauthenticated until exchange | Identity; Firebase Auth and `/v1/auth/*` | Fixed | Session create/logout; security event | Loading, generic denial, locked/disabled, offline; keyboard-complete and screen-reader-labelled |
| Pharmacy identity and live/test/training/paused state | Authenticated pharmacy tenant | Tenant-confidential; session and Overview | Fixed | Read-only | Never hidden; text plus colour/icon; stacks at 360px |
| Staff identity, role, session warning, sign-out | Authenticated staff | Identity; server session | Fixed | Activity/logout are CSRF protected and audited | Warning at 13 minutes; focus moves to warning; tab-synchronised lock |
| Tenant-aware navigation | Authenticated pharmacy tenant | Tenant-confidential; server session | Fixed | Navigation only | Consistent order and labels; visible focus; mobile drawer traps and restores focus |
| Content status, errors, stale and permission denial | Authenticated staff | Depends on view | Fixed meaning, flexible placement | Retry is read-only | Never colour-only; live region where appropriate; no sensitive toast text |

## Pharmacy Overview

| Visual item / view | Audience / access | Data class and API | Status | Interaction / audit | Required states and responsive behaviour |
|---|---|---|---|---|---|
| Workspace header | Pharmacy staff; exact tenant | Tenant-confidential; `/v1/portal/overview` | Fixed content, flexible hierarchy | Refresh performs read | Loading, stale, training, paused; wraps without horizontal scroll |
| View selector | Pharmacy staff | Staff preference; `/v1/portal/preferences` | Flexible control, fixed availability | Preference write | Tab semantics, keyboard reachability, 44px mobile target |
| Daily Operations summary | Pharmacy staff | Aggregated operational; Overview endpoint | Flexible card order | Cards may navigate only | Loading, zero, partial failure; 5→3→1 grid |
| Priority queue | Pharmacy staff | Surname and initial plus order reference; Overview endpoint | Fixed masking, flexible density | Open authorised record; mutations prohibited here | Empty, aged, stale, permission denied; buttons remain labelled |
| Recent sessions | Pharmacy staff | Deprecated on Overview; open full record from Orders or Patients | — | — | Not shown |
| Workflow Pipeline | Pharmacy staff | Aggregate counts/ageing; Overview endpoint | Flexible pipeline/list composition | Navigation only | No contact data; textual bottleneck status; 4→2→1 stages |
| Secure Handover | Pharmacy staff and shared stand-up display | Zero-PII aggregates; Overview endpoint | Fixed privacy boundary, flexible composition | Refresh/view preference only | No patient labels or identifiers; readable at 200% zoom |
| Integration health | Pharmacy staff | Operational metadata; Overview endpoint | Fixed state vocabulary | No repair mutation | Connected, degraded, unavailable, not configured; text plus colour |
| Finance summary | Pharmacy staff | Aggregated financial; Overview endpoint | Flexible composition; server aggregates only | Navigate to Finance | Loading, omit-figures, zero and no-paying-patients; Gross profit lead; outstanding labelled apart from Revenue; wraps at 360px |

## Other pharmacy surfaces

| Surface | Authentication / tenant | Data class | Fixed security behaviour | Flexible design areas |
|---|---|---|---|---|
| Patients and eligibility review | Session plus immutable organisation | Special-category and contact data | Detail is fetched only after authorised navigation; no PII in URL/toast/storage/log | Information hierarchy, filters, density, responsive detail layout |
| Orders and prescriptions | Session plus immutable organisation | Clinical and financial | All mutations use API, CSRF, audit; cross-tenant IDs return `404` | Workflow grouping, table/cards, status emphasis within tokens |
| Finance and payments | Session plus immutable organisation | Financial, limited clinical context | Payment return never authorises state; refunds are backend actions | Summary composition, date controls, export affordance |
| Formulary | Session plus immutable organisation | Commercial catalogue | Integration permissions and state remain visible | Search, filters, table/card density |
| Settings and onboarding | Session plus immutable organisation | Tenant configuration and identity | Immutable tenant chrome; integration secrets never return to browser | Step composition, help content, progress presentation |

## Forbidden patterns

- Patient/contact/prescription data in URLs, analytics, browser storage, logs, or toast messages.
- Hidden tenant identity or ambiguous live/test/training/paused state.
- Client-only clinical, prescription, refund, payment, reminder, or messaging mutations.
- Colour-only status, invisible focus, obscured focus, or motion required to understand state.
- Production query parameters that switch portal, tenant, catalogue, admin, or authentication mode.
- Protected aggregates computed by downloading full collections to the browser.

## Review checklist

For every changed view, record the API fields, classification, fixed/flexible decision, interactions, audit event, and loading/empty/error/stale/offline/permission states. Verify desktop, tablet, 360px, 200% zoom, keyboard, screen reader names, touch target size, dark/light tokens, and reduced motion.
