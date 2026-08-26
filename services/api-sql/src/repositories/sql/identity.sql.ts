import { dataConnect } from '../../bootstrap/firebase.js';
import type {
  AppendAuditInput,
  CreateSessionInput,
  IdentityRepositoryPort,
  PortalAdmissionResult,
  StaffSessionRecord,
  StaffUserRecord,
  UpsertStaffUserInput,
} from '../ports/identity.port.js';

const GET_PORTAL_ADMISSION_GQL = `
  query GetPortalAdmission($sessionHash: String!, $staffUid: String!) {
    staffSession(key: { sessionHash: $sessionHash }) {
      sessionHash
      staffUid
      organisationId
      surface
      role
      userAgentHash
      createdAt
      lastActivityAt
      idleExpiresAt
      absoluteExpiresAt
      revokedAt
      revokeReason
    }
    staffUser(key: { uid: $staffUid }) {
      uid
      organisationId
      email
      displayName
      role
      status
      disabled
      version
    }
  }
`;

const GET_STAFF_USER_GQL = `
  query GetStaffUserByUid($uid: String!) {
    staffUser(key: { uid: $uid }) {
      uid
      organisationId
      email
      displayName
      role
      status
      disabled
      preferences
      invitedAt
      activatedAt
      lastSignedInAt
      createdAt
      version
    }
  }
`;

const LIST_PHARMACY_STAFF_BY_ORG_GQL = `
  query ListPharmacyStaffByOrganisation($organisationId: UUID!) {
    staffUsers(
      where: {
        organisationId: { eq: $organisationId }
        role: { eq: PHARMACY_STAFF }
        status: { ne: REMOVED }
      }
      orderBy: { createdAt: ASC }
      limit: 500
    ) {
      uid
      organisationId
      email
      displayName
      role
      status
      disabled
      createdAt
    }
  }
`;

const LIST_PLATFORM_ADMINS_GQL = `
  query ListPlatformAdmins {
    staffUsers(
      where: {
        role: { eq: HHH_ADMIN }
        status: { ne: REMOVED }
      }
      orderBy: { createdAt: ASC }
      limit: 500
    ) {
      uid
      organisationId
      email
      displayName
      role
      status
      disabled
      createdAt
    }
  }
`;

const UPSERT_STAFF_USER_GQL = `
  mutation UpsertStaffUser(
    $uid: String!
    $organisationId: UUID
    $email: String!
    $displayName: String!
    $role: StaffRole!
    $status: StaffStatus!
    $disabled: Boolean!
  ) {
    staffUser_upsert(data: {
      uid: $uid
      organisationId: $organisationId
      email: $email
      displayName: $displayName
      role: $role
      status: $status
      disabled: $disabled
    })
  }
`;

const UPDATE_STAFF_USER_STATUS_GQL = `
  mutation UpdateStaffUserStatus(
    $uid: String!
    $status: StaffStatus!
    $disabled: Boolean!
  ) {
    staffUser_update(
      key: { uid: $uid }
      data: {
        status: $status
        disabled: $disabled
      }
    )
  }
`;

const ACTIVATE_INVITED_STAFF_USER_GQL = `
  mutation ActivateInvitedStaffUser($uid: String!) {
    updated: staffUser_updateMany(
      where: {
        uid: { eq: $uid }
        status: { eq: INVITED }
        disabled: { eq: false }
      }
      data: {
        status: ACTIVE
        disabled: false
        activatedAt_expr: "request.time"
        updatedAt_expr: "request.time"
      }
    )
  }
`;

const GET_STAFF_SESSION_GQL = `
  query GetStaffSessionByHash($sessionHash: String!) {
    staffSession(key: { sessionHash: $sessionHash }) {
      sessionHash
      staffUid
      organisationId
      surface
      role
      userAgentHash
      createdAt
      lastActivityAt
      idleExpiresAt
      absoluteExpiresAt
      revokedAt
      revokeReason
    }
  }
`;

const CREATE_STAFF_SESSION_GQL = `
  mutation CreateStaffSession(
    $sessionHash: String!
    $staffUid: String!
    $organisationId: UUID
    $surface: String!
    $role: StaffRole!
    $userAgentHash: String!
    $lastActivityAt: Timestamp!
    $idleExpiresAt: Timestamp!
    $absoluteExpiresAt: Timestamp!
  ) {
    staffSession_insert(data: {
      sessionHash: $sessionHash
      staffUid: $staffUid
      organisationId: $organisationId
      surface: $surface
      role: $role
      userAgentHash: $userAgentHash
      lastActivityAt: $lastActivityAt
      idleExpiresAt: $idleExpiresAt
      absoluteExpiresAt: $absoluteExpiresAt
    })
  }
`;

const TOUCH_STAFF_SESSION_GQL = `
  mutation TouchStaffSession(
    $sessionHash: String!
    $lastActivityAt: Timestamp!
    $idleExpiresAt: Timestamp!
  ) {
    staffSession_update(
      key: { sessionHash: $sessionHash }
      data: {
        lastActivityAt: $lastActivityAt
        idleExpiresAt: $idleExpiresAt
      }
    )
  }
`;

const REVOKE_STAFF_SESSION_GQL = `
  mutation RevokeStaffSession(
    $sessionHash: String!
    $revokedAt: Timestamp!
    $revokeReason: String!
  ) {
    staffSession_update(
      key: { sessionHash: $sessionHash }
      data: {
        revokedAt: $revokedAt
        revokeReason: $revokeReason
      }
    )
  }
`;

const APPEND_AUDIT_LOG_GQL = `
  mutation AppendAuditLog(
    $organisationId: UUID
    $actorUid: String
    $actorRole: StaffRole
    $event: String!
    $recordType: String
    $recordId: String
    $requestId: String
    $sessionHashPrefix: String
    $ipHash: String
    $surface: String
    $details: Any
  ) {
    auditLog_insert(data: {
      organisationId: $organisationId
      actorUid: $actorUid
      actorRole: $actorRole
      event: $event
      recordType: $recordType
      recordId: $recordId
      requestId: $requestId
      sessionHashPrefix: $sessionHashPrefix
      ipHash: $ipHash
      surface: $surface
      details: $details
    })
  }
`;

export class SqlIdentityRepository implements IdentityRepositoryPort {
  async findAdmission(sessionHash: string, staffUid: string): Promise<PortalAdmissionResult> {
    const result = await dataConnect.executeGraphql<{
      staffSession: StaffSessionRecord | null;
      staffUser: StaffUserRecord | null;
    }, any>(GET_PORTAL_ADMISSION_GQL, {
      variables: { sessionHash, staffUid },
    });
    return {
      session: result.data.staffSession ?? null,
      staff: result.data.staffUser ?? null,
    };
  }

  async findStaffUser(uid: string): Promise<StaffUserRecord | null> {
    const result = await dataConnect.executeGraphql<{ staffUser: StaffUserRecord | null }, any>(
      GET_STAFF_USER_GQL,
      { variables: { uid } }
    );
    return result.data.staffUser ?? null;
  }

  async listPharmacyStaffByOrganisationId(organisationId: string): Promise<StaffUserRecord[]> {
    const result = await dataConnect.executeGraphql<{ staffUsers: StaffUserRecord[] }, any>(
      LIST_PHARMACY_STAFF_BY_ORG_GQL,
      { variables: { organisationId } },
    );
    return result.data.staffUsers ?? [];
  }

  async listPlatformAdmins(): Promise<StaffUserRecord[]> {
    const result = await dataConnect.executeGraphql<{ staffUsers: StaffUserRecord[] }, any>(
      LIST_PLATFORM_ADMINS_GQL,
    );
    return result.data.staffUsers ?? [];
  }

  async upsertStaffUser(input: UpsertStaffUserInput): Promise<void> {
    await dataConnect.executeGraphql<any, any>(UPSERT_STAFF_USER_GQL, {
      variables: input,
    });
  }

  async updateStaffUserStatus(uid: string, status: 'INVITED' | 'ACTIVE' | 'DISABLED' | 'REMOVED', disabled: boolean): Promise<void> {
    await dataConnect.executeGraphql<any, any>(UPDATE_STAFF_USER_STATUS_GQL, {
      variables: { uid, status, disabled },
    });
  }

  async activateInvitedStaffUser(uid: string): Promise<boolean> {
    const result = await dataConnect.executeGraphql<{ updated: number }, { uid: string }>(
      ACTIVATE_INVITED_STAFF_USER_GQL,
      { variables: { uid } },
    );
    return result.data.updated === 1;
  }

  async findStaffSession(sessionHash: string): Promise<StaffSessionRecord | null> {
    const result = await dataConnect.executeGraphql<{ staffSession: StaffSessionRecord | null }, any>(
      GET_STAFF_SESSION_GQL,
      { variables: { sessionHash } }
    );
    return result.data.staffSession ?? null;
  }

  async createSession(input: CreateSessionInput): Promise<void> {
    await dataConnect.executeGraphql<any, any>(CREATE_STAFF_SESSION_GQL, {
      variables: {
        sessionHash: input.sessionHash,
        staffUid: input.staffUid,
        organisationId: input.organisationId,
        surface: input.surface,
        role: input.role,
        userAgentHash: input.userAgentHash,
        lastActivityAt: input.lastActivityAt,
        idleExpiresAt: input.idleExpiresAt,
        absoluteExpiresAt: input.absoluteExpiresAt,
      },
    });
  }

  async touchSession(sessionHash: string, lastActivityAt: string, idleExpiresAt: string): Promise<void> {
    await dataConnect.executeGraphql<any, any>(TOUCH_STAFF_SESSION_GQL, {
      variables: { sessionHash, lastActivityAt, idleExpiresAt },
    });
  }

  async revokeSession(sessionHash: string, revokedAt: string, reason: string): Promise<void> {
    await dataConnect.executeGraphql<any, any>(REVOKE_STAFF_SESSION_GQL, {
      variables: { sessionHash, revokedAt, revokeReason: reason },
    });
  }

  async appendAudit(input: AppendAuditInput): Promise<void> {
    await dataConnect.executeGraphql<any, any>(APPEND_AUDIT_LOG_GQL, {
      variables: {
        organisationId: input.organisationId ?? null,
        actorUid: input.actorUid ?? null,
        actorRole: input.actorRole ?? null,
        event: input.event,
        recordType: input.recordType ?? null,
        recordId: input.recordId ?? null,
        requestId: input.requestId ?? null,
        sessionHashPrefix: input.sessionHashPrefix ?? null,
        ipHash: input.ipHash ?? null,
        surface: input.surface ?? null,
        details: input.details ?? null,
      },
    });
  }
}
