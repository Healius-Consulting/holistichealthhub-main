export interface OrderLineRecord {
  id: string;
  orderId: string;
  prescriptionId?: string | null;
  formulaId?: string | null;
  formulaName?: string | null;
  packId: string;
  quantity: number;
  fixedPatientPricePence: number;
  wholesalePackPricePence?: number | null;
  allocatedDispensingFeePence?: number;
  lineMedicineRevenuePence?: number;
  placementState: string;
}

export interface CreateOrderLineInput {
  orderId: string;
  packId: string;
  quantity: number;
  formulaId?: string | null;
  formulaName?: string | null;
  prescriptionId?: string | null;
  fixedPatientPricePence: number;
  wholesalePackPricePence?: number | null;
  allocatedDispensingFeePence?: number;
  lineMedicineRevenuePence?: number;
  placementState?: 'PENDING_PLACEMENT' | 'PLACED';
}

export interface OrderLineRepositoryPort {
  listByOrderId(orderId: string): Promise<OrderLineRecord[]>;
  listByOrganisation(organisationId: string, limit?: number): Promise<OrderLineRecord[]>;
  replaceOrderLines(orderId: string, lines: CreateOrderLineInput[]): Promise<void>;
  markLinesPlaced(orderId: string): Promise<void>;
  markLinesPlacedByPrescriptionId(orderId: string, prescriptionId: string): Promise<void>;
}
