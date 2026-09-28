import { dataConnect } from '../../bootstrap/firebase.js';
import type { PatientFinanceRepositoryPort } from '../ports/patient-finance.port.js';

const FIND_DISPENSE_EVENT_GQL = `
  query FindDispenseEvent($orderId: UUID!, $dispenseKey: String!) {
    dispenseEvents(
      where: { orderId: { eq: $orderId }, dispenseKey: { eq: $dispenseKey } }
      limit: 1
    ) {
      id
      orderId
      dispenseKey
      dispensedAt
    }
  }
`;

const LIST_RECENT_DISPENSE_EVENTS_GQL = `
  query ListRecentDispenseEvents($patientId: UUID!, $limit: Int!) {
    dispenseEvents(
      where: { patientId: { eq: $patientId } }
      orderBy: { dispensedAt: DESC }
      limit: $limit
    ) {
      id
      orderId
      dispenseKey
      dispensedAt
    }
  }
`;

const LATEST_PAID_AT_GQL = `
  query LatestPatientPayment($patientId: UUID!) {
    orders(
      where: { patientId: { eq: $patientId }, paidAt: { isNull: false } }
      orderBy: { paidAt: DESC }
      limit: 1
    ) {
      paidAt
    }
  }
`;

const HAS_NEW_REFERRAL_FEE_GQL = `
  query HasNewReferralFee($patientId: UUID!) {
    referralFeeEvents(
      where: { patientId: { eq: $patientId }, kind: { eq: NEW_REFERRAL } }
      limit: 1
    ) {
      id
    }
  }
`;

const INSERT_DISPENSE_EVENT_GQL = `
  mutation InsertDispenseEvent(
    $organisationId: UUID!
    $patientId: UUID!
    $orderId: UUID!
    $dispenseKey: String!
    $recordedByUid: String!
    $dispensedAt: Timestamp!
  ) {
    dispenseEvent_insert(data: {
      organisationId: $organisationId
      patientId: $patientId
      orderId: $orderId
      dispenseKey: $dispenseKey
      recordedByUid: $recordedByUid
      dispensedAt: $dispensedAt
    })
  }
`;

const INSERT_REFERRAL_FEE_EVENT_GQL = `
  mutation InsertReferralFeeEvent(
    $organisationId: UUID!
    $patientId: UUID!
    $orderId: UUID
    $kind: FeeEventKind!
    $amountPence: Int64!
    $dueDate: Date!
    $status: String!
    $idempotencyKey: String!
  ) {
    referralFeeEvent_insert(data: {
      organisationId: $organisationId
      patientId: $patientId
      orderId: $orderId
      kind: $kind
      amountPence: $amountPence
      dueDate: $dueDate
      status: $status
      idempotencyKey: $idempotencyKey
    })
  }
`;

export class SqlPatientFinanceRepository implements PatientFinanceRepositoryPort {
  async findDispenseEvent(orderId: string, dispenseKey: string) {
    const result = await dataConnect.executeGraphql<
      { dispenseEvents: Array<{ id: string; orderId: string; dispenseKey: string; dispensedAt?: string }> },
      { orderId: string; dispenseKey: string }
    >(FIND_DISPENSE_EVENT_GQL, { variables: { orderId, dispenseKey } });
    return result.data.dispenseEvents?.[0] ?? null;
  }

  async listRecentDispenseEvents(patientId: string, limit = 2) {
    const result = await dataConnect.executeGraphql<
      { dispenseEvents: Array<{ id: string; orderId: string; dispenseKey: string; dispensedAt?: string }> },
      { patientId: string; limit: number }
    >(LIST_RECENT_DISPENSE_EVENTS_GQL, { variables: { patientId, limit } });
    return result.data.dispenseEvents ?? [];
  }

  async insertDispenseEvent(data: {
    organisationId: string;
    patientId: string;
    orderId: string;
    dispenseKey: string;
    recordedByUid: string;
    dispensedAt: string;
  }) {
    await dataConnect.executeGraphql(INSERT_DISPENSE_EVENT_GQL, {
      variables: {
        organisationId: data.organisationId,
        patientId: data.patientId,
        orderId: data.orderId,
        dispenseKey: data.dispenseKey,
        recordedByUid: data.recordedByUid,
        dispensedAt: data.dispensedAt,
      },
    });
  }

  async latestPaidAt(patientId: string) {
    const result = await dataConnect.executeGraphql<
      { orders: Array<{ paidAt?: string | null }> },
      { patientId: string }
    >(LATEST_PAID_AT_GQL, { variables: { patientId } });
    return result.data.orders?.[0]?.paidAt ?? null;
  }

  async hasNewReferralFee(patientId: string) {
    const result = await dataConnect.executeGraphql<
      { referralFeeEvents: Array<{ id: string }> },
      { patientId: string }
    >(HAS_NEW_REFERRAL_FEE_GQL, { variables: { patientId } });
    return (result.data.referralFeeEvents?.length ?? 0) > 0;
  }

  async insertReferralFeeEvent(data: {
    organisationId: string;
    patientId: string;
    orderId?: string | null;
    kind: 'NEW_REFERRAL' | 'ANNUAL_PATIENT';
    amountPence: number;
    dueDate: string;
    status: string;
    idempotencyKey: string;
  }) {
    try {
      await dataConnect.executeGraphql(INSERT_REFERRAL_FEE_EVENT_GQL, {
        variables: {
          organisationId: data.organisationId,
          patientId: data.patientId,
          orderId: data.orderId ?? null,
          kind: data.kind,
          amountPence: data.amountPence,
          dueDate: data.dueDate,
          status: data.status,
          idempotencyKey: data.idempotencyKey,
        },
      });
      return true;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (message.includes('idempotencyKey') || message.includes('unique') || message.includes('already exists')) {
        return false;
      }
      throw error;
    }
  }
}
