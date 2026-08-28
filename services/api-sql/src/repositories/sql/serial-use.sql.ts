import { dataConnect } from '../../bootstrap/firebase.js';
import { normalizeSerialNumber } from '../../application/prescriptions/serial-reuse.js';

export type PrescriptionSerialEndReason = 'replaced' | 'hh_cancelled' | 'curaleaf_cancelled' | 'exhausted' | 'refunded';

export type PrescriptionSerialUseRecord = {
  id: string;
  organisationId: string;
  serialNumber: string;
  issueDate: string;
  patientId: string;
  orderId: string | null;
  prescriptionId: string | null;
  curaleafPrescriptionId: string | null;
  live: boolean;
  startedAt: string;
  endedAt: string | null;
  endReason: string | null;
};

const SERIAL_USE_FIELDS = `
  id
  organisationId
  serialNumber
  issueDate
  patientId
  orderId
  prescriptionId
  curaleafPrescriptionId
  live
  startedAt
  endedAt
  endReason
`;

const FIND_LIVE_SERIAL_USE_GQL = `
  query FindLivePrescriptionSerialUse($organisationId: UUID!, $serialNumber: String!) {
    prescriptionSerialUses(
      where: {
        organisationId: { eq: $organisationId }
        serialNumber: { eq: $serialNumber }
        live: { eq: true }
      }
      limit: 5
    ) {
      ${SERIAL_USE_FIELDS}
    }
  }
`;

const FIND_LIVE_SERIAL_USE_BY_ORDER_GQL = `
  query FindLivePrescriptionSerialUseByOrder($organisationId: UUID!, $orderId: UUID!) {
    prescriptionSerialUses(
      where: {
        organisationId: { eq: $organisationId }
        orderId: { eq: $orderId }
        live: { eq: true }
      }
      limit: 20
    ) {
      ${SERIAL_USE_FIELDS}
    }
  }
`;

const INSERT_SERIAL_USE_GQL = `
  mutation InsertPrescriptionSerialUse(
    $organisationId: UUID!
    $serialNumber: String!
    $issueDate: Date!
    $patientId: UUID!
    $orderId: UUID
    $prescriptionId: UUID
    $curaleafPrescriptionId: String
  ) {
    prescriptionSerialUse_insert(data: {
      organisationId: $organisationId
      serialNumber: $serialNumber
      issueDate: $issueDate
      patientId: $patientId
      orderId: $orderId
      prescriptionId: $prescriptionId
      curaleafPrescriptionId: $curaleafPrescriptionId
      live: true
    })
  }
`;

const UPDATE_LIVE_SERIAL_USE_GQL = `
  mutation UpdateLivePrescriptionSerialUse(
    $id: UUID!
    $prescriptionId: UUID
    $curaleafPrescriptionId: String
    $issueDate: Date
  ) {
    prescriptionSerialUse_update(
      key: { id: $id }
      data: {
        prescriptionId: $prescriptionId
        curaleafPrescriptionId: $curaleafPrescriptionId
        issueDate: $issueDate
        updatedAt_expr: "request.time"
      }
    )
  }
`;

const END_SERIAL_USE_GQL = `
  mutation EndPrescriptionSerialUse(
    $id: UUID!
    $endReason: String!
  ) {
    prescriptionSerialUse_update(
      key: { id: $id }
      data: {
        live: false
        endedAt_expr: "request.time"
        endReason: $endReason
        updatedAt_expr: "request.time"
      }
    )
  }
`;

export class SqlPrescriptionSerialRepository {
  async findLive(organisationId: string, serialNumber: string): Promise<PrescriptionSerialUseRecord | null> {
    const serial = normalizeSerialNumber(serialNumber);
    if (!serial) return null;
    const result = await dataConnect.executeGraphql<{ prescriptionSerialUses: PrescriptionSerialUseRecord[] }, any>(
      FIND_LIVE_SERIAL_USE_GQL,
      { variables: { organisationId, serialNumber: serial } },
    );
    return result.data.prescriptionSerialUses?.[0] ?? null;
  }

  async findLiveByOrder(organisationId: string, orderId: string): Promise<PrescriptionSerialUseRecord[]> {
    const result = await dataConnect.executeGraphql<{ prescriptionSerialUses: PrescriptionSerialUseRecord[] }, any>(
      FIND_LIVE_SERIAL_USE_BY_ORDER_GQL,
      { variables: { organisationId, orderId } },
    );
    return result.data.prescriptionSerialUses ?? [];
  }

  async claim(input: {
    organisationId: string;
    serialNumber: string;
    issueDate: string;
    patientId: string;
    orderId: string;
    prescriptionId?: string | null;
    curaleafPrescriptionId?: string | null;
    sourceOrderId?: string | null;
  }): Promise<PrescriptionSerialUseRecord> {
    const serial = normalizeSerialNumber(input.serialNumber);
    const live = await this.findLive(input.organisationId, serial);
    if (live && live.orderId === input.orderId) {
      await dataConnect.executeGraphql(UPDATE_LIVE_SERIAL_USE_GQL, {
        variables: {
          id: live.id,
          prescriptionId: input.prescriptionId ?? live.prescriptionId ?? null,
          curaleafPrescriptionId: input.curaleafPrescriptionId ?? live.curaleafPrescriptionId ?? null,
          issueDate: input.issueDate || live.issueDate,
        },
      });
      return (await this.findLive(input.organisationId, serial)) ?? live;
    }
    if (live && input.sourceOrderId && live.orderId === input.sourceOrderId) {
      await this.end(live.id, 'replaced');
    } else if (live) {
      throw Object.assign(new Error('SERIAL_IN_USE'), { occupyingOrderId: live.orderId });
    }
    await dataConnect.executeGraphql(INSERT_SERIAL_USE_GQL, {
      variables: {
        organisationId: input.organisationId,
        serialNumber: serial,
        issueDate: input.issueDate,
        patientId: input.patientId,
        orderId: input.orderId,
        prescriptionId: input.prescriptionId ?? null,
        curaleafPrescriptionId: input.curaleafPrescriptionId ?? null,
      },
    });
    const saved = await this.findLive(input.organisationId, serial);
    if (!saved) throw new Error('Prescription serial occupancy could not be stored.');
    return saved;
  }

  async end(id: string, endReason: PrescriptionSerialEndReason): Promise<void> {
    await dataConnect.executeGraphql(END_SERIAL_USE_GQL, { variables: { id, endReason } });
  }

  async endLiveForOrder(organisationId: string, orderId: string, endReason: PrescriptionSerialEndReason): Promise<void> {
    const rows = await this.findLiveByOrder(organisationId, orderId);
    for (const row of rows) {
      await this.end(row.id, endReason);
    }
  }
}
