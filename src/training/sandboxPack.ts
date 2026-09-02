import type {
  CRMPatient,
  LineItem,
  PatientOrder,
  PharmacyTenant,
  Prescription,
  PrescriptionFulfilmentLine,
} from '../context/AppContext';
import type {
  CuraleafQuote,
  PharmacyOverview,
  PortalPatientRecord,
  PortalPendingEnquiryRecord,
} from '../shared/contracts';
import { mapPortalEnquiryRecord, mapPortalPatientRecord } from '../utils/pharmacyPatientDirectory.ts';

export const TRAINING_REFERRAL_SOURCE = 'training_sandbox';

/** Catalogue-shaped example pack. Prefer a live Curaleaf fetch on Catalogue; this is fill only. */
export const TRAINING_PRODUCT = {
  id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1',
  formulaId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa2',
  name: 'Curaleaf flower 10g',
  packSize: 10,
  retail: 85,
  cost: 42,
  supplierState: 'ACTIVE',
} as const;

export const TRAINING_PRESCRIBER = {
  id: 'sandbox-prescriber',
  name: 'Clinic prescriber',
  gmcNumber: '',
} as const;

const PATIENT_PENCE = Math.round(TRAINING_PRODUCT.retail * 100);
const WHOLESALE_PENCE = Math.round(TRAINING_PRODUCT.cost * 100);

type PatientSlug =
  | 'casey'
  | 'jamie'
  | 'riley'
  | 'avery'
  | 'taylor'
  | 'rowan'
  | 'harper'
  | 'morgan'
  | 'drew'
  | 'sage'
  | 'quinn'
  | 'blair'
  | 'ellis';

const PATIENT_DIRECTORY: Record<PatientSlug, {
  firstName: string;
  surname: string;
  mobile: string;
  dob: string;
  postcode: string;
  condition: string;
  status: PortalPatientRecord['status'];
}> = {
  casey: { firstName: 'Casey', surname: 'Reed', mobile: '00000 000 001', dob: '1991-04-12', postcode: 'XX0 0AA', condition: 'Chronic pain', status: 'referred' },
  jamie: { firstName: 'Jamie', surname: 'Cole', mobile: '00000 000 002', dob: '1986-09-03', postcode: 'XX0 0BB', condition: 'Anxiety', status: 'referred' },
  riley: { firstName: 'Riley', surname: 'Shah', mobile: '00000 000 004', dob: '1994-11-18', postcode: 'XX0 0DD', condition: 'Insomnia', status: 'referred' },
  avery: { firstName: 'Avery', surname: 'Quinn', mobile: '00000 000 005', dob: '1983-06-09', postcode: 'XX0 0EE', condition: 'Chronic pain', status: 'referred' },
  taylor: { firstName: 'Taylor', surname: 'West', mobile: '00000 000 006', dob: '1975-02-28', postcode: 'XX0 0FF', condition: 'MS', status: 'referred' },
  rowan: { firstName: 'Rowan', surname: 'Hale', mobile: '00000 000 007', dob: '1988-07-14', postcode: 'XX0 0GG', condition: 'Chronic pain', status: 'referred' },
  harper: { firstName: 'Harper', surname: 'Lane', mobile: '00000 000 012', dob: '1993-10-08', postcode: 'XX0 0MM', condition: 'Anxiety', status: 'referred' },
  morgan: { firstName: 'Morgan', surname: 'Blake', mobile: '00000 000 003', dob: '1978-01-22', postcode: 'XX0 0CC', condition: 'Chronic pain', status: 'active' },
  drew: { firstName: 'Drew', surname: 'Patel', mobile: '00000 000 008', dob: '1972-03-05', postcode: 'XX0 0HH', condition: 'Anxiety', status: 'referred' },
  sage: { firstName: 'Sage', surname: 'Nguyen', mobile: '00000 000 009', dob: '1990-12-01', postcode: 'XX0 0JJ', condition: 'Insomnia', status: 'referred' },
  quinn: { firstName: 'Quinn', surname: 'Fraser', mobile: '00000 000 010', dob: '1981-08-19', postcode: 'XX0 0KK', condition: 'Chronic pain', status: 'referred' },
  blair: { firstName: 'Blair', surname: 'Ortiz', mobile: '00000 000 011', dob: '1977-05-27', postcode: 'XX0 0LL', condition: 'MS', status: 'referred' },
  ellis: { firstName: 'Ellis', surname: 'Brook', mobile: '00000 000 013', dob: '1984-01-30', postcode: 'XX0 0NN', condition: 'Chronic pain', status: 'referred' },
};

export function sandboxPatientId(organisationId: string, slug: PatientSlug) {
  return `training-${organisationId}-${slug}`;
}

function daysAgo(days: number, now: Date) {
  return new Date(now.getTime() - days * 24 * 60 * 60 * 1000);
}

function packItem(qty = 1): LineItem {
  return {
    productId: TRAINING_PRODUCT.id,
    formulaId: TRAINING_PRODUCT.formulaId,
    name: TRAINING_PRODUCT.name,
    qty,
    unitsNeededCount: TRAINING_PRODUCT.packSize * qty,
    cost: TRAINING_PRODUCT.cost * qty,
    retail: TRAINING_PRODUCT.retail * qty,
  };
}

function fulfilment(partial: Pick<PrescriptionFulfilmentLine, 'ordered' | 'allocated' | 'shipped' | 'received' | 'collected'> & Partial<PrescriptionFulfilmentLine>): PrescriptionFulfilmentLine {
  const remaining = Math.max(0, partial.ordered - Math.max(partial.shipped, partial.allocated));
  return {
    productId: TRAINING_PRODUCT.id,
    requested: partial.ordered,
    sent: partial.shipped,
    supplierReportedOrdered: partial.ordered,
    remaining: partial.remaining ?? remaining,
    returned: 0,
    backordered: false,
    quantityMismatch: false,
    cancelledRemainder: 0,
    remainingExpected: remaining,
    ...partial,
  };
}

function sandboxEnquiry(organisationId: string, now: Date): PortalPendingEnquiryRecord {
  return {
    id: `training-enquiry-${organisationId}-alex`,
    submittedAt: daysAgo(1, now).toISOString(),
    caseReference: 'SBX-ENQ-01',
    displayStatus: 'New enquiry',
    sourceType: 'future_pharmacy_qr',
    firstName: 'Alex',
    surname: 'Hart',
    dob: '1989-08-23',
    email: 'alex.hart@invalid.example',
    mobile: '00000 000 020',
    postcode: 'XX0 0UU',
    conditions: ['Chronic pain'],
    primaryCondition: 'Chronic pain',
    triedTwoTreatments: true,
    psychiatricExclusion: false,
    heardAbout: 'Pharmacy QR link',
  };
}

function sandboxPatients(organisationId: string, now: Date): PortalPatientRecord[] {
  const createdAt = daysAgo(21, now).toISOString();
  return (Object.entries(PATIENT_DIRECTORY) as Array<[PatientSlug, typeof PATIENT_DIRECTORY[PatientSlug]]>).map(([slug, person]) => ({
    id: sandboxPatientId(organisationId, slug),
    organisationId,
    firstName: person.firstName,
    surname: person.surname,
    dob: person.dob,
    email: `${slug.replaceAll('-', '.')}@invalid.example`,
    mobile: person.mobile,
    address: '',
    postcode: person.postcode,
    status: person.status,
    conditions: [person.condition],
    primaryCondition: person.condition,
    referralSource: TRAINING_REFERRAL_SOURCE,
    createdAt,
    updatedAt: createdAt,
  }));
}

function quote(patientPackPrice: string, wholesalePackPrice: string, inStock = true): CuraleafQuote {
  return {
    shippingPrice: '0.00',
    taxRate: '0',
    items: [{
      packId: TRAINING_PRODUCT.id,
      quantity: 1,
      inStock,
      stockStatus: inStock ? 'in_stock' : 'out_of_stock',
      wholesalePackPrice,
      patientPackPrice,
    }],
  };
}

function rx(
  id: number,
  status: Prescription['status'],
  extras: Partial<Prescription> = {},
): Prescription {
  return {
    id,
    entryMode: 'clinic',
    prescriber: TRAINING_PRESCRIBER.name,
    prescriberId: TRAINING_PRESCRIBER.id,
    copyFileName: null,
    items: [packItem()],
    placed: false,
    purchaseOrderId: null,
    status,
    invoiceRef: null,
    trackingNumber: null,
    carrier: null,
    ...extras,
  };
}

function placedRx(
  id: number,
  status: Prescription['status'],
  progress: { ordered?: number; allocated?: number; shipped?: number; received?: number; collected?: number },
  extras: Partial<Prescription> = {},
  now: Date,
): Prescription {
  const ordered = progress.ordered ?? 1;
  return rx(id, status, {
    items: [packItem(ordered)],
    placed: true,
    placedAt: daysAgo(4, now),
    purchaseOrderId: `PO-SBX-${id}`,
    purchaseOrderState: (progress.allocated ?? ordered) >= ordered ? 'FULLY_ALLOCATED' : 'PROCESSING',
    dispatchStatus: (progress.shipped ?? 0) === 0 ? 'not_dispatched' : (progress.shipped ?? 0) < ordered ? 'partial' : 'complete',
    receivedItems: (progress.received ?? 0) > 0 ? [{ productId: TRAINING_PRODUCT.id, quantityReceived: progress.received ?? 0 }] : undefined,
    goodsInAt: (progress.received ?? 0) > 0 ? daysAgo(1, now) : undefined,
    readyAt: status === 'ready' || status === 'collected' ? daysAgo(1, now) : undefined,
    fulfilmentLines: [fulfilment({
      ordered,
      allocated: progress.allocated ?? ordered,
      shipped: progress.shipped ?? 0,
      received: progress.received ?? 0,
      collected: progress.collected ?? 0,
    })],
    ...extras,
  });
}

function payment(
  id: number,
  now: Date,
  kind: 'awaiting' | 'paid',
  days: number,
  note: string,
  amount: number = TRAINING_PRODUCT.retail,
): PatientOrder['payment'] {
  const sent = daysAgo(days, now);
  return {
    status: kind === 'paid' ? 'paid' : 'sent',
    route: 'pharmacy',
    amount,
    ref: `TILL-SBX-${id}`,
    sentAt: sent,
    paidAt: kind === 'paid' ? sent : null,
    manualTender: 'epos-card',
    manualReference: `TILL-SBX-${id}`,
    manualNotes: note,
    manualRecordedBy: null,
  };
}

function order(
  organisationId: string,
  patients: Record<PatientSlug, CRMPatient>,
  now: Date,
  id: number,
  slug: PatientSlug,
  days: number,
  pay: PatientOrder['payment'],
  prescriptions: Prescription[],
  extras: Partial<PatientOrder> = {},
): PatientOrder {
  return {
    id,
    backendId: `sandbox-order-${id}`,
    orderNumber: `SBX-${id}`,
    organisationId,
    patientId: patients[slug].id,
    date: daysAgo(days, now),
    dispensingFee: 0,
    pharmacyDelivery: 0,
    pharmacyDeliveryAllowed: false,
    paymentRoute: 'manual',
    payment: pay,
    prescriptions,
    ...extras,
  };
}

function sandboxOrders(organisationId: string, patients: Record<PatientSlug, CRMPatient>, now: Date): PatientOrder[] {
  const splitAmount = TRAINING_PRODUCT.retail * 2;
  return [
    order(organisationId, patients, now, 101, 'jamie', 1, payment(101, now, 'awaiting', 1, 'Payment requested. Not yet received.'), [
      rx(1011, 'draft'),
    ]),
    order(organisationId, patients, now, 102, 'riley', 2, payment(102, now, 'paid', 2, 'Paid. Waiting for Curaleaf prescription check.'), [
      rx(1021, 'awaiting-approval', { curaleafPrescriptionState: 'PENDING' }),
    ]),
    order(organisationId, patients, now, 103, 'avery', 5, payment(103, now, 'paid', 5, 'Purchase order dispatched. Packs not yet received.'), [
      placedRx(1031, 'dispatched', { shipped: 1, received: 0 }, {}, now),
    ]),
    order(organisationId, patients, now, 104, 'taylor', 6, payment(104, now, 'paid', 6, 'Goods-in recorded. Waiting for the patient.'), [
      placedRx(1041, 'received', { shipped: 1, received: 1 }, {}, now),
    ]),
    order(organisationId, patients, now, 105, 'rowan', 8, payment(105, now, 'paid', 8, 'Ready for collection.'), [
      placedRx(1051, 'ready', { shipped: 1, received: 1 }, {}, now),
    ]),
    order(organisationId, patients, now, 106, 'harper', 3, payment(106, now, 'paid', 3, 'Purchase order allocated. Curaleaf is preparing the packs.'), [
      placedRx(1061, 'processing', { allocated: 1, shipped: 0 }, {}, now),
    ]),
    order(organisationId, patients, now, 107, 'morgan', 14, payment(107, now, 'paid', 14, 'Collected. First collection for this patient.'), [
      placedRx(1071, 'collected', { shipped: 1, received: 1, collected: 1 }, {}, now),
    ]),
    order(organisationId, patients, now, 108, 'drew', 1, payment(108, now, 'paid', 1, 'Paid basket held for a patient-price change.'), [
      rx(1081, 'awaiting-approval'),
    ], {
      quoteReview: {
        status: 'required',
        type: 'patient_price_changed',
        fingerprint: 'sandbox-patient-price-changed',
        latestQuote: quote('95.00', '42.00'),
        differences: [{
          category: 'patient_price',
          field: 'patientPackPrice',
          packId: TRAINING_PRODUCT.id,
          previous: '8500',
          latest: '9500',
        }],
        checkedAt: daysAgo(1, now).toISOString(),
        patientDeltaPence: 1000,
      },
    }),
    order(organisationId, patients, now, 109, 'sage', 3, payment(109, now, 'paid', 3, 'Curaleaf cancelled the purchase order. Refund or replace still needed.'), [
      placedRx(1091, 'cancelled', { allocated: 1, shipped: 0 }, {
        purchaseOrderState: 'CANCELLED',
        curaleafPrescriptionState: 'CANCELLED',
      }, now),
    ], {
      cancellation: {
        status: 'refund_required',
        reason: 'other',
        note: 'Supplier cancelled the purchase order.',
        requestedAt: daysAgo(1, now).toISOString(),
        requestedBy: null,
        paymentLinkStatus: 'not_applicable',
      },
    }),
    order(organisationId, patients, now, 110, 'quinn', 2, payment(110, now, 'paid', 2, 'Refund due. Confirm the ePOS reference when it is done.'), [
      placedRx(1101, 'cancelled', { allocated: 1, shipped: 0 }, {
        purchaseOrderState: 'CANCELLED',
        curaleafPrescriptionState: 'CANCELLED',
      }, now),
    ], {
      cancellation: {
        status: 'refund_required',
        reason: 'patient_request',
        note: 'Patient refund is still outstanding.',
        requestedAt: daysAgo(1, now).toISOString(),
        requestedBy: null,
        paymentLinkStatus: 'not_applicable',
      },
      refund: {
        id: 'sandbox-refund-110',
        status: 'pending_confirmation',
        amountPence: PATIENT_PENCE,
        method: 'pharmacy_manual',
        paymentReference: 'TILL-SBX-110',
        reason: 'patient_cancelled',
        resolution: 'cancel',
        requestedAt: daysAgo(1, now).toISOString(),
      },
    }),
    order(organisationId, patients, now, 111, 'blair', 4, payment(111, now, 'paid', 4, 'Split delivery. One pack is in transit; the other is still with Curaleaf.', splitAmount), [
      placedRx(1111, 'dispatched', { ordered: 2, allocated: 2, shipped: 1, received: 0 }, { dispatchStatus: 'partial' }, now),
    ]),
    order(organisationId, patients, now, 112, 'ellis', 1, payment(112, now, 'paid', 1, 'Paid. Prescription is ready to send to Curaleaf.'), [
      rx(1121, 'draft'),
    ]),
  ];
}

export function sandboxPortalPack(organisationId: string, now = new Date()) {
  const enquiry = sandboxEnquiry(organisationId, now);
  const patients = sandboxPatients(organisationId, now);
  return {
    enquiry,
    patients,
    overview: sandboxOverviewSnapshot(organisationId, now),
  };
}

export function sandboxOverviewSnapshot(organisationId: string, now = new Date(), tradingName = 'Primary Branch'): PharmacyOverview {
  const asOf = now.toISOString();
  const since = daysAgo(30, now).toISOString();
  return {
    asOf,
    organisation: {
      id: organisationId,
      tradingName,
      status: 'onboarding',
      trainingMode: true,
      allocationHoldingMode: false,
    },
    enquiries: {
      pendingCount: 1,
      latestSubmittedAt: daysAgo(1, now).toISOString(),
      state: 'hhh_reviewing',
    },
    summary: {
      activePatients: 1,
      awaitingPayment: 1,
      supplierFulfilment: 4,
      readyForCollection: 2,
      urgentTotal: 3,
    },
    finance: {
      period: '30d',
      periodDays: 30,
      since,
      realisedPatientRevenuePence: PATIENT_PENCE,
      realisedCount: 1,
      pendingCollectionCount: 2,
      pendingPatientRevenuePence: PATIENT_PENCE * 2,
      contributionPence: PATIENT_PENCE - WHOLESALE_PENCE,
      contributionComplete: true,
      awaitingPaymentCount: 1,
      awaitingPaymentValuePence: PATIENT_PENCE,
    },
    priorityItems: [
      {
        id: 'sandbox-priority-101',
        kind: 'payment',
        ageDays: 1,
        maskedPatientLabel: 'C——',
        orderReference: '#SBX-101',
        recordTarget: { kind: 'order', id: 'sandbox-order-101' },
        summary: 'Payment requested and not yet received.',
        actionLabel: 'Open order',
      },
      {
        id: 'sandbox-priority-105',
        kind: 'collection',
        ageDays: 2,
        maskedPatientLabel: 'H——',
        orderReference: '#SBX-105',
        recordTarget: { kind: 'order', id: 'sandbox-order-105' },
        summary: 'Checked in and waiting for collection.',
        actionLabel: 'Open order',
      },
      {
        id: 'sandbox-priority-109',
        kind: 'cancellation',
        ageDays: 1,
        maskedPatientLabel: 'N——',
        orderReference: '#SBX-109',
        recordTarget: { kind: 'order', id: 'sandbox-order-109' },
        summary: 'Supplier cancelled the purchase order.',
        actionLabel: 'Open order',
      },
    ],
    recentSessions: [],
    handover: {
      activePatients: 1,
      activePaymentLinks: 1,
      supplierOrdersInProgress: 4,
      agedCollections: 1,
    },
    integrations: [
      {
        integration: 'curaleaf',
        state: 'connected',
        environment: 'test',
        checkedAt: asOf,
        detail: 'Last catalogue fetch succeeded.',
      },
      {
        integration: 'worldpay',
        state: 'not-configured',
        environment: null,
        checkedAt: null,
        detail: 'Set up by HHH',
      },
    ],
  };
}

export function hydrateSandboxWorkspace(organisationId: string, now = new Date()): {
  crm: CRMPatient[];
  enquiries: ReturnType<typeof mapPortalEnquiryRecord>[];
  orders: PatientOrder[];
  overview: PharmacyOverview;
  nextIds: { patient: number; rx: number; order: number; submission: number; invoice: number };
} {
  const pack = sandboxPortalPack(organisationId, now);
  const crm = pack.patients.map(mapPortalPatientRecord);
  const bySlug = Object.fromEntries(
    (Object.keys(PATIENT_DIRECTORY) as PatientSlug[]).map(slug => [slug, crm.find(patient => patient.id === sandboxPatientId(organisationId, slug))]),
  ) as Record<PatientSlug, CRMPatient>;
  return {
    crm,
    enquiries: [mapPortalEnquiryRecord(organisationId, pack.enquiry)],
    orders: sandboxOrders(organisationId, bySlug, now),
    overview: pack.overview,
    nextIds: { patient: 2000, rx: 12000, order: 200, submission: 5, invoice: 4072 },
  };
}

export function sandboxOverviewForOrganisation(organisation: Pick<PharmacyTenant, 'id' | 'tradingName' | 'status'>, now = new Date()): PharmacyOverview {
  const snapshot = sandboxOverviewSnapshot(organisation.id, now, organisation.tradingName);
  return {
    ...snapshot,
    organisation: {
      ...snapshot.organisation,
      tradingName: organisation.tradingName,
      status: organisation.status === 'paused' || organisation.status === 'live' || organisation.status === 'intake_live' || organisation.status === 'onboarding'
        ? organisation.status
        : 'onboarding',
      trainingMode: true,
    },
  };
}
