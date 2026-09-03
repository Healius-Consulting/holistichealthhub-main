# Worldpay PayByLink Integration & Custom Branded Payment View Architecture

## 1. Worldpay Access Hosted Payment Pages (HPP) / PayByLink API
- **Endpoint**: `POST https://try.access.worldpay.com/payment_pages` (Production: `https://access.worldpay.com/payment_pages`)
- **Media Type**: `application/vnd.worldpay.payment_pages-v1.hal+json`
- **Authentication**: Basic Authentication with Worldpay username and password.
- **Request Shape**:
  ```json
  {
    "transactionReference": "ORD-MSWKEMXR",
    "merchant": { "entity": "PO4098149633" },
    "narrative": { "line1": "HHH Pharmacy" },
    "value": { "currency": "GBP", "amount": 1500 },
    "expiry": "604800",
    "resultURLs": {
      "successURL": "https://holistichealthhub.live/payment/success?ref=ORD-MSWKEMXR",
      "cancelURL": "https://holistichealthhub.live/payment/cancelled?ref=ORD-MSWKEMXR"
    }
  }
  ```
- **Response Shape**: HAL JSON containing `_links.redirect.href` or `url`.

---

## 2. Custom Branded Payment View Pattern
- Route: `/pay/:transactionReference` (e.g. `https://holistichealthhub.live/pay/ORD-MSWKEMXR`).
- Displays pharmacy branding, itemized prescribed medications, pack quantities, unit prices, dispensing fee, and total amount due.
- Provides embedded card checkout / Apple Pay / Google Pay and 1-click payment confirmation gate with live polling until cleared.

---

## 3. Staff-initiated outbound refunds

- HPP is not the complete Worldpay lifecycle. An authenticated pharmacy staff action may prepare a SQL `Refund` and submit the provider-supplied full or partial refund action.
- The transaction-reference query is only a summary; retrieve its `paymentId` detail resource before reading lifecycle events or refund action links.
- Discover actions from the queried payment resource. Support Card Payments `_links` and Payments API `_actions`; never construct opaque action URLs.
- Before forwarding credentials, require HTTPS and the exact configured Worldpay host.
- `202 Accepted` is not completion. Keep the refund `VERIFICATION_PENDING` until an authenticated provider query proves the full refund or exact partial amount/reference.
- A webhook may advance only an existing staff-prepared refund. It must never create or submit one.
- A timeout, `5xx`, `408`, or `429` is outcome-unknown. Do not automatically retry and do not direct staff to issue a second portal refund.
- ePOS remains prepare, refund on till, paste reference, confirm.

## 4. Pharmacy webhook setup

- Ask the pharmacy's Worldpay Implementation Manager to register `https://europe-west2-hhh26-4ebd2.cloudfunctions.net/apiLondon/v1/public/payments/worldpay/webhook` as its HTTPS payment-event destination.
- Enable the available payment lifecycle events, including `sentForSettlement`, `settlementFailed`, `sentForRefund`, `refunded`, and `refundFailed`.
- The endpoint treats the webhook as a reconciliation signal only. It resolves the stored `transactionReference`, then authenticates to Payment Queries with that pharmacy's API username/password and verifies the payment amount, currency, entity and refund evidence.
- Webhook delivery is helpful but not the sole recovery path; the scheduled reconciliation worker queries open Worldpay payments and staff-prepared refunds as well.
