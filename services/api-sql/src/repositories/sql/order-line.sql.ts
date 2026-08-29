import { dataConnect } from '../../bootstrap/firebase.js';
import type {
  CreateOrderLineInput,
  OrderLineRecord,
  OrderLineRepositoryPort,
} from '../ports/order-line.port.js';

const LINE_FIELDS = `
  id orderId prescriptionId formulaId formulaName packId quantity
  fixedPatientPricePence wholesalePackPricePence allocatedDispensingFeePence
  lineMedicineRevenuePence placementState
`;

const LIST_BY_ORDER_GQL = `
  query ListOrderLinesByOrder($orderId: UUID!) {
    orderLines(where: { orderId: { eq: $orderId } }, limit: 200) {
      ${LINE_FIELDS}
    }
  }
`;

const LIST_BY_ORG_GQL = `
  query ListOrderLinesByOrganisation($organisationId: UUID!, $limit: Int!) {
    orderLines(where: { order: { organisationId: { eq: $organisationId } } }, limit: $limit) {
      ${LINE_FIELDS}
    }
  }
`;

const MARK_LINES_PLACED_GQL = `
  mutation MarkOrderLinesPlaced($orderId: UUID!) {
    orderLine_updateMany(
      where: { orderId: { eq: $orderId } }
      data: { placementState: PLACED, updatedAt_expr: "request.time" }
    )
  }
`;

const MARK_LINES_PLACED_FOR_RX_GQL = `
  mutation MarkOrderLinesPlacedForPrescription($orderId: UUID!, $prescriptionId: UUID!) {
    orderLine_updateMany(
      where: { orderId: { eq: $orderId }, prescriptionId: { eq: $prescriptionId } }
      data: { placementState: PLACED, updatedAt_expr: "request.time" }
    )
  }
`;

const INSERT_LINE_GQL = `
  mutation InsertOrderLine(
    $orderId: UUID!
    $prescriptionId: UUID
    $formulaId: String
    $formulaName: String
    $packId: String!
    $quantity: Int!
    $fixedPatientPricePence: Int64!
    $wholesalePackPricePence: Int64
    $allocatedDispensingFeePence: Int64!
    $lineMedicineRevenuePence: Int64!
    $placementState: PlacementState!
  ) {
    orderLine_insert(data: {
      orderId: $orderId
      prescriptionId: $prescriptionId
      formulaId: $formulaId
      formulaName: $formulaName
      packId: $packId
      quantity: $quantity
      fixedPatientPricePence: $fixedPatientPricePence
      wholesalePackPricePence: $wholesalePackPricePence
      allocatedDispensingFeePence: $allocatedDispensingFeePence
      lineMedicineRevenuePence: $lineMedicineRevenuePence
      placementState: $placementState
    })
  }
`;

export class SqlOrderLineRepository implements OrderLineRepositoryPort {
  async listByOrderId(orderId: string): Promise<OrderLineRecord[]> {
    const result = await dataConnect.executeGraphql<{ orderLines: OrderLineRecord[] }, { orderId: string }>(
      LIST_BY_ORDER_GQL,
      { variables: { orderId } },
    );
    return result.data.orderLines ?? [];
  }

  async listByOrganisation(organisationId: string, limit = 500): Promise<OrderLineRecord[]> {
    const result = await dataConnect.executeGraphql<{ orderLines: OrderLineRecord[] }, { organisationId: string; limit: number }>(
      LIST_BY_ORG_GQL,
      { variables: { organisationId, limit } },
    );
    return result.data.orderLines ?? [];
  }

  async markLinesPlaced(orderId: string): Promise<void> {
    await dataConnect.executeGraphql(MARK_LINES_PLACED_GQL, {
      variables: { orderId },
    });
  }

  async markLinesPlacedByPrescriptionId(orderId: string, prescriptionId: string): Promise<void> {
    await dataConnect.executeGraphql(MARK_LINES_PLACED_FOR_RX_GQL, {
      variables: { orderId, prescriptionId },
    });
  }

  async replaceOrderLines(orderId: string, lines: CreateOrderLineInput[]): Promise<void> {
    const existing = await this.listByOrderId(orderId);
    if (existing.length > 0 || lines.length === 0) return;
    for (const line of lines) {
      if (!line.packId || line.quantity <= 0) continue;
      await dataConnect.executeGraphql(INSERT_LINE_GQL, {
        variables: {
          orderId,
          prescriptionId: line.prescriptionId ?? null,
          formulaId: line.formulaId ?? null,
          formulaName: line.formulaName ?? null,
          packId: line.packId,
          quantity: line.quantity,
          fixedPatientPricePence: Math.max(0, Math.round(line.fixedPatientPricePence)),
          wholesalePackPricePence: line.wholesalePackPricePence == null
            ? null
            : Math.max(0, Math.round(line.wholesalePackPricePence)),
          allocatedDispensingFeePence: Math.max(0, Math.round(line.allocatedDispensingFeePence ?? 0)),
          lineMedicineRevenuePence: Math.max(0, Math.round(line.lineMedicineRevenuePence ?? line.fixedPatientPricePence * line.quantity)),
          placementState: line.placementState ?? 'PENDING_PLACEMENT',
        },
      });
    }
  }
}
