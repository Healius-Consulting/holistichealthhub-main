import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { FakeClickupRepository, FakeVisitRepository } from '../../testing/clickup-fakes.js';
import { clickupHooks } from './clickup-hooks.js';

const request = {
  id: '6c1c5a0e-1a1f-4f43-9d1b-6f7a6f3f0a11',
  gphcNumber: '1234567',
  pharmacyName: 'Shah Pharmacy',
  registeredCompanyName: 'Shah Health Ltd',
  deliveryAddress: '1 High Street, Leeds, LS1 1AA',
  invoiceAddress: '1 High Street, Leeds, LS1 1AA',
  // Fields a caller might pass along with the record; none may reach ClickUp.
  pharmacistName: 'Asha Shah',
  pharmacyEmail: 'shop@shah.test',
  pharmacyPhone: '0113 000 0000',
  signatureName: 'Asha Shah',
};

const branch = {
  id: '70913a30-71c3-4a41-952e-d532927af58c',
  gphcNumber: '1234567',
  name: 'Shah Pharmacy',
  tradingName: 'Shah Health Ltd',
  address: '1 High Street, Leeds, LS1 1AA',
  postcode: null,
  defaultPaymentRoute: 'MANUAL',
  classification: 'STANDARD',
  mainContactEmail: 'owner@shah.test',
};

function setup() {
  const clickupRepo = new FakeClickupRepository();
  const visitRepo = new FakeVisitRepository();
  let tick = 0;
  const hooks = clickupHooks({ clickupRepo, visitRepo, now: () => new Date(Date.parse('2026-11-18T10:00:00.000Z') + (tick++) * 1_000) });
  return { clickupRepo, visitRepo, hooks };
}

describe('ClickUp hooks', () => {
  it('writes the stage-1 record and the Interest event once per GPhC', async () => {
    const { clickupRepo, visitRepo, hooks } = setup();
    await hooks.firstVisit({ gphcNumber: '1234567', pharmsmartPharmacyId: '30', tradingName: 'Shah Pharmacy' });
    await hooks.firstVisit({ gphcNumber: '1234567', pharmsmartPharmacyId: '30', tradingName: 'Shah Pharmacy' });
    assert.equal(visitRepo.visits.size, 1);
    assert.deepEqual(
      { ...visitRepo.visits.get('1234567'), firstVisitAt: undefined },
      { gphcNumber: '1234567', pharmsmartPharmacyId: '30', tradingName: 'Shah Pharmacy', firstVisitAt: undefined, submittedAt: null },
    );
    assert.deepEqual(clickupRepo.outbox.map(row => row.event), ['interest']);
    assert.equal(clickupRepo.outbox[0]!.payload.leadSource, 'PharmSmart');
  });

  it('queues a repeated submission once, marks the visit submitted and keeps the PharmSmart lead source', async () => {
    const { clickupRepo, visitRepo, hooks } = setup();
    await hooks.firstVisit({ gphcNumber: '1234567', pharmsmartPharmacyId: '30', tradingName: 'Shah Pharmacy' });
    await hooks.requestSubmitted(request);
    await hooks.requestSubmitted(request);
    assert.deepEqual(clickupRepo.outbox.map(row => row.event), ['interest', 'submitted']);
    const submitted = clickupRepo.outbox[1]!;
    assert.deepEqual(submitted.payload, {
      gphcNumber: '1234567',
      onboardingRequestId: request.id,
      pharmsmartPharmacyId: '30',
      tradingName: 'Shah Pharmacy',
      legalEntity: 'Shah Health Ltd',
      postcode: 'LS1 1AA',
      leadSource: 'PharmSmart',
    });
    assert.ok(visitRepo.visits.get('1234567')!.submittedAt);
  });

  it('marks a public-page submission as from the onboarding page', async () => {
    const { clickupRepo, hooks } = setup();
    await hooks.requestSubmitted(request);
    assert.equal(clickupRepo.outbox[0]!.payload.leadSource, 'Onboarding page');
  });

  it('sends no personal or patient fields in any event', async () => {
    const { clickupRepo, hooks } = setup();
    await hooks.requestSubmitted(request);
    await hooks.held({ ...request, reason: 'MORE_INFORMATION_NEEDED', heldAt: '2026-11-18T11:00:00.000Z' });
    await hooks.unheld(request);
    await hooks.activated({ requestId: request.id, organisation: branch });
    await hooks.curaleafConnectionSaved({ organisation: branch, pharCodeEntered: true, apiKeyEntered: true, wentLive: true });
    await hooks.checklistProgress({ organisation: branch, percent: 50 });
    await hooks.held({ ...request, organisationId: branch.id, reason: 'EXISTING_CURALEAF_CUSTOMER', heldAt: '2026-11-18T12:00:00.000Z' });
    await hooks.unheld({ ...request, organisationId: branch.id });
    const json = JSON.stringify(clickupRepo.outbox.map(row => row.payload));
    for (const banned of ['shop@shah.test', 'owner@shah.test', '0113 000 0000', 'Asha Shah', 'High Street']) {
      assert.ok(!json.includes(banned), `${banned} must not reach ClickUp`);
    }
    assert.deepEqual(clickupRepo.outbox.map(row => row.event), [
      'submitted', 'held', 'unheld', 'activated', 'phar_code_entered', 'api_key_entered', 'live', 'checklist_progress', 'held_existing_curaleaf', 'unheld_activated',
    ]);
    const activated = clickupRepo.outbox.find(row => row.event === 'activated')!;
    assert.equal(activated.payload.branchId, branch.id);
    assert.equal(activated.payload.onboardingRequestId, request.id);
  });

  it('never gives a test or training pharmacy a card', async () => {
    const { clickupRepo, hooks } = setup();
    await hooks.curaleafConnectionSaved({ organisation: { ...branch, classification: 'TRAINING' }, pharCodeEntered: true, apiKeyEntered: true, wentLive: true });
    await hooks.checklistProgress({ organisation: { ...branch, gphcNumber: 'TRAINING-1' }, percent: 10 });
    assert.equal(clickupRepo.outbox.length, 0);
  });

  it('swallows a failing outbox so the caller still succeeds', async () => {
    const visitRepo = new FakeVisitRepository();
    const hooks = clickupHooks({
      clickupRepo: { enqueue: async () => { throw new Error('Data Connect down'); } },
      visitRepo,
    });
    const originalError = console.error;
    console.error = () => undefined;
    try {
      await hooks.firstVisit({ gphcNumber: '1234567', pharmsmartPharmacyId: '30', tradingName: 'Shah Pharmacy' });
      await hooks.requestSubmitted(request);
      await hooks.activated({ requestId: request.id, organisation: branch });
    } finally {
      console.error = originalError;
    }
  });
});
