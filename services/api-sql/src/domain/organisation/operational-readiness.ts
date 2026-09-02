import type { IntegrationConnectionRecord } from '../../repositories/ports/integration.port.js';
import type { StaffUserRecord } from '../../repositories/ports/identity.port.js';
import type { OrganisationRecord, SetupTaskRecord } from '../../repositories/ports/organisation.port.js';
import { canAcceptPublicIntake, pharmacyWorkspaceMode } from './access.js';

const SETUP_TASK_IDS = [
  'pharmacy_profile',
  'curaleaf_account',
  'payment_route',
  'pricing',
  'notifications',
  'intake_call',
  'operational_readiness',
] as const;

export type SetupTaskId = typeof SETUP_TASK_IDS[number];

export interface PharmacyOperationalStatus {
  intake: { live: boolean; label: 'Live' | 'Off' };
  workspace: { mode: 'training' | 'live' | 'paused'; label: 'Training' | 'Live' | 'Paused' };
  staff: { activeCount: number; invitedCount: number; passed: boolean; label: string };
  curaleaf: { connected: boolean; production: boolean; label: 'Waiting' | 'Test' | 'Production' };
  payment: { route: 'manual' | 'worldpay'; worldpayConnected: boolean; passed: boolean; label: string };
  intakeCall: { completed: boolean; label: 'Not logged' | 'Logged'; evidence: string | null };
  walkthrough: { completed: boolean; label: 'Not started' | 'Complete'; evidence: string | null };
  charges: { saved: boolean; label: 'Saved' | 'Missing'; evidence: string | null };
  premises: { confirmed: boolean };
  websitePack: { published: boolean };
  goLiveReady: boolean;
  missingGates: string[];
}

export interface PharmacySetupTaskView {
  id: SetupTaskId;
  completed: boolean;
  completedAt: string | null;
  completedBy: string | null;
  evidence: string | null;
}

export interface PharmacySetupStatusView {
  organisationId: string;
  completed: boolean;
  completedCount: number;
  requiredCount: number;
  tasks: PharmacySetupTaskView[];
  updatedAt: string;
  operational: PharmacyOperationalStatus;
}

export interface GoLiveReadinessView {
  organisationId: string;
  companyId: string | null;
  testAccount: boolean;
  allocationHolding: boolean;
  intakeReady: boolean;
  ready: boolean;
  curaleafTestAcknowledgementRequired: boolean;
  status: 'onboarding' | 'intake_live' | 'live' | 'paused';
  gates: {
    gdprEvidence: {
      passed: boolean;
      exempt: boolean;
      evidenceUrl: string | null;
      method: 'document_link' | 'manual_receipt' | null;
      receivedAt: string | null;
    };
    curaleafLive: {
      passed: boolean;
      environment: 'test' | 'production';
      validatedAt: string | null;
      secretStored: boolean;
    };
  };
  operational: PharmacyOperationalStatus;
}

function taskByCode(records: SetupTaskRecord[]) {
  return new Map(records.map(record => [record.taskCode, record]));
}

function connectionActive(connection: IntegrationConnectionRecord | null | undefined): boolean {
  return Boolean(connection && connection.status === 'ACTIVE' && connection.secretResourceName);
}

function workspaceLabel(mode: PharmacyOperationalStatus['workspace']['mode']): PharmacyOperationalStatus['workspace']['label'] {
  if (mode === 'live') return 'Live';
  if (mode === 'paused') return 'Paused';
  return 'Training';
}

export function buildOperationalStatus(input: {
  organisation: OrganisationRecord;
  tasks: SetupTaskRecord[];
  staff: StaffUserRecord[];
  curaleaf: IntegrationConnectionRecord | null;
  worldpay: IntegrationConnectionRecord | null;
}): PharmacyOperationalStatus {
  const byCode = taskByCode(input.tasks);
  const premises = byCode.get('pharmacy_profile')?.completed === true;
  const intakeCall = byCode.get('intake_call')?.completed === true;
  const walkthrough = byCode.get('operational_readiness')?.completed === true;
  const charges = byCode.get('pricing')?.completed === true;
  const websitePack = byCode.get('notifications')?.completed === true;
  const route = input.organisation.defaultPaymentRoute === 'WORLDPAY' ? 'worldpay' : 'manual';
  const worldpayConnected = connectionActive(input.worldpay);
  const paymentPassed = route === 'manual' || worldpayConnected;
  const curaleafConnected = connectionActive(input.curaleaf);
  const curaleafProduction = curaleafConnected && input.curaleaf?.environment === 'PRODUCTION';
  const activeStaff = input.staff.filter(member => member.status === 'ACTIVE' && !member.disabled);
  const invitedStaff = input.staff.filter(member => member.status === 'INVITED');
  const activeCount = activeStaff.length;
  const invitedCount = invitedStaff.length;
  const staffPassed = activeCount >= 2;
  const intakeLive = canAcceptPublicIntake(input.organisation);
  const workspaceMode = pharmacyWorkspaceMode(input.organisation);
  const missingGates: string[] = [];
  if (workspaceMode === 'paused') missingGates.push('paused');
  if (input.organisation.classification === 'TRAINING') missingGates.push('training_tenant');
  if (!intakeCall) missingGates.push('intake_call');

  return {
    intake: { live: intakeLive, label: intakeLive ? 'Live' : 'Off' },
    workspace: { mode: workspaceMode, label: workspaceLabel(workspaceMode) },
    staff: {
      activeCount,
      invitedCount,
      passed: staffPassed,
      label: activeCount === 0 ? 'No active staff' : `${activeCount} active`,
    },
    curaleaf: {
      connected: curaleafConnected,
      production: curaleafProduction,
      label: curaleafProduction ? 'Production' : curaleafConnected ? 'Test' : 'Waiting',
    },
    payment: {
      route,
      worldpayConnected,
      passed: paymentPassed,
      label: route === 'worldpay'
        ? (worldpayConnected ? 'Worldpay connected' : 'Worldpay not connected')
        : 'Pharmacy-managed',
    },
    intakeCall: {
      completed: intakeCall,
      label: intakeCall ? 'Logged' : 'Not logged',
      evidence: byCode.get('intake_call')?.evidence ?? null,
    },
    walkthrough: {
      completed: walkthrough,
      label: walkthrough ? 'Complete' : 'Not started',
      evidence: byCode.get('operational_readiness')?.evidence ?? null,
    },
    charges: {
      saved: charges,
      label: charges ? 'Saved' : 'Missing',
      evidence: byCode.get('pricing')?.evidence ?? null,
    },
    premises: { confirmed: premises },
    websitePack: { published: websitePack },
    goLiveReady: missingGates.length === 0,
    missingGates,
  };
}

export function buildSetupStatusView(input: {
  organisation: OrganisationRecord;
  tasks: SetupTaskRecord[];
  staff: StaffUserRecord[];
  curaleaf: IntegrationConnectionRecord | null;
  worldpay: IntegrationConnectionRecord | null;
  legacyLiveFallback?: boolean;
}): PharmacySetupStatusView {
  const byCode = taskByCode(input.tasks);
  const operational = buildOperationalStatus(input);
  const curaleafTask = byCode.get('curaleaf_account');
  const tasks = SETUP_TASK_IDS.map(id => {
    const record = byCode.get(id);
    const derivedComplete = id === 'curaleaf_account' && operational.curaleaf.connected;
    const completed = record?.completed === true || derivedComplete || (input.legacyLiveFallback === true && !record);
    return {
      id,
      completed,
      completedAt: record?.completedAt ?? (derivedComplete ? input.curaleaf?.validatedAt ?? null : null),
      completedBy: record?.completedByUid ?? null,
      evidence: record?.evidence ?? (derivedComplete ? 'Connected by HHH' : null),
    };
  });
  const completedCount = tasks.filter(task => task.completed).length;
  const updatedAt = input.tasks
    .map(record => record.updatedAt)
    .filter(Boolean)
    .sort()
    .at(-1) ?? new Date().toISOString();

  return {
    organisationId: input.organisation.id,
    completed: completedCount === SETUP_TASK_IDS.length,
    completedCount,
    requiredCount: SETUP_TASK_IDS.length,
    tasks,
    updatedAt,
    operational,
  };
}

export function buildGoLiveReadinessView(input: {
  organisation: OrganisationRecord;
  operational: PharmacyOperationalStatus;
  curaleaf: IntegrationConnectionRecord | null;
}): GoLiveReadinessView {
  const testAccount = input.organisation.classification === 'TRAINING';
  const allocationHolding = input.organisation.classification === 'ALLOCATION_HOLDING';
  const secretStored = Boolean(input.curaleaf?.secretResourceName);
  const environment = input.curaleaf?.environment === 'TEST' ? 'test' as const : 'production' as const;
  const status = input.organisation.status === 'LIVE'
    ? 'live' as const
    : input.organisation.status === 'PAUSED'
      ? 'paused' as const
      : 'onboarding' as const;

  return {
    organisationId: input.organisation.id,
    companyId: input.organisation.companyId,
    testAccount,
    allocationHolding,
    intakeReady: canAcceptPublicIntake(input.organisation),
    ready: input.operational.goLiveReady,
    curaleafTestAcknowledgementRequired: !input.operational.curaleaf.production,
    status,
    gates: {
      gdprEvidence: {
        passed: true,
        exempt: testAccount,
        evidenceUrl: null,
        method: null,
        receivedAt: null,
      },
      curaleafLive: {
        passed: input.operational.curaleaf.production,
        environment,
        validatedAt: input.curaleaf?.validatedAt ?? null,
        secretStored,
      },
    },
    operational: input.operational,
  };
}

export function goLiveBlockedMessage(operational: PharmacyOperationalStatus): string {
  if (operational.missingGates.includes('training_tenant')) {
    return 'Training tenants cannot be flipped to a live pharmacy workspace.';
  }
  if (operational.missingGates.includes('paused')) {
    return 'Unpause this pharmacy before flipping the workspace to live.';
  }
  if (operational.missingGates.includes('intake_call')) {
    return 'Log the intake call before flipping this workspace live.';
  }
  return 'This pharmacy cannot be flipped to live yet.';
}

export const GO_LIVE_CURALEAF_TEST_ACK =
  'This pharmacy has been advised not to create or place orders until Curaleaf is switched from test to live under Manage → Curaleaf.';

export function goLiveRequiresCuraleafTestAcknowledgement(operational: PharmacyOperationalStatus): boolean {
  return !operational.curaleaf.production;
}
