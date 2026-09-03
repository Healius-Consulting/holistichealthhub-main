# Email roster

Source of truth: `services/api-sql/src/application/notifications/email-catalog.ts`.
Change copy, audience, or send-when there. This file is generated from that catalog.

Sender is one Holistic Health Hub address (`noreply@holistichealthhub.live` when the live Resend records are published). There is no Reply-To. This mailbox is not monitored. Pharmacy contact details are included in the body where useful. Do not invent pharmacy-branded From addresses.

Operational pharmacy emails go to the **owner** account only (the earliest staff user for that pharmacy). Other staff do not receive them. Account emails (invite, password reset, 2FA) still go to the individual staff member.

## Patient emails

- `patient_referred` (referral.activated): Sent when HHH admin completes a referral and activates the pharmacy patient record.
- `patient_payment_request` (payment.link_created, payment.reminder): Sent when a Worldpay payment link is created or resent, and again as 24h/48h reminders.
- `patient_payment_confirmation` (payment.settled): Sent once payment has been received (Worldpay settlement or manual pay), with a receipt link when available.
- `patient_refunded` (payment.refunded): Sent when pharmacy confirms a completed refund.
- `patient_ready_for_collection` (collection.ready): Sent when the order is marked ready to collect. Held until 09:00 on the next working day if after 15:00 Europe/London.

## Pharmacy owner emails

- `pharmacy_new_enquiry_assigned` (enquiry.submitted, enquiry.reassigned): Sent to the pharmacy owner when an eligibility enquiry is assigned to them.
- `pharmacy_enquiry_declined` (enquiry.declined): Sent to the pharmacy owner when HHH declines an enquiry that was assigned to them.
- `pharmacy_new_patient_referred` (referral.activated): Sent when HHH admin activates a referred patient for that pharmacy.
- `pharmacy_payment_received` (payment.settled): Sent when a patient payment is recorded (Worldpay settlement or manual pay).
- `pharmacy_order_accepted` (order.accepted): Sent when the pharmacy submits / accepts an order.
- `pharmacy_order_cancelled` (order.cancelled): Sent when Curaleaf reports a cancellation that needs pharmacy action.
- `pharmacy_delivery_issue` (order.delivery_issue): Sent when fulfilment maintenance detects a delay.
- `pharmacy_order_dispatched` (order.dispatched): Sent when Curaleaf reports the consignment as dispatched (or partially dispatched) to the pharmacy.
- `pharmacy_prescription_close_to_expiry` (order.near_expiry): Sent when a paid prescription is approaching its 28-day limit.
- `pharmacy_collection_completed` (collection.completed): Sent when the pharmacy records a handout / collection.

## Staff login emails

- `pharmacy_staff_invite` (staff.invited): Sent when an HHH admin invites pharmacy staff or a platform admin.
- `pharmacy_password_reset` (staff.password_reset): Sent from the staff login form, or when an HHH admin queues a reset.
- `pharmacy_2fa_enabled` (staff.2fa_enabled): Sent after a staff member enrols an authenticator app.
- `pharmacy_2fa_disabled` (staff.2fa_disabled): Sent after an HHH admin removes the authenticator app.

## Admin emails

- `admin_new_enquiry_received` (enquiry.submitted): Sent to platform admins when a patient submits an eligibility enquiry.
