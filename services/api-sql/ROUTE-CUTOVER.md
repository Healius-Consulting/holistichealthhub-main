# Route and worker cutover matrix

This matrix groups the existing HTTP contract by data dependency. It is a
planning inventory, not permission to move every route in a group at once.

## Slice 0 — platform foundation

Scope:

- `/health` remains storage-neutral.
- Common error mapping, request IDs, structured logging and rate limits.
- SQL Connect initialization and generated server SDK.
- Domain feature flags, shadow comparison and migration outbox processing.

Entry gate: schema-hardening diff reviewed.

Exit gate: the new package builds and emulator tests pass without serving public
or portal traffic.

## Slice 1 — authentication, tenancy and portal admission

Routes and callers:

- `/v1/auth/csrf`
- `/v1/auth/session` (`POST`, `GET`, `DELETE`)
- `/v1/auth/activity`
- `/v1/portal/session`
- `api/page-gate.ts`
- staff disablement and MFA-reset session revocation paths

SQL tables:

- `Organisation`, `OrganisationDomain`, `StaffUser`, `StaffSession`, `AuditLog`

Required operations:

- exact staff-by-UID admission lookup;
- exact session-hash lookup and guarded touch;
- create/revoke current session;
- revoke all sessions for disabled staff;
- append security audit event.

Exit gate: disabled, expired, idle-expired, revoked, wrong-role, wrong-tenant and
wrong-surface cases match the existing fail-closed behaviour in both API and page
gate.

## Slice 2 — organisations, setup and public directory

Route families:

- `/v1/portal/preferences`
- `/v1/portal/setup/*`
- `/v1/portal/payment-settings`
- `/v1/portal/admin/companies/*`
- `/v1/portal/admin/organisations/*`
- organisation logo upload/complete/delete
- go-live readiness/go-live routes
- `/v1/public/pharmacies/by-token/:token` (directory projection only)

SQL tables:

- `Company`, `Organisation`, `OrganisationDomain`, `SetupTask`,
  `PharmacyDirectoryProfile`, `ReferralToken`, `IntegrationConnection`

Special controls:

- admin cross-tenant changes require a target organisation and audit reason;
- public resolution returns only the directory allowlist;
- token hashes, never raw referral tokens, are queried;
- secret values stay in Secret Manager;
- Storage logo paths are organisation-bound.

## Slice 3 — eligibility and patient activation

Route families:

- `/v1/public/eligibility-submissions`
- `/v1/portal/eligibility-submissions*`
- `/v1/portal/admin/eligibility-submissions/*`
- `/v1/portal/patients*`
- `/v1/portal/admin/patient-register`
- `/v1/portal/admin/patient-exports`

SQL tables:

- `Condition`, `EligibilitySubmission`, `EligibilityConsent`,
  `EligibilityCondition`, `EligibilityAssignmentEvent`, `Patient`,
  `PatientIdentity`, `PatientCondition`

Special controls:

- public submission requires App Check, token limits and a unique idempotency
  hash;
- allocation uses `assignmentVersion` and one transaction;
- pharmacy access is impossible before allocation and onboarding approval;
- patient deduplication is scoped by organisation and hashed identity;
- exports are admin-only, bounded and separately audited.

## Slice 4 — prescriptions and private files

Route families:

- `/v1/portal/prescribers*`
- `/v1/portal/prescription-files/*`
- prescription scan/manual/barcode/renewal routes
- patient unresolved-order projection

SQL tables:

- `Prescriber`, `PrescriptionFile`, `Prescription`, `PrescriptionLine`

Special controls:

- file metadata is SQL; binaries remain private Cloud Storage;
- signed URLs require tenant, purpose, object state and TTL checks;
- upload completion verifies the actual object before SQL status transition;
- delete means retained-state transition and object lifecycle handling, not an
  unreviewed SQL hard delete.

## Slice 5 — drafts, orders and placement

Route families:

- `/v1/portal/order-drafts*`
- `/v1/portal/orders*`
- handout, expiry, cancellation and archive actions
- placement, substitution, line cancellation, rejection and renewal actions
- quote-review approval

SQL tables:

- `OrderDraft`, `Order`, `OrderPrescription`, `OrderLine`, `PlacementEvent`,
  `StaffTask`

Special controls:

- **Transfer filter**: Migration backfill only imports live orders from the primary pharmacy
  that were sent to Curaleaf. Rejected, cancelled, draft, and test orders are purged /
  excluded from the SQL transfer and marked as filtered in the migration ledger;
- response mappers preserve the existing embedded API projection while SQL is
  normalized;
- expected versions guard draft/order transitions;
- order totals are computed server-side from validated lines;
- placement writes and event history are atomic;
- paid or collected history is append-only and cannot be silently rewritten.

## Slice 6 — payments, receipts and refunds

Route families:

- `/v1/public/payment-receipts/:token`
- `/v1/public/worldpay/webhooks/:organisationId`
- manual payment routes
- Worldpay session/payment-link routes
- manual refund and refund-confirmation routes
- line refund confirmation

SQL tables:

- `Payment`, `PaymentReceipt`, `Refund`, `IntegrationWebhookEvent`,
  `IntegrationOperation`, `AuditLog`

Special controls:

- webhook route organisation input is only a routing hint; transaction, amount,
  currency and organisation are resolved from authoritative SQL/provider state;
- receipt tokens are stored as hashes and cannot mutate payment state;
- duplicate provider events and refund requests are idempotent;
- provider success redirects never mark an order paid;
- payment/order/refund transitions are transactional and audited.

## Slice 7 — Curaleaf integration and fulfilment

Route families:

- `/v1/portal/integrations/:integration/*`
- Curaleaf catalogue, activity, quote, prescription and support-case routes
- order placement/cancellation integration routes
- `/v1/portal/shipments*`
- goods receipts and shipment status

SQL tables:

- `IntegrationConnection`, `IntegrationOperation`, `IntegrationWebhookEvent`,
  `Shipment`, `ShipmentLine`, `GoodsReceipt`, `GoodsReceiptLine`,
  `DispenseEvent`, `StaffTask`

Special controls:

- credentials are fetched from Secret Manager only after a tenant-scoped
  connection lookup;
- supplier operations have unique idempotency keys and explicit retry states;
- shipment, receipt, dispense and collection remain separate transitions;
- partial receipt quantities and batch/expiry fields are validated atomically.

## Slice 8 — finance, notifications, admin reports and workers

Route/worker families:

- pharmacy prescription finance and admin referral finance
- pharmacy overview and admin patient reporting
- notification outbox delivery
- Curaleaf and Worldpay reconciliation
- payment lifecycle and order maintenance
- Curaleaf mirror/event polling and poller watchdog
- annual patient fee accrual and retention updates
- go-live audit and prescription-file cleanup

SQL tables:

- `ReferralFeeEvent`, `NotificationOutbox`, `IntegrationOperation`,
  `DispenseEvent`, `AuditLog`, plus read models from earlier slices

Special controls:

- workers claim bounded batches with a lease or expected-version transition;
- retries are idempotent and poison records become visible staff tasks;
- reports use tenant-safe aggregates and hard date/page limits;
- provider payloads and patient details are absent from operational logs.

## Per-slice release sequence

Every slice follows the same order:

1. inventory and validate Firestore source data;
2. run migration dry-run and quarantine invalid records;
3. backfill SQL idempotently and reconcile counts/keys/statuses;
4. enable SQL shadow reads while Firestore remains authoritative;
5. enable the Firestore transaction outbox and drain deltas;
6. freeze writes briefly, reconcile and switch SQL reads/writes;
7. monitor security, parity, latency and provider metrics;
8. keep the Firestore rollback flag until the approved checkpoint;
9. sign off and proceed to the next slice.

No later slice may bypass a dependency slice's unresolved reconciliation or
authorization failure.
