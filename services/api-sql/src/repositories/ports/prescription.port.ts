export interface PrescriptionFileRecord {
  id: string;
  organisationId: string;
  patientId: string | null;
  storagePath: string;
  originalFilename: string;
  contentType: string;
  sizeBytes: number;
  status: string;
  verifiedAt: string | null;
  createdAt?: string;
  deletedAt?: string | null;
}

export interface PrescriberRecord {
  id: string;
  name: string;
  initials: string;
  pin: string;
  gmcNumber: number | null;
  gphcNumber: string | null;
  active: boolean;
  supplierIdentifiers?: Record<string, unknown> | null;
  createdAt?: string;
  updatedAt?: string;
}

export interface UpsertPrescriberInput {
  name: string;
  initials: string;
  pin: string;
  gmcNumber: number | null;
  gphcNumber: string | null;
  createdByUid?: string | null;
}

export interface PrescriptionRecord {
  id: string;
  organisationId?: string;
  patientId: string;
  prescriberId: string | null;
  fileId: string | null;
  supplierPrescriptionId?: string | null;
  serialNumber: string;
  issueDate: string;
  expiryDate: string;
  status: string;
  patientNameSnapshot: string;
  patientDobSnapshot: string;
  verifiedAt: string | null;
  createdAt: string;
}

export interface UpsertOrderPrescriptionInput {
  organisationId: string;
  orderId: string;
  patientId: string;
  fileId?: string | null;
  supplierPrescriptionId: string;
  serialNumber: string;
  issueDate: string;
  expiryDate: string;
  status: 'DRAFT' | 'VERIFIED' | 'AWAITING_PAYMENT' | 'PAID' | 'PENDING_PLACEMENT' | 'PLACED' | 'HELD_FOR_RENEWAL' | 'CANCELLED' | 'EXPIRED';
  patientNameSnapshot: string;
  patientDobSnapshot: string;
  prescriberSnapshot: unknown;
  prescriberId?: string | null;
  existingPrescriptionId?: string | null;
  supplierPurchaseOrderId?: string | null;
  placementState?: 'PENDING_PLACEMENT' | 'PLACED';
}

export interface PrescriptionRepositoryPort {
  findFileById(id: string, organisationId: string): Promise<PrescriptionFileRecord | null>;
  listCleanupCandidateFiles(limit?: number): Promise<PrescriptionFileRecord[]>;
  listLinkedPrescriptionFileIds(limit?: number): Promise<string[]>;
  listPrescriptionIdsByFileId(fileId: string, limit?: number): Promise<string[]>;
  createFile(data: {
    id?: string;
    organisationId: string;
    patientId?: string | null;
    storagePath: string;
    originalFilename: string;
    contentType: string;
    sizeBytes: number;
    uploadedByUid?: string | null;
  }): Promise<{ id?: string }>;
  completeFile(id: string, organisationId: string): Promise<boolean>;
  rejectFile(id: string, organisationId: string): Promise<boolean>;
  restoreFile(id: string, organisationId: string): Promise<boolean>;
  markFileDeleted(id: string, organisationId: string): Promise<boolean>;
  deleteFile(id: string, organisationId: string): Promise<boolean>;
  listActivePrescribers(): Promise<PrescriberRecord[]>;
  findActivePrescriberMatch(input: {
    pin: string;
    gmcNumber: number | null;
    gphcNumber: string | null;
  }): Promise<PrescriberRecord | null>;
  upsertPrescriber(input: UpsertPrescriberInput): Promise<PrescriberRecord>;
  listTenantPrescriptions(organisationId: string, limit?: number): Promise<PrescriptionRecord[]>;
  findPrescriptionBySupplierId(organisationId: string, supplierPrescriptionId: string): Promise<PrescriptionRecord | null>;
  findPrescriptionBySerial(organisationId: string, serialNumber: string): Promise<PrescriptionRecord | null>;
  recordSupplierPrescription(input: UpsertOrderPrescriptionInput): Promise<PrescriptionRecord>;
  listOrderPrescriptionsByOrganisation(organisationId: string, limit?: number): Promise<Array<{
    orderId: string;
    prescriptionId: string;
    supplierPurchaseOrderId: string | null;
    placementState: string;
  }>>;
  findOrderIdsBySupplierPurchaseOrderId(organisationId: string, supplierPurchaseOrderId: string): Promise<string[]>;
  findOrderIdsBySupplierPrescriptionId(organisationId: string, supplierPrescriptionId: string): Promise<string[]>;
  attachSupplierPurchaseOrder(orderId: string, supplierPurchaseOrderId: string): Promise<void>;
}
