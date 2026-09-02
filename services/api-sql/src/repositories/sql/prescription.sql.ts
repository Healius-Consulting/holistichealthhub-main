import { dataConnect } from '../../bootstrap/firebase.js';
import type {
  PrescriberRecord,
  PrescriptionFileRecord,
  PrescriptionRecord,
  PrescriptionRepositoryPort,
  UpsertOrderPrescriptionInput,
  UpsertPrescriberInput,
} from '../ports/prescription.port.js';

const PRESCRIBER_FIELDS = `
  id
  name
  initials
  pin
  gmcNumber
  gphcNumber
  active
  supplierIdentifiers
  createdAt
  updatedAt
`;

const GET_PRESCRIPTION_FILE_BY_ID_GQL = `
  query GetPrescriptionFileById($id: UUID!, $organisationId: UUID!) {
    prescriptionFiles(
      where: {
        id: { eq: $id }
        organisationId: { eq: $organisationId }
      }
      limit: 1
    ) {
      id
      organisationId
      patientId
      storagePath
      originalFilename
      contentType
      sizeBytes
      status
      verifiedAt
      createdAt
      deletedAt
    }
  }
`;

const LIST_CLEANUP_CANDIDATE_FILES_GQL = `
  query ListCleanupCandidateFiles($limit: Int!) {
    prescriptionFiles(
      where: { status: { in: [PENDING_UPLOAD, UPLOADED] } }
      limit: $limit
    ) {
      id
      organisationId
      patientId
      storagePath
      originalFilename
      contentType
      sizeBytes
      status
      verifiedAt
      createdAt
      deletedAt
    }
  }
`;

const LIST_LINKED_PRESCRIPTION_FILE_IDS_GQL = `
  query ListLinkedPrescriptionFileIds($limit: Int!) {
    prescriptions(where: { fileId: { isNull: false } }, limit: $limit) {
      fileId
    }
  }
`;

const LIST_PRESCRIPTION_IDS_BY_FILE_ID_GQL = `
  query ListPrescriptionIdsByFileId($fileId: UUID!, $limit: Int!) {
    prescriptions(where: { fileId: { eq: $fileId } }, limit: $limit) {
      id
    }
  }
`;

const LIST_ACTIVE_PRESCRIBERS_GQL = `
  query ListActivePrescribers {
    prescribers(where: { active: { eq: true } }, limit: 500) {
      ${PRESCRIBER_FIELDS}
    }
  }
`;

const FIND_PRESCRIBER_BY_PIN_GQL = `
  query FindPrescriberByPin($pin: String!) {
    prescribers(where: { pin: { eq: $pin }, active: { eq: true } }, limit: 1) {
      ${PRESCRIBER_FIELDS}
    }
  }
`;

const FIND_PRESCRIBER_BY_GMC_GQL = `
  query FindPrescriberByGmc($gmcNumber: Int64!) {
    prescribers(where: { gmcNumber: { eq: $gmcNumber }, active: { eq: true } }, limit: 1) {
      ${PRESCRIBER_FIELDS}
    }
  }
`;

const FIND_PRESCRIBER_BY_GPHC_GQL = `
  query FindPrescriberByGphc($gphcNumber: String!) {
    prescribers(where: { gphcNumber: { eq: $gphcNumber }, active: { eq: true } }, limit: 1) {
      ${PRESCRIBER_FIELDS}
    }
  }
`;

const INSERT_PRESCRIBER_GQL = `
  mutation InsertPrescriber(
    $name: String!
    $initials: String!
    $pin: String!
    $gmcNumber: Int64
    $gphcNumber: String
    $createdByUid: String
  ) {
    prescriber_insert(data: {
      name: $name
      initials: $initials
      pin: $pin
      gmcNumber: $gmcNumber
      gphcNumber: $gphcNumber
      active: true
      supplierIdentifiers: {}
      createdByUid: $createdByUid
    })
  }
`;

const UPDATE_PRESCRIBER_GQL = `
  mutation UpdatePrescriber(
    $id: UUID!
    $name: String!
    $initials: String!
    $pin: String!
    $gmcNumber: Int64
    $gphcNumber: String
  ) {
    prescriber_update(
      key: { id: $id }
      data: {
        name: $name
        initials: $initials
        pin: $pin
        gmcNumber: $gmcNumber
        gphcNumber: $gphcNumber
        active: true
        updatedAt_expr: "request.time"
      }
    )
  }
`;

const PRESCRIPTION_FIELDS = `
  id
  organisationId
  patientId
  prescriberId
  fileId
  supplierPrescriptionId
  serialNumber
  issueDate
  expiryDate
  status
  patientNameSnapshot
  patientDobSnapshot
  verifiedAt
  createdAt
`;

const LIST_TENANT_PRESCRIPTIONS_GQL = `
  query ListTenantPrescriptions($organisationId: UUID!, $limit: Int!) {
    prescriptions(
      where: { organisationId: { eq: $organisationId } }
      limit: $limit
    ) {
      ${PRESCRIPTION_FIELDS}
    }
  }
`;

const FIND_PRESCRIPTION_BY_SUPPLIER_ID_GQL = `
  query FindPrescriptionBySupplierId($organisationId: UUID!, $supplierPrescriptionId: String!) {
    prescriptions(
      where: { organisationId: { eq: $organisationId }, supplierPrescriptionId: { eq: $supplierPrescriptionId } }
      limit: 1
    ) {
      ${PRESCRIPTION_FIELDS}
    }
  }
`;

const FIND_PRESCRIPTION_BY_ID_GQL = `
  query FindPrescriptionById($id: UUID!) {
    prescriptions(where: { id: { eq: $id } }, limit: 1) {
      ${PRESCRIPTION_FIELDS}
    }
  }
`;

const FIND_PRESCRIPTION_BY_SERIAL_GQL = `
  query FindPrescriptionBySerial($organisationId: UUID!, $serialNumber: String!) {
    prescriptions(
      where: { organisationId: { eq: $organisationId }, serialNumber: { eq: $serialNumber } }
      orderBy: [{ createdAt: DESC }]
      limit: 5
    ) {
      ${PRESCRIPTION_FIELDS}
    }
  }
`;

const INSERT_PRESCRIPTION_GQL = `
  mutation InsertPrescription(
    $organisationId: UUID!
    $patientId: UUID!
    $fileId: UUID
    $prescriberId: UUID
    $supplierPrescriptionId: String!
    $serialNumber: String!
    $issueDate: Date!
    $expiryDate: Date!
    $status: PrescriptionStatus!
    $patientNameSnapshot: String!
    $patientDobSnapshot: Date!
    $prescriberSnapshot: Any!
  ) {
    prescription_insert(data: {
      organisationId: $organisationId
      patientId: $patientId
      fileId: $fileId
      prescriberId: $prescriberId
      supplierPrescriptionId: $supplierPrescriptionId
      serialNumber: $serialNumber
      issueDate: $issueDate
      expiryDate: $expiryDate
      status: $status
      patientNameSnapshot: $patientNameSnapshot
      patientDobSnapshot: $patientDobSnapshot
      prescriberSnapshot: $prescriberSnapshot
    })
  }
`;

const UPDATE_PRESCRIPTION_SUPPLIER_GQL = `
  mutation UpdatePrescriptionSupplier(
    $id: UUID!
    $supplierPrescriptionId: String!
    $status: PrescriptionStatus!
    $fileId: UUID
  ) {
    prescription_update(
      key: { id: $id }
      data: {
        supplierPrescriptionId: $supplierPrescriptionId
        status: $status
        fileId: $fileId
        updatedAt_expr: "request.time"
      }
    )
  }
`;

const LIST_ORDER_PRESCRIPTIONS_GQL = `
  query ListOrderPrescriptionsByOrganisation($organisationId: UUID!, $limit: Int!) {
    orderPrescriptions(where: { order: { organisationId: { eq: $organisationId } } }, limit: $limit) {
      orderId
      prescriptionId
      supplierPurchaseOrderId
      placementState
    }
  }
`;

const LIST_ORDER_PRESCRIPTIONS_BY_PO_GQL = `
  query ListOrderPrescriptionsByPurchaseOrder($organisationId: UUID!, $supplierPurchaseOrderId: String!) {
    orderPrescriptions(
      where: {
        supplierPurchaseOrderId: { eq: $supplierPurchaseOrderId }
        order: { organisationId: { eq: $organisationId } }
      }
      limit: 20
    ) {
      orderId
    }
  }
`;

const LIST_ORDER_PRESCRIPTIONS_BY_RX_GQL = `
  query ListOrderPrescriptionsBySupplierPrescription($organisationId: UUID!, $supplierPrescriptionId: String!) {
    orderPrescriptions(
      where: {
        prescription: { supplierPrescriptionId: { eq: $supplierPrescriptionId } }
        order: { organisationId: { eq: $organisationId } }
      }
      limit: 20
    ) {
      orderId
    }
  }
`;

const LIST_ORDER_PRESCRIPTIONS_BY_ORDER_GQL = `
  query ListOrderPrescriptionsByOrder($orderId: UUID!) {
    orderPrescriptions(where: { orderId: { eq: $orderId } }, limit: 20) {
      orderId
      prescriptionId
      supplierPurchaseOrderId
      placementState
    }
  }
`;

const UPSERT_ORDER_PRESCRIPTION_GQL = `
  mutation UpsertOrderPrescription(
    $orderId: UUID!
    $prescriptionId: UUID!
    $placementState: PlacementState!
    $supplierPurchaseOrderId: String
  ) {
    orderPrescription_upsert(data: {
      orderId: $orderId
      prescriptionId: $prescriptionId
      placementState: $placementState
      supplierPurchaseOrderId: $supplierPurchaseOrderId
      updatedAt_expr: "request.time"
    })
  }
`;

const UPSERT_ORDER_PRESCRIPTION_PLACED_GQL = `
  mutation UpsertPlacedOrderPrescription(
    $orderId: UUID!
    $prescriptionId: UUID!
    $supplierPurchaseOrderId: String
  ) {
    orderPrescription_upsert(data: {
      orderId: $orderId
      prescriptionId: $prescriptionId
      placementState: PLACED
      supplierPurchaseOrderId: $supplierPurchaseOrderId
      placedAt_expr: "request.time"
      updatedAt_expr: "request.time"
    })
  }
`;

const CREATE_PRESCRIPTION_FILE_GQL = `
  mutation CreatePrescriptionFile(
    $id: UUID
    $organisationId: UUID!
    $patientId: UUID
    $storagePath: String!
    $originalFilename: String!
    $contentType: String!
    $sizeBytes: Int64!
    $uploadedByUid: String
  ) {
    prescriptionFile_insert(data: {
      id: $id
      organisationId: $organisationId
      patientId: $patientId
      storagePath: $storagePath
      originalFilename: $originalFilename
      contentType: $contentType
      sizeBytes: $sizeBytes
      uploadedByUid: $uploadedByUid
      status: PENDING_UPLOAD
    })
  }
`;

const COMPLETE_PRESCRIPTION_FILE_GQL = `
  mutation CompletePrescriptionFile($id: UUID!) {
    prescriptionFile_update(
      key: { id: $id }
      data: {
        status: UPLOADED
        uploadedAt_expr: "request.time"
        verifiedAt_expr: "request.time"
      }
    )
  }
`;

const REJECT_PRESCRIPTION_FILE_GQL = `
  mutation RejectPrescriptionFile($id: UUID!) {
    prescriptionFile_update(
      key: { id: $id }
      data: {
        status: REJECTED
        verifiedAt: null
        updatedAt_expr: "request.time"
      }
    )
  }
`;

const RESTORE_PRESCRIPTION_FILE_GQL = `
  mutation RestorePrescriptionFile($id: UUID!) {
    prescriptionFile_update(
      key: { id: $id }
      data: {
        status: UPLOADED
        deletedAt: null
        updatedAt_expr: "request.time"
      }
    )
  }
`;

const MARK_PRESCRIPTION_FILE_DELETED_GQL = `
  mutation MarkPrescriptionFileDeleted($id: UUID!) {
    prescriptionFile_update(
      key: { id: $id }
      data: {
        status: DELETED
        deletedAt_expr: "request.time"
        updatedAt_expr: "request.time"
      }
    )
  }
`;

const DELETE_PRESCRIPTION_FILE_GQL = `
  mutation DeletePrescriptionFile($id: UUID!) {
    prescriptionFile_delete(key: { id: $id })
  }
`;

export class SqlPrescriptionRepository implements PrescriptionRepositoryPort {
  async findFileById(id: string, organisationId: string): Promise<PrescriptionFileRecord | null> {
    const result = await dataConnect.executeGraphql<{ prescriptionFiles: PrescriptionFileRecord[] }, any>(
      GET_PRESCRIPTION_FILE_BY_ID_GQL,
      { variables: { id, organisationId } }
    );
    return result.data.prescriptionFiles?.[0] ?? null;
  }

  async listCleanupCandidateFiles(limit = 1_000): Promise<PrescriptionFileRecord[]> {
    const result = await dataConnect.executeGraphql<{ prescriptionFiles: PrescriptionFileRecord[] }, any>(
      LIST_CLEANUP_CANDIDATE_FILES_GQL,
      { variables: { limit } },
    );
    return result.data.prescriptionFiles ?? [];
  }

  async listLinkedPrescriptionFileIds(limit = 2_000): Promise<string[]> {
    const result = await dataConnect.executeGraphql<{ prescriptions: Array<{ fileId: string | null }> }, any>(
      LIST_LINKED_PRESCRIPTION_FILE_IDS_GQL,
      { variables: { limit } },
    );
    return (result.data.prescriptions ?? []).flatMap(row => row.fileId ? [row.fileId] : []);
  }

  async listPrescriptionIdsByFileId(fileId: string, limit = 1): Promise<string[]> {
    const result = await dataConnect.executeGraphql<{ prescriptions: Array<{ id: string }> }, any>(
      LIST_PRESCRIPTION_IDS_BY_FILE_ID_GQL,
      { variables: { fileId, limit } },
    );
    return (result.data.prescriptions ?? []).map(row => row.id);
  }

  async listActivePrescribers(): Promise<PrescriberRecord[]> {
    const result = await dataConnect.executeGraphql<{ prescribers: PrescriberRecord[] }, any>(
      LIST_ACTIVE_PRESCRIBERS_GQL
    );
    return result.data.prescribers ?? [];
  }

  async findActivePrescriberMatch(input: {
    pin: string;
    gmcNumber: number | null;
    gphcNumber: string | null;
  }): Promise<PrescriberRecord | null> {
    const normalPin = input.pin.trim();
    const normalGphc = input.gphcNumber?.trim() ?? '';

    if (normalPin) {
      const byPin = await dataConnect.executeGraphql<{ prescribers: PrescriberRecord[] }, any>(
        FIND_PRESCRIBER_BY_PIN_GQL,
        { variables: { pin: normalPin } },
      );
      if (byPin.data.prescribers?.[0]) return byPin.data.prescribers[0];
    }

    if (input.gmcNumber) {
      const byGmc = await dataConnect.executeGraphql<{ prescribers: PrescriberRecord[] }, any>(
        FIND_PRESCRIBER_BY_GMC_GQL,
        { variables: { gmcNumber: input.gmcNumber } },
      );
      if (byGmc.data.prescribers?.[0]) return byGmc.data.prescribers[0];
    }

    if (normalGphc) {
      const byGphc = await dataConnect.executeGraphql<{ prescribers: PrescriberRecord[] }, any>(
        FIND_PRESCRIBER_BY_GPHC_GQL,
        { variables: { gphcNumber: normalGphc } },
      );
      if (byGphc.data.prescribers?.[0]) return byGphc.data.prescribers[0];
    }

    return null;
  }

  async upsertPrescriber(input: UpsertPrescriberInput): Promise<PrescriberRecord> {
    const payload = {
      name: input.name.trim(),
      initials: input.initials.trim(),
      pin: input.pin.trim(),
      gmcNumber: input.gmcNumber,
      gphcNumber: input.gphcNumber?.trim() || null,
      createdByUid: input.createdByUid ?? null,
    };

    const existing = await this.findActivePrescriberMatch(payload);
    if (existing) {
      await dataConnect.executeGraphql(UPDATE_PRESCRIBER_GQL, {
        variables: {
          id: existing.id,
          name: payload.name,
          initials: payload.initials,
          pin: payload.pin,
          gmcNumber: payload.gmcNumber,
          gphcNumber: payload.gphcNumber,
        },
      });
    } else {
      await dataConnect.executeGraphql(INSERT_PRESCRIBER_GQL, {
        variables: payload,
      });
    }

    const saved = await this.findActivePrescriberMatch(payload);
    if (!saved) throw new Error('Prescriber could not be saved.');
    return saved;
  }

  async listTenantPrescriptions(organisationId: string, limit = 200): Promise<PrescriptionRecord[]> {
    const result = await dataConnect.executeGraphql<{ prescriptions: PrescriptionRecord[] }, any>(
      LIST_TENANT_PRESCRIPTIONS_GQL,
      { variables: { organisationId, limit } }
    );
    return result.data.prescriptions ?? [];
  }

  async createFile(data: {
    id?: string;
    organisationId: string;
    patientId?: string | null;
    storagePath: string;
    originalFilename: string;
    contentType: string;
    sizeBytes: number;
    uploadedByUid?: string | null;
  }): Promise<{ id?: string }> {
    const result = await dataConnect.executeGraphql<{ prescriptionFile_insert: { id: string } }, any>(
      CREATE_PRESCRIPTION_FILE_GQL,
      {
        variables: {
          id: data.id ?? null,
          organisationId: data.organisationId,
          patientId: data.patientId ?? null,
          storagePath: data.storagePath,
          originalFilename: data.originalFilename,
          contentType: data.contentType,
          sizeBytes: data.sizeBytes,
          uploadedByUid: data.uploadedByUid ?? null,
        },
      }
    );
    return { id: result.data.prescriptionFile_insert?.id ?? data.id };
  }

  async completeFile(id: string, organisationId: string): Promise<boolean> {
    const existing = await this.findFileById(id, organisationId);
    if (!existing) return false;
    await dataConnect.executeGraphql<any, any>(
      COMPLETE_PRESCRIPTION_FILE_GQL,
      { variables: { id } }
    );
    return true;
  }

  async rejectFile(id: string, organisationId: string): Promise<boolean> {
    const existing = await this.findFileById(id, organisationId);
    if (!existing) return false;
    await dataConnect.executeGraphql<any, any>(
      REJECT_PRESCRIPTION_FILE_GQL,
      { variables: { id } }
    );
    return true;
  }

  async restoreFile(id: string, organisationId: string): Promise<boolean> {
    const existing = await this.findFileById(id, organisationId);
    if (!existing) return false;
    await dataConnect.executeGraphql<any, any>(
      RESTORE_PRESCRIPTION_FILE_GQL,
      { variables: { id } }
    );
    return true;
  }

  async markFileDeleted(id: string, organisationId: string): Promise<boolean> {
    const existing = await this.findFileById(id, organisationId);
    if (!existing) return false;
    if (existing.status === 'DELETED' || existing.deletedAt) return true;
    await dataConnect.executeGraphql<any, any>(
      MARK_PRESCRIPTION_FILE_DELETED_GQL,
      { variables: { id } }
    );
    return true;
  }

  async deleteFile(id: string, organisationId: string): Promise<boolean> {
    const existing = await this.findFileById(id, organisationId);
    if (!existing) return false;
    await dataConnect.executeGraphql<any, any>(
      DELETE_PRESCRIPTION_FILE_GQL,
      { variables: { id } }
    );
    return true;
  }

  async findPrescriptionById(id: string): Promise<PrescriptionRecord | null> {
    const result = await dataConnect.executeGraphql<{ prescriptions: PrescriptionRecord[] }, { id: string }>(
      FIND_PRESCRIPTION_BY_ID_GQL,
      { variables: { id } },
    );
    return result.data.prescriptions?.[0] ?? null;
  }

  async findPrescriptionBySupplierId(organisationId: string, supplierPrescriptionId: string): Promise<PrescriptionRecord | null> {
    const result = await dataConnect.executeGraphql<{ prescriptions: PrescriptionRecord[] }, any>(
      FIND_PRESCRIPTION_BY_SUPPLIER_ID_GQL,
      { variables: { organisationId, supplierPrescriptionId } },
    );
    return result.data.prescriptions?.[0] ?? null;
  }

  async findPrescriptionBySerial(organisationId: string, serialNumber: string): Promise<PrescriptionRecord | null> {
    const result = await dataConnect.executeGraphql<{ prescriptions: PrescriptionRecord[] }, any>(
      FIND_PRESCRIPTION_BY_SERIAL_GQL,
      { variables: { organisationId, serialNumber } },
    );
    return result.data.prescriptions?.[0] ?? null;
  }

  async recordSupplierPrescription(input: UpsertOrderPrescriptionInput): Promise<PrescriptionRecord> {
    const existingBySupplier = input.supplierPrescriptionId
      ? await this.findPrescriptionBySupplierId(input.organisationId, input.supplierPrescriptionId)
      : null;
    const existingById = input.existingPrescriptionId
      ? await this.findPrescriptionById(input.existingPrescriptionId)
      : null;
    const existing = existingBySupplier ?? existingById;

    if (existing) {
      await dataConnect.executeGraphql(UPDATE_PRESCRIPTION_SUPPLIER_GQL, {
        variables: {
          id: existing.id,
          supplierPrescriptionId: input.supplierPrescriptionId,
          status: input.status,
          fileId: input.fileId ?? existing.fileId ?? null,
        },
      });
    } else {
      await dataConnect.executeGraphql(INSERT_PRESCRIPTION_GQL, {
        variables: {
          organisationId: input.organisationId,
          patientId: input.patientId,
          fileId: input.fileId ?? null,
          prescriberId: input.prescriberId ?? null,
          supplierPrescriptionId: input.supplierPrescriptionId,
          serialNumber: input.serialNumber,
          issueDate: input.issueDate,
          expiryDate: input.expiryDate,
          status: input.status,
          patientNameSnapshot: input.patientNameSnapshot,
          patientDobSnapshot: input.patientDobSnapshot,
          prescriberSnapshot: input.prescriberSnapshot ?? {},
        },
      });
    }

    const saved = await this.findPrescriptionBySupplierId(input.organisationId, input.supplierPrescriptionId);
    if (!saved) throw new Error('Prescription could not be saved with the Curaleaf prescription ID.');

    await this.upsertOrderPrescriptionLink({
      orderId: input.orderId,
      prescriptionId: saved.id,
      placementState: input.placementState ?? (input.status === 'PLACED' ? 'PLACED' : 'PENDING_PLACEMENT'),
      supplierPurchaseOrderId: input.supplierPurchaseOrderId ?? null,
    });

    return saved;
  }

  async listOrderPrescriptionsByOrganisation(organisationId: string, limit = 500) {
    const result = await dataConnect.executeGraphql<{
      orderPrescriptions: Array<{
        orderId: string;
        prescriptionId: string;
        supplierPurchaseOrderId: string | null;
        placementState: string;
      }>;
    }, { organisationId: string; limit: number }>(
      LIST_ORDER_PRESCRIPTIONS_GQL,
      { variables: { organisationId, limit } },
    );
    return result.data.orderPrescriptions ?? [];
  }

  async findOrderIdsBySupplierPurchaseOrderId(organisationId: string, supplierPurchaseOrderId: string): Promise<string[]> {
    const result = await dataConnect.executeGraphql<{ orderPrescriptions: Array<{ orderId: string }> }, any>(
      LIST_ORDER_PRESCRIPTIONS_BY_PO_GQL,
      { variables: { organisationId, supplierPurchaseOrderId } },
    );
    return [...new Set((result.data.orderPrescriptions ?? []).map(row => row.orderId))];
  }

  async findOrderIdsBySupplierPrescriptionId(organisationId: string, supplierPrescriptionId: string): Promise<string[]> {
    const result = await dataConnect.executeGraphql<{ orderPrescriptions: Array<{ orderId: string }> }, any>(
      LIST_ORDER_PRESCRIPTIONS_BY_RX_GQL,
      { variables: { organisationId, supplierPrescriptionId } },
    );
    return [...new Set((result.data.orderPrescriptions ?? []).map(row => row.orderId))];
  }

  async attachSupplierPurchaseOrder(orderId: string, supplierPurchaseOrderId: string): Promise<void> {
    const result = await dataConnect.executeGraphql<{
      orderPrescriptions: Array<{ orderId: string; prescriptionId: string; placementState: string }>;
    }, { orderId: string }>(
      LIST_ORDER_PRESCRIPTIONS_BY_ORDER_GQL,
      { variables: { orderId } },
    );
    const links = result.data.orderPrescriptions ?? [];
    for (const link of links) {
      await this.upsertOrderPrescriptionLink({
        orderId,
        prescriptionId: link.prescriptionId,
        placementState: 'PLACED',
        supplierPurchaseOrderId,
      });
    }
  }

  private async upsertOrderPrescriptionLink(input: {
    orderId: string;
    prescriptionId: string;
    placementState: string;
    supplierPurchaseOrderId?: string | null;
  }) {
    if (input.placementState === 'PLACED') {
      await dataConnect.executeGraphql(UPSERT_ORDER_PRESCRIPTION_PLACED_GQL, {
        variables: {
          orderId: input.orderId,
          prescriptionId: input.prescriptionId,
          supplierPurchaseOrderId: input.supplierPurchaseOrderId ?? null,
        },
      });
      return;
    }
    await dataConnect.executeGraphql(UPSERT_ORDER_PRESCRIPTION_GQL, {
      variables: {
        orderId: input.orderId,
        prescriptionId: input.prescriptionId,
        placementState: input.placementState,
        supplierPurchaseOrderId: input.supplierPurchaseOrderId ?? null,
      },
    });
  }
}
