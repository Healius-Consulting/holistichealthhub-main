# Email roster

Sender is one Holistic Health Hub address (`noreply@holistichealthhub.live` when the live Resend records are published). There is no Reply-To. This mailbox is not monitored. Pharmacy contact details are included in the body where useful. Do not invent pharmacy-branded From addresses.

Operational pharmacy emails go to the **owner** account only (the earliest staff user for that pharmacy). Other staff do not receive them. Account emails (invite, password reset, 2FA) still go to the individual staff member.

## Patient emails

- `patient_referred`: sent when HHH admin completes a referral and activates the pharmacy patient record. Tells the patient which pharmacy is their point of contact for prescription orders.
- `patient_payment_request`: sent when a Worldpay payment link is created or resent, and again as 24h/48h reminders.
- `patient_payment_confirmation`: sent once payment has been received (Worldpay settlement or manual pay), with a receipt link when available.
- `patient_refunded`: sent when pharmacy confirms a completed refund.
- `patient_ready_for_collection`: sent when the order is marked ready to collect.

## Pharmacy owner emails

- `pharmacy_new_patient_referred`: sent when HHH admin activates a referred patient for that pharmacy.
- `pharmacy_payment_received`: sent when a patient payment is recorded (Worldpay settlement or manual pay).
- `pharmacy_order_accepted`: sent when the pharmacy submits / accepts an order.
- `pharmacy_order_cancelled`: sent when Curaleaf reports a cancellation that needs pharmacy action.
- `pharmacy_delivery_issue`: sent when fulfilment maintenance detects a delay.
- `pharmacy_order_dispatched`: sent when Curaleaf reports the consignment as dispatched (or partially dispatched) to the pharmacy.
- `pharmacy_prescription_close_to_expiry`: sent when a paid prescription is approaching its 28-day limit.
- `pharmacy_collection_completed`: sent when the pharmacy records a handout / collection.

## Staff login emails

- `pharmacy_staff_invite`: sent when an HHH admin invites pharmacy staff or a platform admin (sign up / set password).
- `pharmacy_password_reset`: sent from the staff login form, or when an HHH admin queues a reset.
- `pharmacy_2fa_enabled`: sent after a staff member enrols an authenticator app.
- `pharmacy_2fa_disabled`: sent after an HHH admin removes the authenticator app.

## Admin emails

- `admin_new_enquiry_received`: sent to platform admins when a patient submits an eligibility enquiry. Includes the patient’s name, phone, email and case reference.
