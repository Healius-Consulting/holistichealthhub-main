# Deployment guidelines

This git repository (`Healius-Consulting/holistichealthhub-main`) is **production**. Push `main` to GitHub and the **HHH Vercel team** auto-deploys `holistichealthhub.live` and `portal.holistichealthhub.live`. Hobby Vercel staging is retired. Hosting details: [`.agents/skills/production-hosting/SKILL.md`](../skills/production-hosting/SKILL.md). `hhh.thinktimeless.co.uk` is a Cloudflare 301 for printed pharmacy QR codes, not a Vercel app. `holistichealthhub.cc` is the retired brand host, kept as a valid origin and attachable for preview flicker — never the brand in generated links.

Live order, fulfilment, and storage metadata traffic is **Firebase SQL Connect** (`dataconnect/` + `services/api-sql`) on project `hhh26-4ebd2` in `europe-west2`.

## Never deploy Firestore

Do **not** run `firebase deploy --only firestore`, `firestore:rules`, or `firestore:indexes`.
Do **not** treat `services/api` as the live order backend. The Cloud Function source is `services/api-sql`.

Firebase Auth, App Check, Secret Manager, and private Cloud Storage may remain.

## SQL Connect / api-sql

```bash
firebase use hhh26-4ebd2
firebase deploy --only dataconnect,functions
```

If Cloud SQL schema is behind the checked-in GraphQL, migrate first:

```bash
firebase dataconnect:sql:migrate --service hhh-platform-service
```

`dataconnect/dataconnect.yaml` uses `schemaValidation: COMPATIBLE` so unknown database objects are not dropped.

## Production Vercel (HHH team)

Two projects from this repo, root `./`, never `services/api`:

| Surface | `HHH_SURFACE` | Domain |
|---|---|---|
| Public | `public` | `holistichealthhub.live` |
| Portal | `portal` | `portal.holistichealthhub.live` |

Add each domain once on the matching HHH project. Pushes to `main` on `Healius-Consulting/holistichealthhub-main` deploy automatically — never `vercel alias`, never `*.vercel.app`.

Hobby `hhh-staging-*` projects are **retired**. Do not put production `.cc` domains or `hhh.thinktimeless.co.uk` on a personal Vercel account.

Verify: `curl -sI https://portal.holistichealthhub.live` and `curl -sI https://holistichealthhub.live`.
