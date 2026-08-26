import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  asClinicScanProducts,
  clinicPrescriptionPlacementEligibility,
  clinicScanId,
  matchClinicPrescriptionPacks,
  parseClinicPrescription,
  prescriptionIdFromUpload,
  prescriptionPatientIdentity,
} from './curaleaf-clinic-scan.js';

describe('clinic QR scan mapping', () => {
  it('reads the prescription id from Curaleaf’s from-image response', () => {
    assert.equal(prescriptionIdFromUpload({ id: 'rx-1' }), 'rx-1');
    assert.equal(prescriptionIdFromUpload({ prescription: { id: 'rx-2' } }), 'rx-2');
    assert.equal(prescriptionIdFromUpload({ fileId: 'not-an-id' }), undefined);
  });

  it('allows pending/active clinic prescriptions but blocks terminal prescriptions', () => {
    assert.deepEqual(clinicPrescriptionPlacementEligibility('PENDING'), { eligible: true, waiting: true });
    assert.deepEqual(clinicPrescriptionPlacementEligibility('ACTIVE'), { eligible: true, waiting: false });
    assert.equal(clinicPrescriptionPlacementEligibility('FULFILLED').eligible, false);
    assert.equal(clinicPrescriptionPlacementEligibility('EXPIRED').eligible, false);
    assert.equal(clinicPrescriptionPlacementEligibility('CANCELLED').eligible, false);
  });

  it('does not require a patient name or date of birth on a clinic prescription', () => {
    assert.equal(prescriptionPatientIdentity({
      id: 'rx-1',
      serialNumber: 'CL-1',
    }), null);
  });

  it('matches an exact active pack for each formula line', () => {
    const matched = matchClinicPrescriptionPacks(
      [{ formulaId: 'f1', formulaName: 'Flower 10g', unit: 'g', unitsNeededCount: 20, unitsAssignedCount: 0 }],
      [
        { id: 'p-small', formulaId: 'f1', patientPackPrice: '40.00', quantity: 10, state: 'ACTIVE' },
        { id: 'p-exact', formulaId: 'f1', patientPackPrice: '75.00', quantity: 20, state: 'ACTIVE' },
      ],
    );
    assert.equal(matched[0]?.packId, 'p-exact');
    assert.equal(matched[0]?.quantity, 1);
  });

  it('builds a stable scan id from the pharmacy and file only', () => {
    const left = clinicScanId('org-a', 'file-a');
    const right = clinicScanId('org-a', 'file-a');
    assert.equal(left, right);
    assert.notEqual(left, clinicScanId('org-b', 'file-a'));
  });

  it('accepts formula arrays when Curaleaf omits items', () => {
    const prescription = parseClinicPrescription({
      id: 'rx-1',
      serialNumber: 'CL-1',
      prescriberId: 'pr-1',
      prescriberName: 'Dr Example',
      issueDate: '2026-08-21',
      expiryDate: '2026-09-18',
      state: 'PENDING',
      formulas: [{
        formulaId: 'f1',
        formulaName: 'Flower 10g',
        unit: 'g',
        unitsNeededCount: 10,
        unitsAssignedCount: 0,
      }],
    });
    assert.equal(prescription.items[0]?.formulaId, 'f1');
  });

  it('ignores catalogue rows that are not usable packs', () => {
    assert.deepEqual(asClinicScanProducts([{ id: 'p1' }, {
      id: 'p2',
      formulaId: 'f1',
      patientPackPrice: '10.00',
      quantity: 10,
      state: 'ACTIVE',
    }]), [{
      id: 'p2',
      formulaId: 'f1',
      formulaName: undefined,
      formulaUnit: undefined,
      patientPackPrice: '10.00',
      quantity: 10,
      state: 'ACTIVE',
    }]);
  });
});
