# Order identifier ownership

This document defines the canonical identifier for every record participating in an HHH pharmacy order. An identifier must not be copied into a differently named field or presented without its owning system.

## Staff-facing vocabulary

| UI label | Value | Where it may appear |
|---|---|---|
| Order | `Order.orderNumber` | Lists, dialogs, notifications and patient receipts |
| Rx 1 of N | Position within the HHH order | Order lists and prescription switchers; this is not an identifier |
| Prescription serial | `Prescription.serialNumber` | Selected prescription clinical details |
| Curaleaf prescription | `Prescription.supplierPrescriptionId` | Supplier support detail only |
| Curaleaf PO | `OrderPrescription.supplierPurchaseOrderId` | Selected prescription supplier detail only |
| Consignment | `Shipment.supplierShipmentId` | Goods-in and supplier support detail only |
| Payment reference | `Payment.transactionReference` or `Payment.manualReference` according to route | Finance and payment detail only |

HHH database UUIDs, receipt hashes and client correlation keys are never staff-facing references.

## Canonical storage

| Resource | HHH identity | External identity | Correlation only |
|---|---|---|---|
| Order | `Order.id` | — | `Order.orderNumber` is the stable business reference |
| Prescription | `Prescription.id` | `Prescription.supplierPrescriptionId` | `Prescription.serialNumber` is a clinical serial, not a technical key |
| Purchase order link | composite `OrderPrescription(orderId, prescriptionId)` | `supplierPurchaseOrderId` | Curaleaf `customerReference` is retained in integration/audit data only |
| Shipment | `Shipment.id` | `Shipment.supplierShipmentId` | `supplierCustomerReference` is retained for matching only |
| Payment | `Payment.id` | `transactionReference` and `providerPaymentId` | `receiptHash` is a public receipt capability token |
| Prescription file | `PrescriptionFile.id` | — | `fileId` is an attachment relationship and must never identify a prescription |

## Client contract

- Persisted records use their HHH UUID as `id` at API boundaries.
- A not-yet-persisted prescription uses `clientKey`. It must not be called `id` or derived from `fileId`.
- `purchaseOrderId` always means the Curaleaf purchase-order ID. Curaleaf `customerReference` must never be assigned to it.
- An order response must not repeat `orderNumber` as `paymentTransactionReference`.
- Payment, shipment and supplier identifiers are returned only when that detail is required by the current authorised workflow.

## Legacy compatibility and removal

Historical `quoteSnapshot` records may contain prescription keys under `id` or `fileId`, and supplier identities under `curaleaf` / `curaleafSubOrders`. These values are read-only compatibility inputs. New writes use `clientKey`, stamp `hhhPrescriptionId`, and write normalized prescription, order-prescription and shipment records.

Before removing the legacy readers:

1. Backfill `hhhPrescriptionId` for every snapshot prescription.
2. Backfill `Prescription.supplierPrescriptionId`, `OrderPrescription.supplierPurchaseOrderId`, and `Shipment.supplierShipmentId` from verified supplier responses.
3. Shadow-compare normalized projections with the legacy snapshot for at least one complete fulfilment cycle.
4. Quarantine mismatches rather than guessing ownership.
5. Remove the `id` and `fileId` snapshot-key fallbacks only after the mismatch count is zero.

