import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { IntegrationConnectionRecord } from '../../repositories/ports/integration.port.js';
import type { OrganisationRecord, SetupTaskRecord } from '../../repositories/ports/organisation.port.js';
import type { StaffUserRecord } from '../../repositories/ports/identity.port.js';
import { buildGoLiveReadinessView, buildOperationalStatus, buildSetupStatusView, goLiveBlockedMessage } from './operational-readiness.js';

const organisation: OrganisationRecord = {
  id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', companyId: null, name: 'Eligible Pharmacy',
  tradingName: 'Eligible Pharmacy', gphcNumber: '9012345', superintendentName: 'Test Pharmacist',
  mainContactName: null, mainContactPhone: null, mainContactEmail: null, address: 'Test address',
  addressLine1: null, addressLine2: null, locality: null, county: null, postcode: null, latitude: null, longitude: null,
  primaryColour: '#12372d', logoText: 'EP', status: 'ONBOARDING', classification: 'STANDARD',
  portalName: 'Eligible Pharmacy', intakeEnabled: true, prescriptionEnabled: true, paymentsEnabled: true,
  supplierOrdersEnabled: true, patientsEnabled: true, resourcesEnabled: true, worldpayEnabled: false,
  defaultPaymentRoute: 'MANUAL', pharmacyDeliveryEnabled: false, autoPlacementEnabled: false, gdprComplianceFlag: true,
  pausedReason: null, pausedAt: null, version: 1, archivedAt: null,
};

function task(taskCode: string, completed: boolean): SetupTaskRecord {
  return {
    id: taskCode, organisationId: organisation.id, taskCode, required: true, completed,
    evidence: completed ? 'Recorded by HHH' : null, completedByUid: completed ? 'staff' : null,
    completedAt: completed ? '2026-08-20T00:00:00.000Z' : null,
    createdAt: '2026-08-20T00:00:00.000Z', updatedAt: '2026-08-20T00:00:00.000Z',
  };
}

function staff(status: StaffUserRecord['status'], uid: string): StaffUserRecord {
  return {
    uid, organisationId: organisation.id, email: `${uid}@example.test`, displayName: uid,
    role: 'PHARMACY_STAFF', status, disabled: false, version: 1,
  };
}

function connection(
  integration: 'CURALEAF' | 'WORLDPAY',
  status: IntegrationConnectionRecord['status'],
  environment: IntegrationConnectionRecord['environment'] = 'PRODUCTION',
): IntegrationConnectionRecord {
  return {
    id: `${integration}-1`, organisationId: organisation.id, integration, environment,
    status, secretResourceName: status === 'ACTIVE' ? 'secret' : null, externalCustomerId: 'PHAR1',
    maskedCredential: '••••1234', validatedAt: status === 'ACTIVE' ? '2026-08-20T00:00:00.000Z' : null,
    lastSuccessfulAt: null, lastErrorCode: null, version: 1, createdAt: '2026-08-20T00:00:00.000Z',
    updatedAt: '2026-08-20T00:00:00.000Z',
  };
}

function loggedGoLiveTasks() {
  return [task('intake_call', true), task('operational_readiness', true)];
}

describe('operational readiness', () => {
  it('keeps intake live during training and blocks go-live until the three HHH gates pass', () => {
    const operational = buildOperationalStatus({
      organisation,
      tasks: [task('pharmacy_profile', true), task('payment_route', true), task('pricing', true)],
      staff: [staff('ACTIVE', 'owner')],
      curaleaf: null,
      worldpay: null,
    });
    assert.equal(operational.intake.live, true);
    assert.equal(operational.workspace.mode, 'training');
    assert.equal(operational.curaleaf.label, 'Waiting');
    assert.equal(operational.payment.label, 'Pharmacy-managed');
    assert.equal(operational.goLiveReady, false);
    assert.deepEqual(operational.missingGates, ['intake_call', 'walkthrough', 'curaleaf_production']);
  });

  it('blocks go-live while paused or classified as a training tenant', () => {
    const paused = buildOperationalStatus({
      organisation: { ...organisation, status: 'PAUSED' },
      tasks: loggedGoLiveTasks(),
      staff: [staff('ACTIVE', 'owner')],
      curaleaf: connection('CURALEAF', 'ACTIVE'),
      worldpay: null,
    });
    assert.equal(paused.goLiveReady, false);
    assert.ok(paused.missingGates.includes('paused'));
    assert.equal(goLiveBlockedMessage(paused), 'Unpause this pharmacy before flipping the workspace to live.');

    const training = buildOperationalStatus({
      organisation: { ...organisation, classification: 'TRAINING' },
      tasks: loggedGoLiveTasks(),
      staff: [staff('ACTIVE', 'owner')],
      curaleaf: connection('CURALEAF', 'ACTIVE'),
      worldpay: null,
    });
    assert.equal(training.goLiveReady, false);
    assert.ok(training.missingGates.includes('training_tenant'));
  });

  it('does not treat Worldpay as a go-live blocker', () => {
    const operational = buildOperationalStatus({
      organisation: { ...organisation, defaultPaymentRoute: 'WORLDPAY' },
      tasks: [...loggedGoLiveTasks(), task('payment_route', true)],
      staff: [staff('ACTIVE', 'owner'), staff('ACTIVE', 'dispenser')],
      curaleaf: connection('CURALEAF', 'ACTIVE'),
      worldpay: connection('WORLDPAY', 'PENDING_VALIDATION'),
    });
    assert.equal(operational.payment.passed, false);
    assert.equal(operational.payment.label, 'Worldpay not connected');
    assert.equal(operational.goLiveReady, true);
  });

  it('rejects a test Curaleaf connection as production', () => {
    const operational = buildOperationalStatus({
      organisation,
      tasks: loggedGoLiveTasks(),
      staff: [staff('ACTIVE', 'owner')],
      curaleaf: connection('CURALEAF', 'ACTIVE', 'TEST'),
      worldpay: null,
    });
    assert.equal(operational.curaleaf.connected, true);
    assert.equal(operational.curaleaf.production, false);
    assert.equal(operational.curaleaf.label, 'Test');
    assert.equal(operational.goLiveReady, false);
    assert.ok(operational.missingGates.includes('curaleaf_production'));
    assert.equal(
      goLiveBlockedMessage(operational),
      'Activate Curaleaf production for this pharmacy before flipping the workspace live.',
    );
  });

  it('marks go-live ready only after intake call, walkthrough, and Curaleaf production', () => {
    const tasks = [
      task('pharmacy_profile', true),
      task('payment_route', true),
      task('pricing', true),
      task('intake_call', true),
      task('operational_readiness', true),
    ];
    const curaleaf = connection('CURALEAF', 'ACTIVE');
    const setup = buildSetupStatusView({
      organisation,
      tasks,
      staff: [staff('ACTIVE', 'owner'), staff('ACTIVE', 'dispenser')],
      curaleaf,
      worldpay: null,
    });
    assert.equal(setup.tasks.find(item => item.id === 'curaleaf_account')?.completed, true);
    assert.equal(setup.operational.goLiveReady, true);
    const readiness = buildGoLiveReadinessView({ organisation, operational: setup.operational, curaleaf });
    assert.equal(readiness.intakeReady, true);
    assert.equal(readiness.ready, true);
    assert.equal(readiness.status, 'onboarding');
    assert.equal(readiness.gates.curaleafLive.passed, true);
    assert.equal(readiness.gates.curaleafLive.secretStored, true);
  });
});
