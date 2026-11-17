import type { CRMPatient } from '../context/AppContext';

/**
 * Local preview only: demo patients and referral fees at Meadowbank, the live
 * demo pharmacy, so HHH admin's Finance page and patient Fees cards have a
 * ledger to show. Test pharmacies never earn fees, so this cannot sit on them.
 * Dates are relative to today so the ledger always spans the last three years.
 */

export const LEDGER_DEMO_ORGANISATION_ID = 'preview-live-pharmacy';
const PHARMACY_NAME = 'Meadowbank Pharmacy';

type DemoPatient = {
  slug: string;
  name: string;
  dob: string;
  postcode: string;
  /** Days ago HHH referred them. */
  referredDaysAgo: number;
  /** Days after referral they collected their first dispense; null if not yet. */
  firstDispenseAfter: number | null;
  /** Still active, so each anniversary of the first dispense earns £40. */
  active: boolean;
  condition: string;
};

const PATIENTS: DemoPatient[] = [
  { slug: 'eleanor-hughes', name: 'Eleanor Hughes', dob: '1978-03-14', postcode: 'M14 5LS', referredDaysAgo: 1050, firstDispenseAfter: 12, active: true, condition: 'chronic_pain' },
  { slug: 'marcus-bell', name: 'Marcus Bell', dob: '1985-07-02', postcode: 'M20 2RN', referredDaysAgo: 880, firstDispenseAfter: 9, active: true, condition: 'anxiety' },
  { slug: 'priya-nair', name: 'Priya Nair', dob: '1990-11-23', postcode: 'M13 9PL', referredDaysAgo: 720, firstDispenseAfter: 15, active: true, condition: 'sleep_disorders' },
  { slug: 'owen-gallagher', name: 'Owen Gallagher', dob: '1969-01-30', postcode: 'M21 0TX', referredDaysAgo: 610, firstDispenseAfter: 21, active: false, condition: 'chronic_pain' },
  { slug: 'sofia-marin', name: 'Sofia Marin', dob: '1994-05-17', postcode: 'M19 3AB', referredDaysAgo: 420, firstDispenseAfter: 8, active: true, condition: 'migraine' },
  { slug: 'daniel-reeves', name: 'Daniel Reeves', dob: '1982-09-09', postcode: 'M15 4FN', referredDaysAgo: 300, firstDispenseAfter: 11, active: true, condition: 'chronic_pain' },
  { slug: 'hannah-ford', name: 'Hannah Ford', dob: '1988-12-04', postcode: 'M16 8HH', referredDaysAgo: 160, firstDispenseAfter: 14, active: true, condition: 'anxiety' },
  { slug: 'kwame-boateng', name: 'Kwame Boateng', dob: '1975-04-26', postcode: 'M14 6WS', referredDaysAgo: 75, firstDispenseAfter: 10, active: true, condition: 'fibromyalgia' },
  { slug: 'lucy-tran', name: 'Lucy Tran', dob: '1999-08-11', postcode: 'M12 4JH', referredDaysAgo: 34, firstDispenseAfter: 6, active: true, condition: 'sleep_disorders' },
  { slug: 'george-patel', name: 'George Patel', dob: '1981-02-19', postcode: 'M20 6QE', referredDaysAgo: 9, firstDispenseAfter: null, active: false, condition: 'chronic_pain' },
];

const DAY = 24 * 60 * 60 * 1000;
const email = (patient: DemoPatient) => `${patient.slug.replace('-', '.')}@meadowbank-demo.example`;

function addYears(date: Date, years: number) {
  const next = new Date(date);
  next.setUTCFullYear(next.getUTCFullYear() + years);
  return next;
}

export function ledgerDemoPatients(now = new Date()): CRMPatient[] {
  return PATIENTS.map((patient, index) => {
    const referredAt = new Date(now.getTime() - patient.referredDaysAgo * DAY);
    return {
      id: `ledger-demo-${patient.slug}`,
      organisationId: LEDGER_DEMO_ORGANISATION_ID,
      name: patient.name,
      email: email(patient),
      mobile: `07700 9${String(10000 + index).slice(1)}`,
      dob: patient.dob,
      postcode: patient.postcode,
      conditions: [patient.condition],
      primaryCondition: patient.condition,
      status: patient.firstDispenseAfter == null ? 'Referred' : patient.active ? 'HHH approved' : 'Suspended',
      commercialStatus: patient.firstDispenseAfter == null ? 'Referred' : patient.active ? 'Active' : 'Inactive',
      referredAt: referredAt.toISOString(),
      interactions: [{ ts: referredAt.toISOString(), type: 'referral', detail: 'Referred by HHH (demo)' }],
    };
  });
}

export type LedgerDemoEvent = {
  id: string;
  kind: 'new-referral' | 'annual-patient';
  amount: number;
  occurredAt: Date;
  organisationId: string;
  pharmacyName: string;
  patientKey: string;
  patientName: string;
  patientEmail: string;
  anniversary: number | null;
};

/** £50 on the first collected dispense, then £40 on each anniversary while the patient stays active. */
export function ledgerDemoEvents(now = new Date()): LedgerDemoEvent[] {
  const events: LedgerDemoEvent[] = [];
  for (const patient of PATIENTS) {
    if (patient.firstDispenseAfter == null) continue;
    const firstDispense = new Date(now.getTime() - (patient.referredDaysAgo - patient.firstDispenseAfter) * DAY);
    const base = {
      organisationId: LEDGER_DEMO_ORGANISATION_ID,
      pharmacyName: PHARMACY_NAME,
      patientKey: `${LEDGER_DEMO_ORGANISATION_ID}:${email(patient)}`,
      patientName: patient.name,
      patientEmail: email(patient),
    };
    events.push({ ...base, id: `ledger-demo-first-${patient.slug}`, kind: 'new-referral', amount: 50, occurredAt: firstDispense, anniversary: null });
    // An inactive patient earned the anniversaries they reached while still active: here, none after year one.
    const lastYear = patient.active ? 100 : 1;
    for (let year = 1; year <= lastYear; year += 1) {
      const anniversary = addYears(firstDispense, year);
      if (anniversary > now) break;
      events.push({ ...base, id: `ledger-demo-annual-${patient.slug}-${year}`, kind: 'annual-patient', amount: 40, occurredAt: anniversary, anniversary: year });
    }
  }
  return events;
}
