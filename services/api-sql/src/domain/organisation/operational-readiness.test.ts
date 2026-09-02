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
  return [task('intake_call', true)];
}

describe('operational readiness', () => {
  it('keeps intake live during training and blocks go-live until the intake call is logged', () => {
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
    assert.deepEqual(operational.missingGates, ['intake_call']);
  });

  it('blocks go-live while paused, and treats Primary as an always-on Test pharmacy', () => {
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

    const platformTest = buildOperationalStatus({
      organisation: { ...organisation, id: '70913a30-71c3-4a41-952e-d532927af58c' },
      tasks: loggedGoLiveTasks(),
      staff: [staff('ACTIVE', 'owner')],
      curaleaf: connection('CURALEAF', 'ACTIVE', 'TEST'),
      worldpay: null,
    });
    assert.equal(platformTest.goLiveReady, true);
    assert.ok(!platformTest.missingGates.includes('training_tenant'));
    assert.equal(platformTest.workspace.mode, 'test');
    assert.equal(platformTest.intake.live, true);
  });

  it('lets a classified test pharmacy go live on Curaleaf sandbox keys', () => {
    const operational = buildOperationalStatus({
      organisation: { ...organisation, classification: 'TRAINING' },
      tasks: loggedGoLiveTasks(),
      staff: [staff('ACTIVE', 'owner')],
      curaleaf: connection('CURALEAF', 'ACTIVE', 'TEST'),
      worldpay: null,
    });
    assert.equal(operational.goLiveReady, true);
    assert.equal(operational.workspace.mode, 'training');
    const liveTest = buildOperationalStatus({
      organisation: { ...organisation, classification: 'TRAINING', status: 'LIVE' },
      tasks: loggedGoLiveTasks(),
      staff: [staff('ACTIVE', 'owner')],
      curaleaf: connection('CURALEAF', 'ACTIVE', 'TEST'),
      worldpay: null,
    });
    assert.equal(liveTest.workspace.mode, 'test');
    assert.equal(liveTest.workspace.label, 'Test');
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

  it('lets a logged intake go live while Curaleaf is still on test, with an acknowledgement', () => {
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
    assert.equal(operational.goLiveReady, true);
    assert.ok(!operational.missingGates.includes('curaleaf_production'));
    const readiness = buildGoLiveReadinessView({ organisation, operational, curaleaf: connection('CURALEAF', 'ACTIVE', 'TEST') });
    assert.equal(readiness.ready, true);
    assert.equal(readiness.curaleafTestAcknowledgementRequired, true);
    assert.equal(readiness.gates.curaleafLive.passed, false);
  });

  it('marks go-live ready after the intake call and Curaleaf production, without a walkthrough log', () => {
    const tasks = [
      task('pharmacy_profile', true),
      task('payment_route', true),
      task('pricing', true),
      task('intake_call', true),
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
    assert.equal(setup.operational.walkthrough.completed, false);
    assert.ok(!setup.operational.missingGates.includes('walkthrough'));
    const readiness = buildGoLiveReadinessView({ organisation, operational: setup.operational, curaleaf });
    assert.equal(readiness.intakeReady, true);
    assert.equal(readiness.ready, true);
    assert.equal(readiness.status, 'onboarding');
    assert.equal(readiness.gates.curaleafLive.passed, true);
    assert.equal(readiness.curaleafTestAcknowledgementRequired, false);
    assert.equal(readiness.gates.curaleafLive.secretStored, true);
  });
});
