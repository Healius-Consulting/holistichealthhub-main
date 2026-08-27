# Email roster

Sender is one Holistic Health Hub address (`noreply@holistichealthhub.cc`). The From address stays on `.cc` because the Resend DKIM key and SES feedback MX are published there; links and CTAs inside the emails are on `holistichealthhub.live`. There is no Reply-To. This mailbox is not monitored. Pharmacy contact details are included in the body where useful. Do not invent pharmacy-branded From addresses.

## Patient emails

- `patient_payment_request`: sent when a Worldpay payment link is created or resent, and again as 24h/48h reminders.
- `patient_payment_confirmation`: sent once payment has been received (Worldpay settlement or manual pay), with a receipt link when available.
- `patient_refunded`: sent when pharmacy confirms a completed refund.
- `patient_ready_for_collection`: sent when the order is marked ready to collect.

## Staff login emails

- `pharmacy_staff_invite`: sent when an HHH admin invites pharmacy staff or a platform admin (sign up / set password).
- `pharmacy_password_reset`: sent from the staff login form, or when an HHH admin queues a reset.
- `pharmacy_2fa_enabled`: sent after a staff member enrols an authenticator app.
- `pharmacy_2fa_disabled`: sent after an HHH admin removes the authenticator app.

## Later

Pharmacy operations emails (referred, dispatched, cancelled, and so on) stay in the registry but are not part of this first send set.
