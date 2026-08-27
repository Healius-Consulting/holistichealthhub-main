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
