import { dataConnect } from '../../bootstrap/firebase.js';
import { asUuid } from '../../domain/common/uuid.js';
import type { DemoPharmacyRecords, DemoPharmacyRepository } from '../../application/pharmacy-onboarding/demo-pharmacies.js';

/** Kept in step with scripts/delete-demo-pharmacy/delete-demo-pharmacy.gql (which also runs from the CLI). */
const FIND_GQL = `
  query FindDemoPharmacy($gphc: String!) {
    organisations(where: { gphcNumber: { eq: $gphc } }, limit: 5) { id name status createdAt }
    pharmacyOnboardingRequests(where: { gphcNumber: { eq: $gphc } }, limit: 20) { id pharmacyName status filledFormStoragePath licenceStoragePath createdAt }
    worldpayApplications(where: { gphcNumber: { eq: $gphc } }, limit: 20) { pdfStoragePath xlsxStoragePath }
  }
`;

const FIND_LINKS_GQL = `
  query FindDemoPharmacyLinks($organisationIds: [UUID!]!) {
    staffUsers(where: { organisationId: { in: $organisationIds } }, limit: 50) { uid }
    patients(where: { organisationId: { in: $organisationIds } }, limit: 1) { id }
    orders(where: { organisationId: { in: $organisationIds } }, limit: 1) { id }
  }
`;

const DELETE_GQL = `
  mutation DeleteDemoPharmacy($gphc: String!, $organisationIds: [UUID!]!, $requestIds: [UUID!]!, $staffUids: [String!]!) @transaction {
    sessionsByBranch: staffSession_deleteMany(where: { organisationId: { in: $organisationIds } })
    sessionsByStaff: staffSession_deleteMany(where: { staffUid: { in: $staffUids } })
    auditByBranch: auditLog_deleteMany(where: { organisationId: { in: $organisationIds } })
    auditByStaff: auditLog_deleteMany(where: { actorUid: { in: $staffUids } })
    setupTasks: setupTask_deleteMany(where: { organisationId: { in: $organisationIds } })
    checklist: organisationChecklistItem_deleteMany(where: { organisationId: { in: $organisationIds } })
    domains: organisationDomain_deleteMany(where: { organisationId: { in: $organisationIds } })
    referralTokens: referralToken_deleteMany(where: { organisationId: { in: $organisationIds } })
    integrations: integrationConnection_deleteMany(where: { organisationId: { in: $organisationIds } })
    staffTasks: staffTask_deleteMany(where: { organisationId: { in: $organisationIds } })
    directory: pharmacyDirectoryProfile_deleteMany(where: { organisationId: { in: $organisationIds } })
    termsByRequest: partnerTermsAcceptance_deleteMany(where: { onboardingRequestId: { in: $requestIds } })
    termsByBranch: partnerTermsAcceptance_deleteMany(where: { organisationId: { in: $organisationIds } })
    worldpayNotes: pharmacyWorldpaySubmission_deleteMany(where: { gphcNumber: { eq: $gphc } })
    worldpayApplications: worldpayApplication_deleteMany(where: { gphcNumber: { eq: $gphc } })
    requests: pharmacyOnboardingRequest_deleteMany(where: { id: { in: $requestIds } })
    staff: staffUser_deleteMany(where: { organisationId: { in: $organisationIds } })
    clickupOutbox: clickupOutbox_deleteMany(where: { gphcNumber: { eq: $gphc } })
    clickupCard: clickupCard_deleteMany(where: { gphcNumber: { eq: $gphc } })
    visits: pharmacyOnboardingVisit_deleteMany(where: { gphcNumber: { eq: $gphc } })
    deferrals: pharmacyOnboardingDeferral_deleteMany(where: { gphcNumber: { eq: $gphc } })
    branches: organisation_deleteMany(where: { id: { in: $organisationIds } })
  }
`;

type Found = {
  organisations: DemoPharmacyRecords['organisations'];
  pharmacyOnboardingRequests: DemoPharmacyRecords['requests'];
  worldpayApplications: Array<{ pdfStoragePath: string | null; xlsxStoragePath: string | null }>;
};

export class SqlDemoPharmacyRepository implements DemoPharmacyRepository {
  async find(gphc: string): Promise<DemoPharmacyRecords> {
    const found = (await dataConnect.executeGraphql<Found, { gphc: string }>(FIND_GQL, { variables: { gphc } })).data;
    const organisationIds = found.organisations.map(row => asUuid(row.id));
    const links = organisationIds.length
      ? (await dataConnect.executeGraphql<{ staffUsers: Array<{ uid: string }>; patients: unknown[]; orders: unknown[] }, { organisationIds: string[] }>(FIND_LINKS_GQL, { variables: { organisationIds } })).data
      : { staffUsers: [], patients: [], orders: [] };
    return {
      organisations: found.organisations,
      requests: found.pharmacyOnboardingRequests,
      staffUids: links.staffUsers.map(row => row.uid),
      worldpayFiles: found.worldpayApplications.flatMap(row => [row.pdfStoragePath, row.xlsxStoragePath]).filter((path): path is string => Boolean(path)),
      hasPatientsOrOrders: links.patients.length > 0 || links.orders.length > 0,
    };
  }

  async delete(input: { gphc: string; organisationIds: string[]; requestIds: string[]; staffUids: string[] }) {
    const result = await dataConnect.executeGraphql<Record<string, number>, Record<string, unknown>>(DELETE_GQL, {
      variables: {
        gphc: input.gphc,
        organisationIds: input.organisationIds.map(id => asUuid(id)),
        requestIds: input.requestIds.map(id => asUuid(id)),
        staffUids: input.staffUids,
      },
    });
    return Object.fromEntries(Object.entries(result.data).filter(([, count]) => Number(count) > 0)) as Record<string, number>;
  }
}
