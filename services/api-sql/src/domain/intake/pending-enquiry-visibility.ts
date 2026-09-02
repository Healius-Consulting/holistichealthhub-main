import { uuidKey } from '../common/uuid.js';

/** Pharmacy pending list matches this rule; the GraphQL query must stay assigned-only. */
export function isAssignedPendingEnquiry(
  record: {
    pharmacyAccessStatus?: string | null;
    outcomeStatus?: string | null;
    assignedOrganisationId?: string | null;
    sourceOrganisationId?: string | null;
  },
  organisationId: string,
) {
  if (String(record.pharmacyAccessStatus || '').toUpperCase() !== 'WITHHELD') return false;
  if (String(record.outcomeStatus || '').toUpperCase() !== 'OPEN') return false;
  if (!record.assignedOrganisationId) return false;
  return uuidKey(record.assignedOrganisationId) === uuidKey(organisationId);
}
