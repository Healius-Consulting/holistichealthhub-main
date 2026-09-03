import type { PatientOrder, Prescription } from '../context/AppContext';
import { formatShippingAddress } from './shippingAddress';

export type { CuraleafShippingAddress } from './shippingAddress';

export type OrderConsignment = {
  id: string;
  prescriptionIndex: number;
  purchaseOrderId: string | null;
  createdAt: string | null;
  packCount: number;
  shipmentCharge: string | null;
  shippingAddress: string | null;
  status: string;
  statusLabel: string;
};

const COURIER_LABELS: Record<string, string> = {
  POLAR_SPEED: 'Polar Speed',
  DX: 'DX',
  CURALEAF: 'Curaleaf',
  TRANSFER: 'Transfer',
  OTHER: 'Other',
};

const SHIPMENT_STATE_LABELS: Record<string, string> = {
  partially_dispatched_to_pharmacy: 'Part In Transit',
  dispatched_to_pharmacy: 'In Transit',
  in_transit: 'In Transit',
  dispatched: 'In Transit',
  partially_received: 'Part Arrived at Pharmacy',
  received: 'Arrived at Pharmacy',
  ready_for_collection: 'Ready to Collect',
  collected: 'Collected',
};

export function shortConsignmentId(id: string) {
  return id.length > 8 ? `${id.slice(0, 8)}…` : id;
}

export function formatCourierLabel(courier: string | null | undefined) {
  const value = String(courier || '').trim();
  if (!value) return null;
  return COURIER_LABELS[value] ?? value.replace(/_/g, ' ').replace(/\b\w/g, char => char.toUpperCase());
}

export function consignmentStatusLabel(state: string | null | undefined, hasShipment: boolean) {
  if (state && SHIPMENT_STATE_LABELS[state]) return SHIPMENT_STATE_LABELS[state];
  if (hasShipment) return 'In Transit';
  return 'Awaiting Dispatch';
}

function shipmentPackCount(shipment: NonNullable<Prescription['shipments']>[number]) {
  return (shipment.items ?? []).reduce((sum, item) => sum + Number(item.packCount || 0), 0);
}

export function collectOrderConsignments(order: PatientOrder): OrderConsignment[] {
  const seen = new Set<string>();
  const consignments: OrderConsignment[] = [];

  order.prescriptions.forEach((prescription, prescriptionIndex) => {
    const shipmentIds = prescription.shipmentIds?.length
      ? prescription.shipmentIds
      : prescription.shipmentId
        ? [prescription.shipmentId]
        : [];

    for (const shipmentId of shipmentIds) {
      if (!shipmentId || seen.has(shipmentId)) continue;
      seen.add(shipmentId);

      const shipment = prescription.shipments?.find(item => item.id === shipmentId);
      const state = prescription.shipmentStates?.[shipmentId];
      consignments.push({
        id: shipmentId,
        prescriptionIndex,
        purchaseOrderId: prescription.purchaseOrderId,
        createdAt: (() => {
          const value = shipment?.createdAt ?? prescription.latestShipmentAt ?? prescription.placedAt ?? null;
          return value instanceof Date ? value.toISOString() : value;
        })(),
        packCount: shipment ? shipmentPackCount(shipment) : (prescription.fulfilmentLines ?? []).reduce((sum, line) => sum + (line.shipped ?? 0), 0),
        shipmentCharge: shipment?.shipmentCharge ?? null,
        shippingAddress: formatShippingAddress(shipment?.shippingAddress) ?? prescription.deliveryAddress ?? null,
        status: state ?? (prescription.dispatchStatus === 'partial' ? 'partially_dispatched_to_pharmacy' : prescription.dispatchStatus === 'complete' ? 'dispatched_to_pharmacy' : 'not_dispatched'),
        statusLabel: consignmentStatusLabel(state, Boolean(shipment || prescription.dispatchStatus !== 'not_dispatched')),
      });
    }
  });

  return consignments.sort((left, right) => new Date(right.createdAt ?? 0).getTime() - new Date(left.createdAt ?? 0).getTime());
}

export function orderCourierLabel(order: PatientOrder) {
  const consignments = collectOrderConsignments(order);
  const courier = order.prescriptions.map(prescription => prescription.carrier).find(Boolean);
  if (courier) return formatCourierLabel(courier);
  if (consignments.length) return 'Assigned on dispatch';
  if (order.prescriptions.some(prescription => prescription.placed)) return 'Not yet dispatched';
  return 'Not yet dispatched';
}

export function orderDeliveryDestination(order: PatientOrder, pharmacyName: string | null | undefined) {
  const fromShipment = collectOrderConsignments(order).map(consignment => consignment.shippingAddress).find(Boolean);
  if (fromShipment) return fromShipment;
  const fromPrescription = order.prescriptions.map(prescription => prescription.deliveryAddress).find(Boolean);
  if (fromPrescription) return fromPrescription;
  if (pharmacyName) return pharmacyName;
  return null;
}

export function orderFinancialTotal(order: PatientOrder) {
  const lineTotal = order.prescriptions
    .flatMap(prescription => prescription.items)
    .reduce((sum, item) => sum + item.retail * item.qty, 0);
  return lineTotal + (order.dispensingFee ?? 0);
}
