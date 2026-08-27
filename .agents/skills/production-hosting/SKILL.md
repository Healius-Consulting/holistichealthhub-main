---
name: production-hosting
description: Production hosting for Holistic Health Hub. GitHub main on Healius-Consulting/holistichealthhub-main auto-deploys the HHH Vercel team (holistichealthhub.live + portal). holistichealthhub.cc is the retired brand host, kept attachable for preview/flicker testing. hhh.thinktimeless.co.uk is a Cloudflare 301 for printed pharmacy QR codes, not Vercel. Hobby Vercel staging is retired. Use when deploying, attaching domains, changing Cloudflare DNS, eligibility QR/token URLs, or API function releases.
---

# Production hosting

**Single live frontend path:** push to `main` on `Healius-Consulting/holistichealthhub-main` → HHH Vercel team auto-deploys both surfaces. There is no separate Hobby staging Vercel anymore.

**API:** `apiLondon` on Firebase `hhh26-4ebd2` does **not** auto-deploy from GitHub — run `firebase deploy --only functions` when `services/api-sql` changes.

## What each hostname is

| Hostname | What it is | What it is not |
|---|---|---|
| `holistichealthhub.live` | Live **public** site and eligibility forms, and the brand in every generated link. HHH Vercel, `HHH_SURFACE=public`. | Not Think Timeless. |
| `portal.holistichealthhub.live` | Live **staff portal** (pharmacy + admin). HHH Vercel, `HHH_SURFACE=portal`. | Not the public site. |
| `holistichealthhub.cc` / `portal.holistichealthhub.cc` | **Flicker/test hosts.** Retired as the brand, still valid origins (CORS, page gate, auth) and still attachable to a preview deployment so staff can flick between preview and production. | Not the brand. Never generate links on `.cc`, and never add a blanket `.cc` → `.live` redirect: that would break attaching `.cc` to a preview. |
| `hhh.thinktimeless.co.uk` | **Printed pharmacy QR host only.** Cloudflare Single Redirect, 301, query string preserved, onto `holistichealthhub.live`. Proxied dummy DNS (`AAAA 100::`). No Vercel project. | Not a website. Do not attach to Vercel. |
| `staging.thinktimeless.co.uk` | **Retired.** Was Hobby public staging; project shut down. Remove or leave DNS dormant — do not use for UAT. | Not live. |

`ha.thinktimeless.co.uk` is Home Assistant. Apex `thinktimeless.co.uk` has no HHH site. Company mail stays on that zone (Google MX).

### `hhh` (pharmacies)

Eastwood and K-Chem printed this shape. Never reprint:

`https://hhh.thinktimeless.co.uk/?mode=eligibility&token=<token>`

Stone tokens:

- `https://hhh.thinktimeless.co.uk/?mode=eligibility&token=bbd8fc4749934797a49398c0b95e68cf873d4868c33c42a2949d6f65359d44c5`
- `https://hhh.thinktimeless.co.uk/?mode=eligibility&token=0a93ebde7ab143cfafd7c2a34329b3587148fb1ff9fb4e6fbf02f517fac05d30`

Cloudflare (thinktimeless zone) **Rules → Overview → Create rule → Redirect Rule**, wildcard:

- Request URL: `https://hhh.thinktimeless.co.uk/*`
- Target: `https://holistichealthhub.live/${1}`
- 301, preserve query string

Patients land on `https://holistichealthhub.live/?mode=eligibility&token=…`. The public app must treat `/?mode=eligibility&token=` as eligibility, and accept the historical `/?mode=eligibility?token=` typo. Do not orange-cloud a Vercel CNAME; `hhh` is not on Vercel.

**The printed URL never changes.** Host, path shape and tokens on `hhh.thinktimeless.co.uk` are fixed. Only the Cloudflare *target* moved from `.cc` to `.live`.

## Environment

| | Live |
|---|---|
| Git | `Healius-Consulting/holistichealthhub-main` — push `main` to deploy frontend |
| Vercel team | **HHH** (`hhh-d25f`) — two projects, auto-deploy from GitHub |
| Public | `https://holistichealthhub.live` (`.cc` kept as a flicker host) |
| Portal | `https://portal.holistichealthhub.live` (`.cc` kept as a flicker host) |
| Surfaces | `HHH_SURFACE=public` and `HHH_SURFACE=portal` |
| API | `apiLondon` on Firebase `hhh26-4ebd2` — manual `firebase deploy --only functions` |

Canonical public origin in code is **`holistichealthhub.live`**, not `.cc` and not `.co.uk`. `.cc` stays in every allowed-origin/allowed-host list. `VITE_APP_ENV` is unused. Production-ness is the hostname, Vercel team, and `HHH_SURFACE`.

## Deploy frontend (HHH Vercel)

Two projects from this repo, root `./`, never `services/api`:

1. **Public** — `HHH_SURFACE=public` → `holistichealthhub.live`
2. **Portal** — `HHH_SURFACE=portal` → `portal.holistichealthhub.live`

Attach each custom domain **once**. GitHub pushes to `main` update `.live` automatically. Do **not** run `vercel alias`. Ignore `*.vercel.app` for staff UAT.

```bash
git push staging main   # remote: Healius-Consulting/holistichealthhub-main
```

## Deploy API

```bash
firebase use hhh26-4ebd2
firebase deploy --only functions
```

Do not deploy Firestore.

## Code that must keep knowing `hhh`

Even though Cloudflare redirects first, keep these so a missed DNS change cannot send pharmacies to a blank origin:

- `apps/public/src/publicRoute.ts` — `LEGACY_ELIGIBILITY_HOSTS` includes `hhh.thinktimeless.co.uk` and `holistichealthhub.cc`, and JS-canonicalises **tokenised eligibility links only** to `https://holistichealthhub.live/eligibility?token=…`. Non-eligibility `.cc` paths are deliberately untouched.
- `vercel.ts` — host redirects for `hhh` / `www.hhh` to `.live` (backstop if that hostname is ever attached to Vercel; live path is Cloudflare). `.cc` is never in this list.
- `services/api-sql` CORS allows `hhh.thinktimeless.co.uk` (printed QR origin before redirect)

## What not to do

- Do not treat `hhh.thinktimeless.co.uk` as staging.
- Do not add a blanket `.cc` → `.live` redirect, and do not remove `.cc` from CORS / allowed hosts / page-gate origins. `.cc` must stay attachable for preview flicker.
- Do not reprint pharmacy QR materials; the printed thinktimeless URL is unchanged.
- Do not attach `hhh` to Vercel.
- Do not recreate Hobby staging unless you explicitly want a second Vercel account again.
- Do not delete the Cloudflare redirect or the `hhh` proxied dummy record.
- Do not point anything at `holistichealthhub.co.uk` unless that domain is actually live.
