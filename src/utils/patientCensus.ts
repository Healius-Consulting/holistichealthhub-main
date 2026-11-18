import type { CRMPatient, PatientOrder } from '../context/AppContext';
import { derivePatientJourneyStage } from './pharmacyPatientDirectory.ts';

export type PatientCensus = {
  referredThisMonth: number;
  referredAllTime: number;
  activeThisMonth: number;
  activeAllTime: number;
};

const LONDON_MONTH = new Intl.DateTimeFormat('en-GB', { timeZone: 'Europe/London', year: 'numeric', month: '2-digit' });

function londonMonth(value: Date | string | null | undefined) {
  if (!value) return null;
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? null : LONDON_MONTH.format(date);
}

/**
 * The Overview's Referred and Active counts for the demo data set, worked out from the
 * same patients the Patients page lists, so the tile and the list it opens always agree.
 * The status follows the Patients page: the commercial status when there is one, else
 * the journey stage. (The live Overview gets these counts from the server.)
 */
export function demoPatientCensus(patients: CRMPatient[], orders: PatientOrder[], now = new Date()): PatientCensus {
  const thisMonth = londonMonth(now);
  const census: PatientCensus = { referredThisMonth: 0, referredAllTime: 0, activeThisMonth: 0, activeAllTime: 0 };
  for (const patient of patients) {
    const own = orders.filter(order => order.patientId === patient.id);
    const stage = derivePatientJourneyStage({ crmPatient: patient, submission: null, orderCount: own.length, isNegativeEligibility: () => false });
    const status = patient.commercialStatus ?? (stage === 'referred' ? 'Referred' : stage === 'active' ? 'Active' : null);
    if (status === 'Referred') {
      census.referredAllTime += 1;
      if (londonMonth(patient.referredAt) === thisMonth) census.referredThisMonth += 1;
    } else if (status === 'Active') {
      census.activeAllTime += 1;
      // Active from their first order.
      const first = own.map(order => order.payment.paidAt ?? order.date).filter(Boolean).sort((a, b) => new Date(a!).getTime() - new Date(b!).getTime())[0];
      if (londonMonth(first) === thisMonth) census.activeThisMonth += 1;
    }
  }
  return census;
}
