import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { buildPrescriptionPlacementItems } from '../orders/prescription-units.js';
import { curaleafPlacementTargets } from '../prescriptions/snapshot-rx.js';
import { curaleafPrescriptionCreatePayload, curaleafPurchaseOrderPayload } from './curaleaf-placement-payload.js';

describe('multi-prescription Curaleaf outbound payloads', () => {
  it('builds three separate prescription and purchase-order requests', () => {
    const snapshot = {
      prescriptions: [
        { id: '1', serialNumber: 'T1', issueDate: '2026-08-29', items: [{ packId: 'pack-1', formulaId: 'formula-1', quantity: 1, packSize: 10 }] },
        { id: '2', serialNumber: 'T2', issueDate: '2026-08-29', items: [{ packId: 'pack-2', formulaId: 'formula-2', quantity: 2, packSize: 5 }] },
        { id: '3', serialNumber: 'T3', issueDate: '2026-08-29', items: [{ packId: 'pack-3', formulaId: 'formula-3', quantity: 3, packSize: 1 }] },
      ],
    };
    const targets = curaleafPlacementTargets(
      snapshot,
      'ORD-MTDQOYO5-204A222B97',
      'order-id',
      'pharmacy-one',
    );
    const prescriptionRequests = targets.map(target => {
      const items = buildPrescriptionPlacementItems({
        rawLines: target.prescription.items as Array<Record<string, unknown>>,
        prescriptionItems: target.prescription.items as Array<Record<string, unknown>>,
      }).items;
      return curaleafPrescriptionCreatePayload({
        serialNumber: String(target.prescription.serialNumber),
        issueDate: String(target.prescription.issueDate),
        prescriberId: `prescriber-${target.rxIndex + 1}`,
        items,
      });
    });

    assert.deepEqual(prescriptionRequests, [
      { serialNumber: 'T1', issueDate: '2026-08-29', prescriberId: 'prescriber-1', items: [{ formulaId: 'formula-1', unitsNeededCount: 10 }] },
      { serialNumber: 'T2', issueDate: '2026-08-29', prescriberId: 'prescriber-2', items: [{ formulaId: 'formula-2', unitsNeededCount: 10 }] },
      { serialNumber: 'T3', issueDate: '2026-08-29', prescriberId: 'prescriber-3', items: [{ formulaId: 'formula-3', unitsNeededCount: 3 }] },
    ]);
    assert.deepEqual(targets.map((target, index) => curaleafPurchaseOrderPayload({
      customerReference: target.customerReference,
      prescriptionId: `curaleaf-rx-${index + 1}`,
    })), [
      { customerReference: 'M75-204A222B97-P1', prescriptionIds: ['curaleaf-rx-1'] },
      { customerReference: 'M75-204A222B97-P2', prescriptionIds: ['curaleaf-rx-2'] },
      { customerReference: 'M75-204A222B97-P3', prescriptionIds: ['curaleaf-rx-3'] },
    ]);
  });
});
