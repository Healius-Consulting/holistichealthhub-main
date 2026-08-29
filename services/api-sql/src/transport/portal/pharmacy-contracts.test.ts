import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { OrderRecord } from '../../repositories/ports/order.port.js';
import type { OrganisationRecord } from '../../repositories/ports/organisation.port.js';
import type { PatientRecord } from '../../repositories/ports/patient.port.js';
import {
  buildPharmacyPatientDirectory,
  buildSqlPharmacyOverview,
  overviewIntegrationHealth,
  toPortalOrder,
  toPortalOrganisation,
  toPortalPatient,
  toPortalPendingEnquiry,
} from './pharmacy-contracts.js';

const organisation: OrganisationRecord = {
  id: '70913a30-71c3-4a41-952e-d532927af58c',
  companyId: null,
  name: 'Example Pharmacy Ltd',
  tradingName: 'Example Pharmacy',
  gphcNumber: '1234567',
  superintendentName: 'Superintendent',
  mainContactName: null,
  mainContactPhone: null,
  mainContactEmail: null,
  address: '1 High Street',
  addressLine1: '1 High Street',
  addressLine2: null,
  locality: 'Nottingham',
  county: null,
  postcode: 'NG16 3AA',
  latitude: 52.95,
  longitude: -1.15,
  primaryColour: '#0f766e',
  logoText: 'EP',
  status: 'LIVE',
  classification: 'STANDARD',
  portalName: 'Example Portal',
  intakeEnabled: true,
  prescriptionEnabled: true,
  paymentsEnabled: true,
  supplierOrdersEnabled: true,
  patientsEnabled: true,
  resourcesEnabled: true,
  worldpayEnabled: false,
  defaultPaymentRoute: 'MANUAL',
  pharmacyDeliveryEnabled: false,
  autoPlacementEnabled: true,
  gdprComplianceFlag: true,
  pausedReason: null,
  pausedAt: null,
  version: 1,
};

const patient: PatientRecord = {
  id: '00000000-0000-4000-a000-000000000001',
  organisationId: organisation.id,
  sourceSubmissionId: '00000000-0000-4000-a000-000000000099',
  firstName: 'Alicia',
  surname: 'Patient',
  dob: '1990-01-01',
  email: 'patient@example.test',
  mobile: '07000000000',
  address: null,
  postcode: 'SW1A 1AA',
  status: 'ACTIVE',
  activatedAt: '2026-08-01T09:00:00.000Z',
  statusChangedAt: null,
  version: 1,
  createdAt: '2026-08-01T09:00:00.000Z',
  updatedAt: '2026-08-01T09:00:00.000Z',
  conditions: [],
  sourceSubmission: null,
};

const order: OrderRecord = {
  id: '00000000-0000-4000-a000-000000000002',
  organisationId: organisation.id,
  patientId: patient.id,
  draftId: null,
  orderNumber: 'ORD-1001',
  status: 'SUBMITTED',
  paymentStatus: 'PENDING',
  fulfilmentStatus: 'SUPPLIER_PROCESSING',
  paymentRoute: 'MANUAL',
  currency: 'GBP',
  medicineTotalPence: 10000,
  dispensingFeePence: 500,
  pharmacyDeliveryPence: 0,
  deliveryPence: 0,
  taxPence: 0,
  totalPence: 10500,
  quoteSnapshot: null,
  version: 1,
  submittedAt: '2026-08-01T10:00:00.000Z',
  paidAt: null,
  collectedAt: null,
  cancelledAt: null,
  createdAt: '2026-08-01T10:00:00.000Z',
  updatedAt: '2026-08-01T10:00:00.000Z',
};

describe('SQL pharmacy compatibility contracts', () => {
  it('maps SQL organisation enums to the portal contract', () => {
    const mapped = toPortalOrganisation(organisation);
    assert.equal(mapped.status, 'live');
    assert.equal(mapped.intakeEnabled, true);
    assert.equal(toPortalOrganisation({ ...organisation, status: 'INTAKE_LIVE' }).status, 'onboarding');
    assert.equal(mapped.workspaceClassification, 'standard');
    assert.equal(mapped.defaultPaymentRoute, 'manual');
    assert.equal('platformFeeMonthly' in mapped, false);
    assert.equal('modules' in mapped, false);
  });

  it('maps a tenant patient without exposing another tenant selector', () => {
    const mapped = toPortalPatient(patient);
    assert.equal(mapped.organisationId, organisation.id);
    assert.equal(mapped.status, 'active');
    assert.equal(mapped.address, '');
    assert.deepEqual(mapped.conditions, []);
  });

  it('maps referred patient eligibility from conditions and source submission', () => {
    const mapped = toPortalPatient({
      ...patient,
      status: 'REFERRED',
      conditions: [
        { conditionCode: 'chronic-pain', primary: true },
        { conditionCode: 'anxiety', primary: false },
      ],
      sourceSubmission: {
        sourceType: 'PHARMACY_QR',
        triedTwoTreatments: true,
        psychiatricExclusion: false,
        heardAbout: 'Pharmacy poster',
        marketingConsent: true,
        conditionCodes: ['chronic-pain', 'anxiety'],
        primaryConditionCode: 'chronic-pain',
      },
    });
    assert.equal(mapped.status, 'referred');
    assert.deepEqual(mapped.conditions, ['chronic-pain', 'anxiety']);
    assert.equal(mapped.primaryCondition, 'chronic-pain');
    assert.equal(mapped.referralSource, 'future_pharmacy_qr');
    assert.equal(mapped.triedTwoTreatments, true);
    assert.equal(mapped.psychiatricExclusion, false);
    assert.equal(mapped.heardAbout, 'Pharmacy poster');
    assert.equal(mapped.marketingConsent, true);
  });

  it('prefers eligibility form conditions over copied patient-condition rows', () => {
    const mapped = toPortalPatient({
      ...patient,
      conditions: [{ conditionCode: 'stale-copy', primary: true }],
      sourceSubmission: {
        sourceType: 'GENERAL_HHH_WEBSITE',
        triedTwoTreatments: true,
        psychiatricExclusion: false,
        heardAbout: null,
        marketingConsent: false,
        conditionCodes: ['endometriosis', 'chronic-pain'],
        primaryConditionCode: 'endometriosis',
      },
    });
    assert.deepEqual(mapped.conditions, ['endometriosis', 'chronic-pain']);
    assert.equal(mapped.primaryCondition, 'endometriosis');
    assert.equal(mapped.referralSource, 'general_hhh_website');
  });

  it('maps a migrated SQL order to the rich list contract', () => {
    const mapped = toPortalOrder(order);
    assert.equal(mapped.organisationId, organisation.id);
    assert.equal(mapped.paymentStatus, 'pending');
    assert.equal(mapped.fulfilmentStatus, 'supplier_processing');
    assert.equal(mapped.curaleaf, undefined);
    assert.deepEqual(mapped.lineItems, []);
  });

  it('maps a paid order waiting on Curaleaf prescription approval without inventing a purchase order', () => {
    const mapped = toPortalOrder({
      ...order,
      paymentStatus: 'PAID',
      paidAt: '2026-08-18T18:25:53.380340Z',
      fulfilmentStatus: 'SUPPLIER_PROCESSING',
      quoteSnapshot: {
        lineItems: [{
          packId: '9f2d6958-2d76-4338-9e5f-6fd383dfff36',
          productId: '9f2d6958-2d76-4338-9e5f-6fd383dfff36',
          formulaId: 'f74f63de-dc89-4074-9d8c-be35f5398963',
          name: '4C Labs BWD T30 Beach Wedding, 30% THC <1% CBD',
          quantity: 1,
          unitPricePence: 8500,
        }],
        prescriptions: [{
          id: 'rx-pending',
          fileId: 'rx-pending',
          serialNumber: '34CD78GH',
          issueDate: '2026-08-18',
          prescriber: { name: 'Dr Prescriber', pin: '123', gmcNumber: null, gphcNumber: '000123', initials: 'DP' },
          items: [],
        }],
        curaleaf: {
          status: 'prescription_pending',
          prescriptionId: '2bd0fa9f-50ee-4344-a5fa-d0da95ac83aa',
          prescriberId: '1c2ccf78-1307-4233-b420-2348fd04065c',
          prescriptionState: 'PENDING',
          waitingSince: '2026-08-18T09:00:00.000Z',
        },
      },
    });
    assert.equal(mapped.paymentStatus, 'paid');
    assert.equal(mapped.fulfilmentStatus, 'supplier_pending');
    assert.equal(mapped.curaleaf?.status, 'prescription_pending');
    assert.equal(mapped.curaleaf?.prescriptionState, 'PENDING');
    assert.equal(mapped.curaleaf?.purchaseOrderId, null);
    assert.equal(mapped.curaleaf?.waitingSla?.dueAt, '2026-08-18T12:00:00.000Z');
    assert.equal(mapped.curaleaf?.waitingSla?.policy, 'three_hours');
    assert.equal(mapped.curaleafPlacement?.route, 'MANUAL_PRESCRIPTION');
    assert.equal(mapped.curaleafPlacement?.stage, 'AWAITING_PRESCRIPTION_ACTIVATION');
    assert.equal(mapped.curaleafPlacement?.slaDueAt, '2026-08-18T12:00:00.000Z');
    assert.equal(mapped.curaleafPlacement?.slaPolicy, 'three_hours');
    assert.equal(mapped.prescriptionFlow['rx-pending']?.state, 'PENDING_PLACEMENT');
    assert.deepEqual(mapped.serialReuse, { until: '2026-09-11', filePresent: true });
  });

  it('projects quote-gate history, payment allocation, redo resolution, and Curaleaf placement SLA', () => {
    const mapped = toPortalOrder({
      ...order,
      redoOfId: '00000000-0000-4000-a000-000000000099',
      paymentStatus: 'PAID',
      paidAt: '2026-08-18T10:00:00.000Z',
      resolutionStatus: 'RESOLVED',
      resolutionReason: 'REPLACED',
      resolvedAt: '2026-08-18T11:00:00.000Z',
      archivedAt: '2026-08-18T11:00:00.000Z',
      quoteSnapshot: {
        prescriptions: [{
          id: 'rx-manual',
          fileId: 'rx-manual',
          serialNumber: 'RX-MANUAL',
          issueDate: '2026-08-18',
          prescriber: { name: 'Dr Prescriber', pin: '123', gmcNumber: null, gphcNumber: '000123', initials: 'DP' },
          items: [],
        }],
        paymentQuote: {
          id: 'quote-pre',
          status: 'MATCHED',
          checkedAt: '2026-08-18T09:00:00.000Z',
          basketFingerprint: 'basket-a',
          patientTotalPence: 10500,
          wholesaleTotalPence: 7000,
          shippingPence: 500,
        },
        quoteChecks: [{
          id: 'quote-post',
          phase: 'POST_PAYMENT',
          status: 'REVIEW_REQUIRED',
          createdAt: '2026-08-18T10:05:00.000Z',
          basketFingerprint: 'basket-a',
          baselineQuoteCheckId: 'quote-pre',
          patientTotalPence: 11000,
          wholesaleTotalPence: 7100,
          shippingPence: 500,
          comparison: { patientDeltaPence: 500, wholesaleDeltaPence: 100 },
        }],
        paymentAllocation: {
          id: 'allocation-1',
          paymentId: 'payment-1',
          amountPence: 10500,
          status: 'ACTIVE',
          sourceOrderId: '00000000-0000-4000-a000-000000000099',
          replacementOrderId: order.id,
          updatedAt: '2026-08-18T10:01:00.000Z',
        },
        redoContext: {
          originalOrderId: '00000000-0000-4000-a000-000000000099',
          replacementReason: 'Curaleaf cancellation',
        },
        curaleaf: {
          prescriptionId: 'prescription-1',
          prescriberId: 'prescriber-1',
          prescriberState: 'UNVERIFIED',
          prescriptionState: 'PENDING',
          waitingFor: 'prescriber_verification',
          waitingSince: '2026-08-18T09:00:00.000Z',
        },
      },
    });

    assert.deepEqual(mapped.quoteChecks.map(check => check.id), ['quote-pre', 'quote-post']);
    assert.equal(mapped.activeQuoteCheck?.status, 'CHANGED');
    assert.equal(mapped.activeQuoteCheck?.checkedAt, '2026-08-18T10:05:00.000Z');
    assert.equal(mapped.activeQuoteCheck?.patientDeltaPence, 500);
    assert.equal(mapped.paymentAllocation?.id, 'allocation-1');
    assert.equal(mapped.paymentAllocation?.sourceOrderId, '00000000-0000-4000-a000-000000000099');
    assert.equal(mapped.resolution?.status, 'REPLACED');
    assert.equal(mapped.resolution?.archivedAt, '2026-08-18T11:00:00.000Z');
    assert.equal(mapped.redoOfOrderId, '00000000-0000-4000-a000-000000000099');
    assert.equal(mapped.redoContext?.originalOrderId, '00000000-0000-4000-a000-000000000099');
    assert.equal(mapped.curaleafPlacement?.stage, 'AWAITING_PRESCRIBER_VERIFICATION');
    assert.equal(mapped.curaleafPlacement?.slaDueAt, '2026-08-18T12:00:00.000Z');
  });

  it('preserves closed quote-check decisions instead of reopening them as changed', () => {
    const mapped = toPortalOrder({
      ...order,
      paymentStatus: 'PAID',
      paidAt: '2026-08-18T10:00:00.000Z',
      sqlQuoteChecks: [{
        id: 'quote-absorbed',
        organisationId: order.organisationId,
        orderId: order.id,
        paymentId: 'payment-1',
        phase: 'POST_PAYMENT',
        status: 'ABSORBED',
        baselineQuoteCheckId: 'quote-pre',
        basketFingerprint: 'basket-a',
        quoteFingerprint: 'quote-b',
        patientTotalPence: 11000,
        wholesaleTotalPence: 7100,
        shippingPence: 500,
        taxPence: 0,
        rawQuote: {},
        comparison: { patientDeltaPence: 500 },
        createdAt: '2026-08-18T10:05:00.000Z',
      }],
    });

    assert.equal(mapped.activeQuoteCheck?.status, 'ABSORBED');
  });

  it('copies stored quote wholesale onto portal line items', () => {
    const mapped = toPortalOrder({
      ...order,
      paymentStatus: 'PAID',
      paidAt: '2026-08-18T18:25:53.380340Z',
      quoteSnapshot: {
        lineItems: [{
          packId: '9f2d6958-2d76-4338-9e5f-6fd383dfff36',
          productId: '9f2d6958-2d76-4338-9e5f-6fd383dfff36',
          formulaId: 'f74f63de-dc89-4074-9d8c-be35f5398963',
          name: '4C Labs BWD T30 Beach Wedding, 30% THC <1% CBD',
          quantity: 4,
          unitPricePence: 8500,
        }],
        quote: {
          shippingPrice: '5.00',
          taxRate: '0.2',
          items: [{
            packId: '9f2d6958-2d76-4338-9e5f-6fd383dfff36',
            quantity: 4,
            inStock: true,
            wholesalePackPrice: '68.00',
            patientPackPrice: '85.00',
          }],
        },
      },
    });
    assert.equal(mapped.lineItems[0]?.wholesalePackPricePence, 6800);
    assert.equal(mapped.pricingQuote?.items[0]?.wholesalePackPrice, '68.00');
    assert.equal(mapped.pricingQuote?.items[0]?.packId, '9f2d6958-2d76-4338-9e5f-6fd383dfff36');
  });

  it('prefers the stored quote patient price over snapshot unit prices', () => {
    const mapped = toPortalOrder({
      ...order,
      paymentStatus: 'PAID',
      paidAt: '2026-08-18T18:25:53.380340Z',
      quoteSnapshot: {
        lineItems: [{
          packId: 'pack-a',
          productId: 'pack-a',
          formulaId: 'formula-a',
          name: 'Quoted pack',
          quantity: 1,
          unitPricePence: 8500,
          wholesalePackPricePence: 5000,
        }],
        quote: {
          shippingPrice: '5.00',
          taxRate: '0',
          items: [{
            packId: 'pack-a',
            quantity: 1,
            inStock: true,
            wholesalePackPrice: '72.00',
            patientPackPrice: '92.00',
          }],
        },
      },
    });
    assert.equal(mapped.lineItems[0]?.unitPricePence, 9200);
    assert.equal(mapped.lineItems[0]?.wholesalePackPricePence, 7200);
  });

  it('unwraps nested quote wrappers and id-keyed items onto line wholesale', () => {
    const mapped = toPortalOrder({
      ...order,
      paymentStatus: 'PAID',
      paidAt: '2026-08-18T18:25:53.380340Z',
      quoteSnapshot: {
        lineItems: [{
          packId: 'pack-a',
          productId: 'pack-a',
          formulaId: 'formula-a',
          name: '4C Labs BWD T30 Beach Wedding, 30% THC <1% CBD',
          quantity: 1,
          unitPricePence: 8500,
        }],
        pricingQuote: {
          data: {
            items: [{
              id: 'pack-a',
              packsOrderedCount: 1,
              inStock: true,
              wholesalePackPrice: '68.00',
              patientPackPrice: '85.00',
            }],
            shippingPrice: '5.00',
            taxRate: '0.2',
          },
        },
      },
    });
    assert.equal(mapped.lineItems[0]?.wholesalePackPricePence, 6800);
    assert.equal(mapped.pricingQuote?.items[0]?.packId, 'pack-a');
    assert.equal(mapped.pricingQuote?.items[0]?.wholesalePackPrice, '68.00');
  });

  it('keeps wholesale stamped on snapshot line items when quote items are missing', () => {
    const mapped = toPortalOrder({
      ...order,
      paymentStatus: 'PAID',
      paidAt: '2026-08-18T18:25:53.380340Z',
      quoteSnapshot: {
        lineItems: [{
          packId: 'pack-a',
          productId: 'pack-a',
          formulaId: 'formula-a',
          name: '4C Labs BWD T30 Beach Wedding, 30% THC <1% CBD',
          quantity: 4,
          unitPricePence: 8500,
          wholesalePackPricePence: 6800,
        }],
      },
    });
    assert.equal(mapped.lineItems[0]?.wholesalePackPricePence, 6800);
  });

  it('maps a paid quote-review hold without inventing a purchase order', () => {
    const mapped = toPortalOrder({
      ...order,
      paymentStatus: 'PAID',
      paidAt: '2026-08-18T18:25:53.380340Z',
      fulfilmentStatus: 'SUPPLIER_PENDING',
      quoteSnapshot: {
        lineItems: [{
          packId: '9f2d6958-2d76-4338-9e5f-6fd383dfff36',
          productId: '9f2d6958-2d76-4338-9e5f-6fd383dfff36',
          formulaId: 'f74f63de-dc89-4074-9d8c-be35f5398963',
          name: '4C Labs BWD T30 Beach Wedding, 30% THC <1% CBD',
          quantity: 1,
          unitPricePence: 8500,
        }],
        prescriptions: [{
          id: 'rx-review',
          fileId: 'rx-review',
          serialNumber: '34CD78GH',
          issueDate: '2026-08-18',
          prescriber: { name: 'Dr Prescriber', pin: '123', gmcNumber: null, gphcNumber: '000123', initials: 'DP' },
          items: [],
        }],
        quoteReview: {
          status: 'required',
          type: 'patient_price_changed',
          fingerprint: 'abc',
          latestQuote: {},
          differences: [],
          patientDeltaPence: 500,
          checkedAt: '2026-08-18T20:00:00.000Z',
        },
      },
    });
    assert.equal(mapped.paymentStatus, 'paid');
    assert.equal(mapped.quoteReview?.status, 'required');
    assert.equal(mapped.curaleaf?.status, 'quote_review_required');
    assert.equal(mapped.curaleaf?.purchaseOrderId, null);
    assert.equal(mapped.prescriptionFlow['rx-review']?.state, 'HELD_PRICE');
    assert.equal(mapped.unresolvedReason, undefined);
  });

  it('keeps a paid Curaleaf-cancelled purchase order paid so staff can choose replacement or refund', () => {
    const mapped = toPortalOrder({
      ...order,
      status: 'PROCESSING',
      paymentStatus: 'PAID',
      paidAt: '2026-08-18T18:25:53.380340Z',
      fulfilmentStatus: 'EXCEPTION',
      quoteSnapshot: {
        quoteReview: {
          status: 'required',
          type: 'out_of_stock',
          fingerprint: 'abc',
          latestQuote: {},
          differences: [],
          patientDeltaPence: 0,
          checkedAt: '2026-08-18T20:00:00.000Z',
        },
        cancellation: { status: 'refund_required', reason: 'other' },
        curaleafCancellation: { status: 'confirmed', confirmationReference: 'phone_cs_confirmed' },
        lineItems: [{
          packId: '9f2d6958-2d76-4338-9e5f-6fd383dfff36',
          productId: '9f2d6958-2d76-4338-9e5f-6fd383dfff36',
          formulaId: 'f74f63de-dc89-4074-9d8c-be35f5398963',
          name: '4C Labs BWD T30 Beach Wedding, 30% THC <1% CBD',
          quantity: 1,
          unitPricePence: 8500,
        }],
        prescriptions: [{
          id: 'rx-cancelled',
          fileId: 'rx-cancelled',
          serialNumber: '34CD78GH',
          issueDate: '2026-08-18',
          prescriber: { name: 'Dr Prescriber', pin: '123', gmcNumber: null, gphcNumber: '000123', initials: 'DP' },
          items: [],
        }],
        curaleaf: {
          status: 'prescription_closed',
          prescriptionId: '2bd0fa9f-50ee-4344-a5fa-d0da95ac83aa',
          purchaseOrderId: 'f287b3b8-d83f-478d-a7e6-34f4cc527f86',
          purchaseOrderState: 'CANCELLED',
          state: 'CANCELLED',
        },
      },
    });
    assert.equal(mapped.paymentStatus, 'paid');
    assert.equal(mapped.refund, undefined);
    assert.equal(mapped.status, 'cancelled');
    assert.equal(mapped.unresolvedReason, 'cancelled');
    assert.equal(mapped.quoteReview, undefined);
    assert.equal(mapped.curaleaf?.purchaseOrderState, 'CANCELLED');
    assert.equal(mapped.curaleaf?.status, 'prescription_closed');
    assert.equal(mapped.prescriptionFlow['rx-cancelled']?.state, 'CANCELLED_PURCHASE_ORDER');
  });

  it('maps a paid cancel with CANCELLED payment column and no snapshot refund as still paid, without inventing a refund task', () => {
    const mapped = toPortalOrder({
      ...order,
      status: 'CANCELLED',
      paymentStatus: 'CANCELLED',
      paidAt: '2026-08-18T23:32:00.000Z',
      fulfilmentStatus: 'EXCEPTION',
      totalPence: 10000,
      paymentRoute: 'MANUAL',
      quoteSnapshot: {
        cancellation: { status: 'refund_required', reason: 'other' },
        curaleafCancellation: { status: 'confirmed', confirmationReference: 'phone_cs_confirmed' },
        curaleaf: {
          status: 'prescription_closed',
          purchaseOrderId: 'd02fd012-6595-486d-b8ec-9bc847ff5936',
          purchaseOrderState: 'CANCELLED',
          state: 'CANCELLED',
        },
      },
    });
    assert.equal(mapped.paymentStatus, 'paid');
    assert.equal(mapped.status, 'cancelled');
    assert.equal(mapped.refund, undefined);
    assert.equal(mapped.unresolvedReason, 'cancelled');
  });

  it('maps an unpaid cancel without paidAt as cancelled with no refund task', () => {
    const mapped = toPortalOrder({
      ...order,
      status: 'CANCELLED',
      paymentStatus: 'CANCELLED',
      paidAt: null,
      fulfilmentStatus: 'EXCEPTION',
      quoteSnapshot: {
        cancellation: { status: 'cancelled', reason: 'other' },
        curaleaf: { purchaseOrderState: 'CANCELLED', state: 'CANCELLED' },
      },
    });
    assert.equal(mapped.paymentStatus, 'cancelled');
    assert.equal(mapped.refund, undefined);
  });

  it('repairs legacy unpaid cancellations that were incorrectly stamped refund due', () => {
    const mapped = toPortalOrder({
      ...order,
      status: 'CANCELLED',
      paymentStatus: 'PENDING',
      paidAt: null,
      fulfilmentStatus: 'EXCEPTION',
      quoteSnapshot: {
        cancellation: { status: 'refund_required', reason: 'patient_request' },
        curaleafCancellation: { status: 'confirmed', purchaseOrderId: null, prescriptionId: null },
        refund: { id: 'invalid-unpaid-refund', status: 'pending_confirmation' },
      },
    });

    assert.equal(mapped.paymentStatus, 'cancelled');
    assert.equal(mapped.cancellation?.status, 'cancelled');
    assert.equal(mapped.curaleafCancellation, undefined);
    assert.equal(mapped.refund, undefined);
    assert.equal(mapped.unresolvedReason, undefined);
  });

  it('keeps a live Curaleaf purchase order visible after HHH marks the order cancelled and refunded', () => {
    const mapped = toPortalOrder({
      ...order,
      status: 'CANCELLED',
      paymentStatus: 'REFUNDED',
      paidAt: null,
      fulfilmentStatus: 'EXCEPTION',
      quoteSnapshot: {
        cancellation: { status: 'refund_required' },
        refund: { id: 'refund-1', status: 'completed' },
        curaleaf: {
          status: 'purchase_order_submitted',
          purchaseOrderId: '2bf991a2-3bbf-43ea-ae5b-45654ae5bc4b',
          purchaseOrderState: 'CREATED',
          state: 'CREATED',
          prescriptionState: 'ACTIVE',
          customerReference: 'HHH-e7e91a37-42c8-4af7-ada8-6e653317dc04-2ed86c9782',
        },
      },
    });
    assert.equal(mapped.paymentStatus, 'paid');
    assert.equal(mapped.refund, undefined);
    assert.equal(mapped.status, 'processing');
    assert.equal(mapped.cancellation, undefined);
    assert.equal(mapped.curaleaf?.purchaseOrderState, 'CREATED');
    assert.equal(mapped.curaleaf?.purchaseOrderId, '2bf991a2-3bbf-43ea-ae5b-45654ae5bc4b');
    assert.equal(mapped.curaleaf?.status, 'purchase_order_submitted');
  });

  it('maps a split Curaleaf shipment onto the portal contract without inventing a full dispatch', () => {
    const mapped = toPortalOrder({
      ...order,
      paymentStatus: 'PAID',
      paidAt: '2026-08-13T10:30:00.000Z',
      fulfilmentStatus: 'SUPPLIER_PROCESSING',
      quoteSnapshot: {
        lineItems: [{
          packId: '9f2d6958-2d76-4338-9e5f-6fd383dfff36',
          productId: '9f2d6958-2d76-4338-9e5f-6fd383dfff36',
          formulaId: 'f74f63de-dc89-4074-9d8c-be35f5398963',
          name: '4C Labs BWD T30 Beach Wedding, 30% THC <1% CBD',
          quantity: 4,
          unitPricePence: 8500,
        }],
        prescriptions: [{
          id: 'rx-beach',
          fileId: 'rx-beach',
          serialNumber: 'RX-BEACH',
          issueDate: '2026-08-13',
          prescriber: { name: 'Dr Test', pin: '123', gmcNumber: null, gphcNumber: null, initials: 'DT' },
          items: [],
        }],
      },
      curaleaf: {
        id: '99f4bc42-4312-45c5-b659-21583b5eb364',
        state: 'PROCESSING',
        courier: 'POLAR_SPEED',
        customerReference: 'HHH-5a8b4ac3-236c-41f7-a37b-0132b7892637-a9386eac93',
        issuedDate: '2026-08-13',
        createdAt: '2026-08-13T10:29:08.933558Z',
        items: [{
          productId: '9f2d6958-2d76-4338-9e5f-6fd383dfff36',
          packsOrderedCount: 4,
          packsAllocatedCount: 2,
          packsReturnedCount: 0,
        }],
        shipments: [{
          id: 'b13179c4-9515-4181-abd8-d1b87b50faa4',
          purchaseOrderId: '99f4bc42-4312-45c5-b659-21583b5eb364',
          createdAt: '2026-08-17T14:29:05.973745Z',
          items: [{ productId: '9f2d6958-2d76-4338-9e5f-6fd383dfff36', packCount: 2 }],
        }],
      },
    } as OrderRecord & { curaleaf: unknown });

    assert.equal(mapped.fulfilmentStatus, 'partially_dispatched_to_pharmacy');
    assert.equal(mapped.curaleaf?.dispatchStatus, 'partial');
    assert.equal(mapped.curaleaf?.customerReference, 'HHH-5a8b4ac3-236c-41f7-a37b-0132b7892637-a9386eac93');
    assert.deepEqual(mapped.curaleaf?.shipmentIds, ['b13179c4-9515-4181-abd8-d1b87b50faa4']);
    const line = mapped.prescriptionFlow?.['rx-beach']?.lines[0];
    assert.equal(line?.ordered, 4);
    assert.equal(line?.allocated, 2);
    assert.equal(line?.shipped, 2);
    assert.equal(line?.remaining, 2);
    assert.equal(line?.received, 0);
    assert.equal(mapped.lineItems[0]?.name, '4C Labs BWD T30 Beach Wedding, 30% THC <1% CBD');
    assert.equal(mapped.prescriptionFlow?.['rx-beach']?.latestShipmentAt, '2026-08-17T14:29:05.973745Z');
    assert.equal(mapped.prescriptionFlow?.['rx-beach']?.state, 'PLACED');
  });

  it('downgrades stale goods-in fulfilment when a partial consignment is still in transit', () => {
    const mapped = toPortalOrder({
      ...order,
      id: '5a8b4ac3-236c-41f7-a37b-0132b7892637',
      paymentStatus: 'PAID',
      paidAt: '2026-08-13T10:30:00.000Z',
      fulfilmentStatus: 'READY_FOR_COLLECTION',
      quoteSnapshot: {
        lineItems: [{
          packId: '9f2d6958-2d76-4338-9e5f-6fd383dfff36',
          productId: '9f2d6958-2d76-4338-9e5f-6fd383dfff36',
          formulaId: 'f74f63de-dc89-4074-9d8c-be35f5398963',
          name: '4C Labs BWD T30 Beach Wedding, 30% THC <1% CBD',
          quantity: 4,
          unitPricePence: 8500,
        }],
        prescriptions: [{
          id: 'rx-beach',
          fileId: 'rx-beach',
          serialNumber: 'RX-BEACH',
          issueDate: '2026-08-13',
          prescriber: { name: 'Dr Test', pin: '123', gmcNumber: null, gphcNumber: null, initials: 'DT' },
          items: [],
        }],
        curaleaf: {
          shipmentStates: { 'b13179c4-9515-4181-abd8-d1b87b50faa4': 'ready_for_collection' },
        },
      },
      curaleaf: {
        id: '99f4bc42-4312-45c5-b659-21583b5eb364',
        state: 'PROCESSING',
        courier: 'POLAR_SPEED',
        customerReference: 'HHH-5a8b4ac3-236c-41f7-a37b-0132b7892637-a9386eac93',
        issuedDate: '2026-08-13',
        createdAt: '2026-08-13T10:29:08.933558Z',
        items: [{
          productId: '9f2d6958-2d76-4338-9e5f-6fd383dfff36',
          packsOrderedCount: 4,
          packsAllocatedCount: 2,
          packsReturnedCount: 0,
        }],
        shipments: [{
          id: 'b13179c4-9515-4181-abd8-d1b87b50faa4',
          purchaseOrderId: '99f4bc42-4312-45c5-b659-21583b5eb364',
          createdAt: '2026-08-17T14:29:05.973745Z',
          items: [{ productId: '9f2d6958-2d76-4338-9e5f-6fd383dfff36', packCount: 2 }],
        }],
        shipmentStates: { 'b13179c4-9515-4181-abd8-d1b87b50faa4': 'ready_for_collection' },
      },
    } as OrderRecord & { curaleaf: unknown });

    assert.equal(mapped.fulfilmentStatus, 'partially_dispatched_to_pharmacy');
    assert.equal(mapped.prescriptionFlow?.['rx-beach']?.state, 'PLACED');
    const line = mapped.prescriptionFlow?.['rx-beach']?.lines[0];
    assert.equal(line?.received, 0);
    assert.equal(line?.shipped, 2);
  });

  it('maps a fully allocated Curaleaf consignment as complete dispatch without inventing goods-in', () => {
    const mapped = toPortalOrder({
      ...order,
      id: '93eea688-3a39-4b1d-b998-e43cc16acf4b',
      paymentStatus: 'PAID',
      paidAt: '2026-08-13T10:32:00.000Z',
      fulfilmentStatus: 'SUPPLIER_PROCESSING',
      quoteSnapshot: {
        lineItems: [{
          packId: '9f2d6958-2d76-4338-9e5f-6fd383dfff36',
          productId: '9f2d6958-2d76-4338-9e5f-6fd383dfff36',
          formulaId: 'f74f63de-dc89-4074-9d8c-be35f5398963',
          name: '4C Labs BWD T30 Beach Wedding, 30% THC <1% CBD',
          quantity: 2,
          unitPricePence: 8500,
        }],
        prescriptions: [{
          id: 'rx-full',
          fileId: 'rx-full',
          serialNumber: 'RX-FULL',
          issueDate: '2026-08-13',
          prescriber: { name: 'Dr Test', pin: '123', gmcNumber: null, gphcNumber: null, initials: 'DT' },
          items: [],
        }],
      },
      curaleaf: {
        id: '6e5e3d6e-5b14-4b8a-bb0e-d6d60ed6f69f',
        state: 'FULLY_ALLOCATED',
        courier: 'POLAR_SPEED',
        customerReference: 'HHH-93eea688-3a39-4b1d-b998-e43cc16acf4b-c10dbf6885',
        issuedDate: '2026-08-13',
        createdAt: '2026-08-13T10:31:34.825350Z',
        items: [{
          productId: '9f2d6958-2d76-4338-9e5f-6fd383dfff36',
          packsOrderedCount: 2,
          packsAllocatedCount: 2,
          packsReturnedCount: 0,
        }],
        shipments: [{
          id: 'f46d4159-f0dc-49fe-9189-4f0a59ea18e2',
          purchaseOrderId: '6e5e3d6e-5b14-4b8a-bb0e-d6d60ed6f69f',
          createdAt: '2026-08-17T14:30:05.319618Z',
          items: [{
            productId: '9f2d6958-2d76-4338-9e5f-6fd383dfff36',
            packCount: 2,
            batchNumber: 'A409003',
            batchExpiryDate: '2027-02-06',
          }],
        }],
      },
    } as OrderRecord & { curaleaf: unknown });

    assert.equal(mapped.fulfilmentStatus, 'dispatched_to_pharmacy');
    assert.equal(mapped.curaleaf?.dispatchStatus, 'complete');
    const line = mapped.prescriptionFlow?.['rx-full']?.lines[0];
    assert.equal(line?.ordered, 2);
    assert.equal(line?.allocated, 2);
    assert.equal(line?.shipped, 2);
    assert.equal(line?.remaining, 0);
    assert.equal(line?.received, 0);
    assert.equal(mapped.prescriptionFlow?.['rx-full']?.latestShipmentAt, '2026-08-17T14:30:05.319618Z');
    assert.equal(mapped.lineItems[0]?.name, '4C Labs BWD T30 Beach Wedding, 30% THC <1% CBD');
  });

  it('maps a 1-of-10 Curaleaf consignment as a split shipment and keeps pharmacy goods-in', () => {
    const mapped = toPortalOrder({
      ...order,
      id: 'a55ee7d4-6466-4e95-bf7f-88a95241e60f',
      paymentStatus: 'PAID',
      paidAt: '2026-08-13T09:24:00.000Z',
      fulfilmentStatus: 'PARTIALLY_RECEIVED',
      quoteSnapshot: {
        lineItems: [{
          packId: '9f2d6958-2d76-4338-9e5f-6fd383dfff36',
          productId: '9f2d6958-2d76-4338-9e5f-6fd383dfff36',
          formulaId: 'f74f63de-dc89-4074-9d8c-be35f5398963',
          name: '4C Labs BWD T30 Beach Wedding, 30% THC <1% CBD',
          quantity: 10,
          unitPricePence: 8500,
        }],
        prescriptions: [{
          id: 'rx-ten',
          fileId: 'rx-ten',
          serialNumber: 'RX-TEN',
          issueDate: '2026-08-13',
          prescriber: { name: 'Dr Test', pin: '123', gmcNumber: null, gphcNumber: null, initials: 'DT' },
          items: [],
        }],
        curaleaf: {
          lines: [{ productId: '9f2d6958-2d76-4338-9e5f-6fd383dfff36', received: 1, collected: 0 }],
        },
      },
      curaleaf: {
        id: '65ba3fdd-4507-4e39-a8ed-2d383b04e1d8',
        state: 'PROCESSING',
        courier: 'POLAR_SPEED',
        customerReference: 'HHH-a55ee7d4-6466-4e95-bf7f-88a95241e60f-383b50e0f9',
        issuedDate: '2026-08-13',
        createdAt: '2026-08-13T09:23:29.241487Z',
        items: [{
          productId: '9f2d6958-2d76-4338-9e5f-6fd383dfff36',
          packsOrderedCount: 10,
          packsAllocatedCount: 1,
          packsReturnedCount: 0,
        }],
        lines: [{ productId: '9f2d6958-2d76-4338-9e5f-6fd383dfff36', received: 1, collected: 0 }],
        shipments: [{
          id: '796adea9-f2d9-43b2-ad5c-ccfc4184ee62',
          purchaseOrderId: '65ba3fdd-4507-4e39-a8ed-2d383b04e1d8',
          createdAt: '2026-08-17T08:50:45.621344Z',
          items: [{
            productId: '9f2d6958-2d76-4338-9e5f-6fd383dfff36',
            packCount: 1,
            batchNumber: 'A409003',
            batchExpiryDate: '2027-02-06',
          }],
        }],
      },
    } as OrderRecord & { curaleaf: unknown });

    assert.equal(mapped.fulfilmentStatus, 'partially_received');
    assert.equal(mapped.curaleaf?.dispatchStatus, 'partial');
    const line = mapped.prescriptionFlow?.['rx-ten']?.lines[0];
    assert.equal(line?.ordered, 10);
    assert.equal(line?.allocated, 1);
    assert.equal(line?.shipped, 1);
    assert.equal(line?.remaining, 9);
    assert.equal(line?.received, 1);
    assert.equal(mapped.prescriptionFlow?.['rx-ten']?.latestShipmentAt, '2026-08-17T08:50:45.621344Z');
    assert.equal(mapped.lineItems[0]?.name, '4C Labs BWD T30 Beach Wedding, 30% THC <1% CBD');
  });

  it('keeps Beach Wedding 2-of-4 check-in after a Curaleaf re-sync', () => {
    const mapped = toPortalOrder({
      ...order,
      id: '5a8b4ac3-236c-41f7-a37b-0132b7892637',
      paymentStatus: 'PAID',
      paidAt: '2026-08-13T10:30:00.000Z',
      fulfilmentStatus: 'PARTIALLY_RECEIVED',
      quoteSnapshot: {
        lineItems: [{
          packId: '9f2d6958-2d76-4338-9e5f-6fd383dfff36',
          productId: '9f2d6958-2d76-4338-9e5f-6fd383dfff36',
          formulaId: 'f74f63de-dc89-4074-9d8c-be35f5398963',
          name: '4C Labs BWD T30 Beach Wedding, 30% THC <1% CBD',
          quantity: 4,
          unitPricePence: 8500,
        }],
        prescriptions: [{
          id: 'rx-beach',
          fileId: 'rx-beach',
          serialNumber: 'RX-BEACH',
          issueDate: '2026-08-13',
          prescriber: { name: 'Dr Test', pin: '123', gmcNumber: null, gphcNumber: null, initials: 'DT' },
          items: [],
        }],
        curaleaf: {
          lines: [{ productId: '9f2d6958-2d76-4338-9e5f-6fd383dfff36', received: 2, collected: 0 }],
          shipmentStates: { 'b13179c4-9515-4181-abd8-d1b87b50faa4': 'received' },
        },
      },
      curaleaf: {
        id: '99f4bc42-4312-45c5-b659-21583b5eb364',
        state: 'PROCESSING',
        courier: 'POLAR_SPEED',
        customerReference: 'HHH-5a8b4ac3-236c-41f7-a37b-0132b7892637-a9386eac93',
        issuedDate: '2026-08-13',
        createdAt: '2026-08-13T10:29:08.933558Z',
        items: [{
          productId: '9f2d6958-2d76-4338-9e5f-6fd383dfff36',
          packsOrderedCount: 4,
          packsAllocatedCount: 2,
          packsReturnedCount: 0,
        }],
        shipments: [{
          id: 'b13179c4-9515-4181-abd8-d1b87b50faa4',
          purchaseOrderId: '99f4bc42-4312-45c5-b659-21583b5eb364',
          createdAt: '2026-08-17T14:29:05.973745Z',
          items: [{ productId: '9f2d6958-2d76-4338-9e5f-6fd383dfff36', packCount: 2 }],
        }],
        lines: [{ productId: '9f2d6958-2d76-4338-9e5f-6fd383dfff36', received: 2, collected: 0 }],
        shipmentStates: { 'b13179c4-9515-4181-abd8-d1b87b50faa4': 'received' },
      },
    } as OrderRecord & { curaleaf: unknown });

    assert.equal(mapped.fulfilmentStatus, 'partially_received');
    const line = mapped.prescriptionFlow?.['rx-beach']?.lines[0];
    assert.equal(line?.received, 2);
    assert.equal(line?.remaining, 2);
    assert.equal(mapped.prescriptionFlow?.['rx-beach']?.state, 'PARTIALLY_RECEIVED');
    assert.equal(mapped.prescriptionFlow?.['rx-beach']?.shipmentStates?.['b13179c4-9515-4181-abd8-d1b87b50faa4'], 'received');
  });

  it('maps a pending tenant enquiry with assigned-pharmacy patient identity', () => {
    const mapped = toPortalPendingEnquiry({
      id: '12345678-1234-4123-8123-123456789012',
      submittedAt: '2026-08-17T09:15:00.000Z',
      followUpStatus: 'NOT_STARTED',
      sourceType: 'PHARMACY_QR',
      firstName: 'Avery',
      surname: 'Morgan',
      dob: '1991-04-12',
      email: 'avery@example.test',
      mobile: '07000000000',
      postcode: 'NG16 3AA',
      conditionCodes: ['chronic-pain'],
      primaryConditionCode: 'chronic-pain',
    });
    assert.equal(mapped.caseReference, 'HHH-20260817-12345678');
    assert.equal(mapped.displayStatus, 'New enquiry');
    assert.equal(mapped.sourceType, 'future_pharmacy_qr');
    assert.equal(mapped.firstName, 'Avery');
    assert.equal(mapped.primaryCondition, 'chronic-pain');
  });

  it('maps an in-progress HHH review enquiry', () => {
    const mapped = toPortalPendingEnquiry({
      id: '12345678-1234-4123-8123-123456789012',
      submittedAt: '2026-08-17T09:15:00.000Z',
      followUpStatus: 'IN_PROGRESS',
      sourceType: 'GENERAL_HHH_WEBSITE',
      firstName: 'Jordan',
      surname: 'Taylor',
      dob: '1988-02-02',
      email: 'jordan@example.test',
      mobile: '07111111111',
      postcode: 'SW1A 1AA',
      conditionCodes: ['anxiety'],
      primaryConditionCode: 'anxiety',
    });
    assert.equal(mapped.displayStatus, 'Under HHH review');
    assert.equal(mapped.sourceType, 'general_hhh_website');
  });

  it('builds a combined pharmacy patient directory payload', () => {
    const directory = buildPharmacyPatientDirectory({
      patients: [{
        ...({
          id: 'patient-1',
          organisationId: organisation.id,
          sourceSubmissionId: 'sub-1',
          firstName: 'Avery',
          surname: 'Taylor',
          dob: '1990-01-01',
          email: 'avery@example.com',
          mobile: '07000000000',
          address: null,
          postcode: 'SW1A 1AA',
          status: 'REFERRED',
          activatedAt: null,
          statusChangedAt: null,
          version: 1,
          createdAt: '2026-08-17T10:00:00.000Z',
          updatedAt: '2026-08-17T10:00:00.000Z',
        }),
        conditions: [{ conditionCode: 'chronic_pain', primary: true }],
        sourceSubmission: {
          sourceType: 'PHARMACY_QR',
          triedTwoTreatments: true,
          psychiatricExclusion: false,
          heardAbout: 'Friend',
          marketingConsent: false,
        },
      }],
      pendingEnquiries: [{
        id: '12345678-1234-4123-8123-123456789012',
        submittedAt: '2026-08-17T09:15:00.000Z',
        followUpStatus: 'NOT_STARTED',
        sourceType: 'PHARMACY_QR',
        firstName: 'Avery',
        surname: 'Morgan',
        dob: '1991-04-12',
        email: 'avery@example.test',
        mobile: '07000000000',
        postcode: 'NG16 3AA',
        conditionCodes: ['chronic-pain'],
        primaryConditionCode: 'chronic-pain',
      }],
    });
    assert.equal(directory.counts.patients, 1);
    assert.equal(directory.counts.pendingEnquiries, 1);
    assert.equal(directory.patients[0]?.conditions[0], 'chronic_pain');
    assert.equal(directory.enquiries[0]?.displayStatus, 'New enquiry');
    assert.equal(directory.enquiries[0]?.firstName, 'Avery');
  });

  it('builds a PII-masked tenant overview from SQL rows', () => {
    const overview = buildSqlPharmacyOverview({
      organisation,
      patients: [patient],
      orders: [order],
      pendingEnquiries: [{ submittedAt: '2026-08-16T09:30:00.000Z' }],
      now: Date.parse('2026-08-16T10:00:00.000Z'),
    });
    assert.equal(overview.summary.activePatients, 1);
    assert.equal(overview.summary.awaitingPayment, 1);
    assert.equal(overview.summary.supplierFulfilment, 1);
    assert.equal(overview.priorityItems.length, 1);
    assert.equal(overview.priorityItems[0]?.kind, 'payment');
    assert.equal(overview.priorityItems[0]?.maskedPatientLabel, 'Patient, A');
    assert.equal(overview.priorityItems[0]?.orderReference, '#ORD-1001');
    assert.equal(overview.priorityItems[0]?.maskedPatientLabel.includes('Alicia'), false);
    assert.equal(overview.priorityItems[0]?.recordTarget.id, order.id);
    assert.deepEqual(overview.enquiries, {
      pendingCount: 1,
      latestSubmittedAt: '2026-08-16T09:30:00.000Z',
      state: 'hhh_reviewing',
    });
    assert.equal(JSON.stringify(overview.enquiries).includes(patient.email), false);
    assert.equal('platformFeeMonthly' in overview.organisation, false);
    assert.deepEqual(overview.integrations, [
      { integration: 'curaleaf', state: 'not-configured', environment: null, checkedAt: null, detail: 'No credentials on file. HHH sets this up.' },
      { integration: 'worldpay', state: 'not-configured', environment: null, checkedAt: null, detail: 'No credentials on file. HHH sets this up.' },
    ]);
    // Prescription starts were removed from the Overview: the pharmacy reported
    // they never started an order from here, and the section only competed with
    // the queue that does get worked.
    assert.equal('prescriptionStarts' in overview, false);
  });

  it('never reports connected without a successful vendor call to point at', () => {
    const integrations = overviewIntegrationHealth([
      {
        integration: 'CURALEAF',
        environment: 'TEST',
        status: 'PENDING_VALIDATION',
        secretResourceName: 'projects/demo/secrets/curaleaf',
        lastSuccessfulAt: null,
        validatedAt: null,
      },
      {
        integration: 'WORLDPAY',
        environment: 'TEST',
        status: 'ACTIVE',
        secretResourceName: 'projects/demo/secrets/worldpay',
        lastSuccessfulAt: '2026-08-16T09:00:00.000Z',
        validatedAt: '2026-08-15T09:00:00.000Z',
      },
    ]);
    assert.deepEqual(integrations, [
      {
        integration: 'curaleaf',
        state: 'degraded',
        environment: 'test',
        checkedAt: null,
        detail: 'Credentials stored but never confirmed with the supplier.',
      },
      {
        integration: 'worldpay',
        state: 'connected',
        environment: 'test',
        checkedAt: '2026-08-16T09:00:00.000Z',
        detail: 'Last call to the supplier succeeded.',
      },
    ]);
  });

  it('does not treat a stored-credential timestamp as a successful check', () => {
    const [curaleaf] = overviewIntegrationHealth([
      {
        integration: 'CURALEAF',
        environment: 'PRODUCTION',
        status: 'ACTIVE',
        secretResourceName: 'projects/demo/secrets/curaleaf',
        lastSuccessfulAt: null,
        // Accepted for storage, never actually exercised against Curaleaf.
        validatedAt: '2026-08-15T09:00:00.000Z',
      },
    ]);
    assert.equal(curaleaf?.state, 'degraded');
    assert.equal(curaleaf?.checkedAt, null);
  });

  it('does not treat stored Worldpay credentials as connected without a vendor call', () => {
    const [, worldpay] = overviewIntegrationHealth([
      {
        integration: 'WORLDPAY',
        environment: 'TEST',
        status: 'ACTIVE',
        secretResourceName: 'projects/demo/secrets/worldpay',
        lastSuccessfulAt: null,
        validatedAt: '2026-08-15T09:00:00.000Z',
      },
    ]);
    assert.equal(worldpay?.state, 'degraded');
    assert.equal(worldpay?.checkedAt, null);
    assert.equal(worldpay?.detail, 'Credentials stored but never confirmed with the supplier.');
  });

  it('reports a pharmacy with no credentials as not configured', () => {
    const [curaleaf] = overviewIntegrationHealth([]);
    assert.equal(curaleaf?.state, 'not-configured');
    assert.equal(curaleaf?.checkedAt, null);
  });

  it('maps failed and paused connections without exposing credential material', () => {
    const integrations = overviewIntegrationHealth([
      {
        integration: 'CURALEAF',
        environment: 'PRODUCTION',
        status: 'ERROR',
        secretResourceName: 'projects/demo/secrets/curaleaf',
        lastSuccessfulAt: '2026-08-10T09:00:00.000Z',
        validatedAt: '2026-08-10T09:00:00.000Z',
      },
      {
        integration: 'WORLDPAY',
        environment: 'PRODUCTION',
        status: 'PAUSED',
        secretResourceName: 'projects/demo/secrets/worldpay',
        lastSuccessfulAt: null,
        validatedAt: null,
      },
    ]);
    assert.deepEqual(integrations, [
      {
        integration: 'curaleaf',
        state: 'degraded',
        environment: 'production',
        checkedAt: '2026-08-10T09:00:00.000Z',
        detail: 'The last attempt failed. HHH is notified.',
      },
      {
        integration: 'worldpay',
        state: 'unavailable',
        environment: 'production',
        checkedAt: null,
        detail: 'Paused by HHH.',
      },
    ]);
    assert.equal(JSON.stringify(integrations).includes('secrets/'), false);
  });

  it('prefers a SQL refund over a snapshot refund', () => {
    const mapped = toPortalOrder({
      ...order,
      status: 'CANCELLED',
      paymentStatus: 'REFUND_REQUIRED',
      paidAt: '2026-08-18T23:32:00.000Z',
      fulfilmentStatus: 'EXCEPTION',
      quoteSnapshot: {
        refund: { id: 'snapshot-refund', status: 'pending_confirmation', amountPence: 1 },
      },
      sqlRefund: {
        id: 'sql-refund',
        status: 'completed',
        amountPence: 10500,
        method: 'pharmacy_manual',
      },
    });
    assert.equal(mapped.refund?.id, 'sql-refund');
    assert.equal(mapped.refund?.status, 'completed');
    assert.equal(mapped.paymentStatus, 'refunded');
  });

  it('prefers SQL order lines over snapshot items', () => {
    const mapped = toPortalOrder({
      ...order,
      paymentStatus: 'PAID',
      paidAt: '2026-08-18T18:00:00.000Z',
      quoteSnapshot: {
        lineItems: [{ packId: 'snap-pack', productId: 'snap-pack', name: 'Snapshot pack', quantity: 9, unitPricePence: 1 }],
      },
      sqlLines: [{
        packId: 'sql-pack',
        productId: 'sql-pack',
        formulaId: 'formula-1',
        name: 'SQL pack',
        quantity: 2,
        unitPricePence: 8500,
      }],
    });
    assert.equal(mapped.lineItems.length, 1);
    assert.equal(mapped.lineItems[0].packId, 'sql-pack');
    assert.equal(mapped.lineItems[0].quantity, 2);
    assert.equal(mapped.lineItems[0].unitPricePence, 8500);
  });

  it('does not shrink submitted pack quantity when SQL lines are 1 but Curaleaf ordered 10', () => {
    const mapped = toPortalOrder({
      ...order,
      paymentStatus: 'PAID',
      paidAt: '2026-08-13T09:24:00.000Z',
      medicineTotalPence: 85000,
      totalPence: 85000,
      sqlLines: [{
        packId: '9f2d6958-2d76-4338-9e5f-6fd383dfff36',
        productId: '9f2d6958-2d76-4338-9e5f-6fd383dfff36',
        formulaId: 'f74f63de-dc89-4074-9d8c-be35f5398963',
        name: '4C Labs BWD T30 Beach Wedding, 30% THC <1% CBD',
        quantity: 1,
        unitPricePence: 8500,
      }],
      curaleaf: {
        id: '65ba3fdd-4507-4e39-a8ed-2d383b04e1d8',
        state: 'PROCESSING',
        items: [{
          productId: '9f2d6958-2d76-4338-9e5f-6fd383dfff36',
          packsOrderedCount: 10,
          packsAllocatedCount: 1,
          packsReturnedCount: 0,
        }],
      },
    } as OrderRecord & { curaleaf: unknown });
    assert.equal(mapped.lineItems[0]?.quantity, 10);
    const flow = Object.values(mapped.prescriptionFlow ?? {})[0] as { lines?: Array<{ ordered?: number; allocated?: number }> } | undefined;
    assert.equal(flow?.lines?.[0]?.ordered, 10);
    assert.equal(flow?.lines?.[0]?.allocated, 1);
  });

  it('keeps line items and purchase orders on the matching prescription', () => {
    const mapped = toPortalOrder({
      ...order,
      paymentStatus: 'PAID',
      paidAt: '2026-08-18T10:00:00.000Z',
      fulfilmentStatus: 'SUPPLIER_PENDING',
      quoteSnapshot: {
        lineItems: [
          { packId: 'pack-a', productId: 'pack-a', formulaId: 'f-a', name: 'Oil', quantity: 1, unitPricePence: 4800, localPrescriptionId: '1' },
          { packId: 'pack-b', productId: 'pack-b', formulaId: 'f-b', name: 'Flower', quantity: 1, unitPricePence: 8500, localPrescriptionId: '2' },
        ],
        prescriptions: [
          { id: '1', fileId: 'file-1', serialNumber: 'S1', issueDate: '2026-08-01', items: [{ packId: 'pack-a', productId: 'pack-a', quantity: 1 }] },
          { id: '2', fileId: 'file-2', serialNumber: 'S2', issueDate: '2026-08-01', items: [{ packId: 'pack-b', productId: 'pack-b', quantity: 1 }] },
        ],
        curaleafSubOrders: {
          1: { prescriptionId: 'curaleaf-1', purchaseOrderId: 'po-1', status: 'purchase_order_submitted' },
        },
      },
    });
    assert.equal(mapped.prescriptions?.[0]?.items?.length, 1);
    assert.equal(mapped.prescriptions?.[0]?.items?.[0]?.packId, 'pack-a');
    assert.equal(mapped.prescriptions?.[1]?.items?.length, 1);
    assert.equal(mapped.prescriptions?.[1]?.items?.[0]?.packId, 'pack-b');
    assert.equal(mapped.prescriptions?.[0]?.curaleafPrescriptionId, 'curaleaf-1');
    assert.equal(mapped.prescriptions?.[1]?.curaleafPrescriptionId, null);
    assert.equal(mapped.prescriptionFlow?.['1']?.purchaseOrderId, 'po-1');
    assert.equal(mapped.prescriptionFlow?.['2']?.purchaseOrderId, null);
    assert.equal(mapped.prescriptionFlow?.['1']?.state, 'PLACED');
    assert.equal(mapped.prescriptionFlow?.['2']?.state, 'PENDING_PLACEMENT');
  });

  it('keeps a clinic script and a manual script as separate sub-orders', () => {
    const mapped = toPortalOrder({
      ...order,
      paymentStatus: 'PAID',
      paidAt: '2026-08-18T10:00:00.000Z',
      fulfilmentStatus: 'SUPPLIER_PENDING',
      quoteSnapshot: {
        lineItems: [
          { packId: 'pack-a', productId: 'pack-a', formulaId: 'f-a', name: 'Oil', quantity: 1, unitPricePence: 4800, localPrescriptionId: '1' },
          { packId: 'pack-b', productId: 'pack-b', formulaId: 'f-b', name: 'Flower', quantity: 1, unitPricePence: 8500, localPrescriptionId: '2' },
        ],
        prescriptions: [
          { id: '1', clinicScanId: 'scan-1', curaleafPrescriptionId: 'clinic-rx', issueDate: '2026-08-01', items: [{ packId: 'pack-a', productId: 'pack-a', quantity: 1 }] },
          { id: '2', fileId: 'file-2', serialNumber: 'S2', issueDate: '2026-08-01', items: [{ packId: 'pack-b', productId: 'pack-b', quantity: 1 }] },
        ],
        curaleafSubOrders: {
          1: { prescriptionId: 'clinic-rx', purchaseOrderId: 'po-clinic', status: 'purchase_order_submitted' },
          2: { prescriptionId: 'manual-rx', purchaseOrderId: 'po-manual', status: 'purchase_order_submitted' },
        },
      },
    });
    assert.equal(mapped.prescriptions?.[0]?.curaleafPrescriptionId, 'clinic-rx');
    assert.equal(mapped.prescriptions?.[1]?.curaleafPrescriptionId, 'manual-rx');
    assert.equal(mapped.prescriptions?.[0]?.items?.[0]?.packId, 'pack-a');
    assert.equal(mapped.prescriptions?.[1]?.items?.[0]?.packId, 'pack-b');
    assert.equal(mapped.prescriptionFlow?.['1']?.purchaseOrderId, 'po-clinic');
    assert.equal(mapped.prescriptionFlow?.['2']?.purchaseOrderId, 'po-manual');
  });

  it('keeps fulfilment lines on the matching prescription and leaves an unplaced sibling empty', () => {
    const mapped = toPortalOrder({
      ...order,
      paymentStatus: 'PAID',
      paidAt: '2026-08-18T10:00:00.000Z',
      fulfilmentStatus: 'SUPPLIER_PROCESSING',
      quoteSnapshot: {
        lineItems: [
          { packId: 'pack-a', productId: 'pack-a', formulaId: 'f-a', name: 'Oil', quantity: 2, unitPricePence: 4800, localPrescriptionId: '1' },
          { packId: 'pack-b', productId: 'pack-b', formulaId: 'f-b', name: 'Flower', quantity: 1, unitPricePence: 8500, localPrescriptionId: '2' },
        ],
        prescriptions: [
          { id: '1', fileId: 'file-1', serialNumber: 'S1', issueDate: '2026-08-01', items: [{ packId: 'pack-a', productId: 'pack-a', quantity: 2 }] },
          { id: '2', fileId: 'file-2', serialNumber: 'S2', issueDate: '2026-08-01', items: [{ packId: 'pack-b', productId: 'pack-b', quantity: 1 }] },
        ],
        curaleafSubOrders: {
          1: { prescriptionId: 'curaleaf-1', purchaseOrderId: 'po-1', status: 'purchase_order_submitted' },
        },
      },
      curaleaf: {
        id: 'po-1',
        state: 'PROCESSING',
        items: [
          { productId: 'pack-a', packsOrderedCount: 2, packsAllocatedCount: 2, packsReturnedCount: 0 },
          { productId: 'pack-b', packsOrderedCount: 1, packsAllocatedCount: 1, packsReturnedCount: 0 },
        ],
        shipments: [{
          id: 'ship-a',
          purchaseOrderId: 'po-1',
          createdAt: '2026-08-18T12:00:00.000Z',
          items: [
            { productId: 'pack-a', packCount: 2 },
            { productId: 'pack-b', packCount: 1 },
          ],
        }],
      },
    } as OrderRecord & { curaleaf: unknown });
    const placed = mapped.prescriptionFlow?.['1'];
    const pending = mapped.prescriptionFlow?.['2'];
    assert.equal(placed?.purchaseOrderId, 'po-1');
    assert.equal(placed?.state, 'PLACED');
    assert.equal(placed?.lines.length, 1);
    assert.equal(placed?.lines[0]?.productId, 'pack-a');
    assert.deepEqual(placed?.shipmentIds, ['ship-a']);
    assert.equal(pending?.purchaseOrderId, null);
    assert.equal(pending?.state, 'PENDING_PLACEMENT');
    assert.equal(pending?.lines.length, 0);
    assert.deepEqual(pending?.shipmentIds, []);
  });

  it('attributes a legacy single purchase order by pack overlap instead of dumping it on the first prescription', () => {
    const mapped = toPortalOrder({
      ...order,
      paymentStatus: 'PAID',
      paidAt: '2026-08-18T10:00:00.000Z',
      fulfilmentStatus: 'SUPPLIER_PROCESSING',
      quoteSnapshot: {
        lineItems: [
          { packId: 'pack-a', productId: 'pack-a', formulaId: 'f-a', name: 'Oil', quantity: 1, unitPricePence: 4800, localPrescriptionId: '1' },
          { packId: 'pack-b', productId: 'pack-b', formulaId: 'f-b', name: 'Flower', quantity: 1, unitPricePence: 8500, localPrescriptionId: '2' },
        ],
        prescriptions: [
          { id: '1', fileId: 'file-1', serialNumber: 'S1', issueDate: '2026-08-01', items: [{ packId: 'pack-a', productId: 'pack-a', quantity: 1 }] },
          { id: '2', fileId: 'file-2', serialNumber: 'S2', issueDate: '2026-08-01', items: [{ packId: 'pack-b', productId: 'pack-b', quantity: 1 }] },
        ],
      },
      curaleaf: {
        id: 'po-legacy',
        state: 'PROCESSING',
        items: [{ productId: 'pack-a', packsOrderedCount: 1, packsAllocatedCount: 1, packsReturnedCount: 0 }],
      },
    } as OrderRecord & { curaleaf: unknown });
    assert.equal(mapped.prescriptionFlow?.['1']?.purchaseOrderId, 'po-legacy');
    assert.equal(mapped.prescriptionFlow?.['1']?.lines.length, 1);
    assert.equal(mapped.prescriptionFlow?.['1']?.lines[0]?.productId, 'pack-a');
    assert.equal(mapped.prescriptionFlow?.['2']?.purchaseOrderId, null);
    assert.equal(mapped.prescriptionFlow?.['2']?.state, 'PENDING_PLACEMENT');
    assert.equal(mapped.prescriptionFlow?.['2']?.lines.length, 0);
  });
});
