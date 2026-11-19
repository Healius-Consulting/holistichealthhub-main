# Email roster

Source of truth: `services/api-sql/src/application/notifications/email-catalog.ts`.
Change copy, audience, or send-when there. This file is generated from that catalog.

Sender is one Holistic Health Hub address (`noreply@holistichealthhub.live` when the live Resend records are published). That mailbox is not monitored. Pharmacy contact details are included in the body where useful. Do not invent pharmacy-branded From addresses.

Templates marked with a Reply-To below send one, pointing at a monitored alias on `holistichealthhub.live`. Every other template sends none. Do not write copy that invites a reply without setting `replyTo` on the template.

Operational pharmacy emails go to the pharmacy email, or the superintendent when that inbox is blank. Account emails (invite, password reset, 2FA) still go to the individual staff member. Patient emails never include those addresses.

## Patient emails

- `patient_enquiry_declined` (enquiry.declined, enquiry.withdrawn): Sent to the patient when HHH admin declines or closes their enquiry. Three variants; the recorded reason is never quoted. Reply-To: `referrals@holistichealthhub.live`.
- `patient_referred` (referral.activated): Sent when HHH admin completes a referral and activates the pharmacy patient record. Reply-To: `referrals@holistichealthhub.live`.
- `patient_existing_clinic` (referral.activated): Sent when HHH admin refers a patient who already has a Curaleaf Clinic account. Reply-To: `referrals@holistichealthhub.live`.
- `patient_payment_request` (payment.link_created, payment.reminder): Sent when a Worldpay payment link is created or resent, and once more 72 hours later if it is still unpaid.
- `patient_payment_confirmation` (payment.settled): Sent once payment has been received (Worldpay settlement or manual pay), with a receipt link when available.
- `patient_refunded` (payment.refunded): Sent when pharmacy confirms a completed refund.
- `patient_ready_for_collection` (collection.ready): Sent when the order is marked ready to collect. Held until 09:00 on the next working day if after 15:00 Europe/London.

## Pharmacy owner emails

- `pharmacy_new_enquiry_assigned` (enquiry.submitted, enquiry.reassigned): Sent to the pharmacy owner when an eligibility enquiry is assigned to them.
- `pharmacy_enquiry_declined` (enquiry.declined): Sent to the pharmacy owner when HHH declines an enquiry that was assigned to them.
- `pharmacy_new_patient_referred` (referral.activated): Sent when HHH admin activates a referred patient for that pharmacy. Carries the patient name and contact details.
- `pharmacy_payment_received` (payment.settled): Sent when a patient payment is recorded (Worldpay settlement or manual pay).
- `pharmacy_order_accepted` (order.accepted): Sent when the pharmacy submits / accepts an order.
- `pharmacy_order_cancelled` (order.cancelled): Sent when Curaleaf reports a cancellation that needs pharmacy action.
- `pharmacy_delivery_issue` (order.delivery_issue): Sent when fulfilment maintenance detects a delay.
- `pharmacy_order_dispatched` (order.dispatched): Sent when Curaleaf reports the consignment as dispatched (or partially dispatched) to the pharmacy.
- `pharmacy_prescription_close_to_expiry` (order.near_expiry): Sent when a paid prescription is approaching its 28-day limit.
- `pharmacy_collection_completed` (collection.completed): Sent when the pharmacy records a handout / collection.
- `pharmacy_onboarding_submitted` (pharmacy_onboarding.terms_accepted): Sent: once per request, when the pharmacy accepts the Partner Terms (nothing is sent for the Curaleaf form alone). One email to the Terms signer and the request's pharmacy email (one address when they match). Wording, sender name and Reply-To are admin content (onboarding.email.sent); it mentions Worldpay by whether an application has been submitted, and links the Partner Terms only once they are published. Reply-To: `onboarding@holistichealthhub.live`.
- `pharmacy_onboarding_held` (pharmacy_onboarding.held): Hold: each time HHH puts a request on hold or changes the hold reason (lifting a hold sends nothing). To the Terms signer and the pharmacy email. Carries only the chosen reason's paragraphs (A existing Curaleaf customer, B more information needed, C Curaleaf declined), plus a Worldpay line when an application has been submitted. Admin content: onboarding.email.hold. Reply-To: `onboarding@holistichealthhub.live`.
- `pharmacy_onboarding_activated` (pharmacy_onboarding.activated): Activation: once per request, when HHH activates it and the branch is created in demonstration mode ("ready to try"). To the Terms signer and the pharmacy email. Includes the training booking link when one is set. Admin content: onboarding.email.activation. Reply-To: `onboarding@holistichealthhub.live`.
- `pharmacy_onboarding_live` (pharmacy_onboarding.live): Live: once per branch, the first time it goes live (Curaleaf PHAR code and API key saved); editing either later sends nothing. To the Terms signer and the pharmacy email. Gives the PHAR code (never the API key), how payment is taken (by whether live Worldpay credentials are validated) and the go-live checklist items still open at sending, each block left out when empty. Admin content: onboarding.email.live. Reply-To: `onboarding@holistichealthhub.live`.

## Staff login emails

- `pharmacy_staff_invite` (staff.invited): Sent when an HHH admin invites pharmacy staff or a platform admin. Reply-To: `IT@holistichealthhub.live`.
- `pharmacy_password_reset` (staff.password_reset): Sent from the staff login form, or when an HHH admin queues a reset. Reply-To: `IT@holistichealthhub.live`.
- `pharmacy_2fa_enabled` (staff.2fa_enabled): Sent after a staff member enrols an authenticator app. Reply-To: `IT@holistichealthhub.live`.
- `pharmacy_2fa_disabled` (staff.2fa_disabled): Sent after an HHH admin removes the authenticator app. Reply-To: `IT@holistichealthhub.live`.

## Admin emails

- `admin_new_enquiry_received` (enquiry.submitted): Sent to platform admins when a patient submits an eligibility enquiry.
- `curaleaf_new_account_application` (pharmacy_onboarding.terms_accepted): One email to Curaleaf Laboratories (To) with partner success copied (CC), sent once per request when the pharmacy accepts the Partner Terms, never at Curaleaf form submission alone. Attached: the filled form as Curaleaf-new-account_[GPhC]_[Branch]_[YYYY-MM-DD].pdf and the controlled drug licence. A demo GPhC goes to the CC list only, marked DEMO. Recipients are set in config; wording, sender name and Reply-To (Healius) are admin content (onboarding.email.curaleafApplication). Reply-To: `onboarding@holistichealthhub.live`.
- `worldpay_application_to_worldpay` (worldpay_application.submitted): WP-01. Sent straight away to the HHH admin inbox (the recipients set in admin) when a pharmacy submits its Worldpay application, for admin to forward to Worldpay. The application PDF and spreadsheet are attached, plus the service information PDF when the pharmacy has no website. Subject and wording are edited in admin; no personal or bank details are written in the body. Reply-To: `onboarding@holistichealthhub.live`.
