import { applyWorldpayRetention } from './application/worldpay-application/applications.js';
import { sqlWorldpayDeps } from './application/worldpay-application/sql-deps.js';
import { onRequest } from 'firebase-functions/v2/https';
import { onSchedule } from 'firebase-functions/v2/scheduler';
import {
  accrueAnnualPatientFees,
  updatePatientRetentionStates,
} from './application/patient-finance/patient-finance.js';
import { refreshAllCuraleafQuoteBanks } from './application/integrations/curaleaf-quote-bank.service.js';
import { reconcilePendingWorldpayPayments } from './application/payments/worldpay-reconciliation.js';
import { applyRetention } from './application/retention/apply-retention.js';
import { runEvery } from './application/workers/cadence.js';
import { cleanupAbandonedPrescriptionFiles } from './application/workers/cleanup-files.js';
import { sqlWorkerDeps } from './application/workers/deps.js';
import { deliverPatientMessages } from './application/workers/deliver-messages.js';
import { maintainPaidOrderFlow } from './application/workers/maintain-orders.js';
import { processPendingPaymentLifecycle } from './application/workers/payment-lifecycle.js';
import { pollCuraleafEvents } from './application/workers/poll-curaleaf.js';
import { createApp } from './bootstrap/app.js';
import { clickupConfig } from './application/clickup/clickup-config.js';
import { readClickupToken } from './application/clickup/clickup-token.js';
import { pruneStaleOnboardingVisits, syncClickup } from './application/clickup/sync-clickup.js';
import { SqlClickupRepository, SqlPharmacyOnboardingVisitRepository } from './repositories/sql/clickup.sql.js';
import { SqlPharmacyOnboardingRepository } from './repositories/sql/pharmacy-onboarding.sql.js';
import { SqlCuraleafQuoteBankRepository } from './repositories/sql/curaleaf-quote-bank.sql.js';
import { SqlIdentityRepository } from './repositories/sql/identity.sql.js';
import { SqlIntegrationRepository } from './repositories/sql/integration.sql.js';
import { SqlIntakeRepository } from './repositories/sql/intake.sql.js';
import { SqlPatientFinanceRepository } from './repositories/sql/patient-finance.sql.js';
import { SqlPatientRepository } from './repositories/sql/patient.sql.js';

const app = createApp();
const WORLDPAY_SWEEP_MS = 10_000;
const eventPollingEnabled = process.env.CURALEAF_EVENT_POLLING_ENABLED !== 'false';

function patientFinanceDeps() {
  return {
    patientRepo: new SqlPatientRepository(),
    patientFinanceRepo: new SqlPatientFinanceRepository(),
  };
}

export const apiLondon = onRequest({
  region: 'europe-west2',
  timeoutSeconds: 60,
  memory: '256MiB',
  minInstances: 1,
  maxInstances: 10,
}, app);

export const accrueAnnualPatientFeesLondon = onSchedule({
  schedule: '0 2 * * *',
  timeZone: 'Europe/London',
  region: 'europe-west2',
  timeoutSeconds: 120,
  memory: '256MiB',
  maxInstances: 1,
  retryCount: 1,
}, async () => {
  const summary = await accrueAnnualPatientFees(patientFinanceDeps());
  console.log('Annual patient fee accrual complete', summary);
});

export const updatePatientRetentionLondon = onSchedule({
  schedule: '15 2 * * *',
  timeZone: 'Europe/London',
  region: 'europe-west2',
  timeoutSeconds: 120,
  memory: '256MiB',
  maxInstances: 1,
  retryCount: 1,
}, async () => {
  console.log('Patient retention update complete', await updatePatientRetentionStates(patientFinanceDeps()));
});

/**
 * Enforces the retention table published at /privacy section 6 — not to be confused
 * with updatePatientRetentionLondon above, which marks patients inactive from their
 * dispense cadence and is a CRM lifecycle job, not erasure.
 *
 * Runs after the other nightly jobs so a record is not deleted from under one of them
 * mid-run. Failures are reported per record and the run continues, so a single stuck
 * row cannot quietly suspend deletion for everyone.
 */
export const applyDataRetentionLondon = onSchedule({
  schedule: '45 3 * * *',
  timeZone: 'Europe/London',
  region: 'europe-west2',
  timeoutSeconds: 540,
  memory: '512MiB',
  maxInstances: 1,
  retryCount: 1,
}, async () => {
  const run = await applyRetention({
    intakeRepo: new SqlIntakeRepository(),
    identityRepo: new SqlIdentityRepository(),
  });
  console.log('Data retention run complete', {
    examined: run.examined,
    reduced: run.reduced.length,
    deleted: run.deleted.length,
    failed: run.failed.length,
  });
  // Surface stuck records loudly: a retention promise that silently stops being kept
  // is the failure mode that matters, and nothing else in the run reports it.
  for (const failure of run.failed) {
    console.error('Data retention failed for a record', { id: failure.id, reason: failure.reason });
  }
  // 2.11: "visited, not submitted" records go after 12 months with no submission.
  try {
    const onboardingRepo = new SqlPharmacyOnboardingRepository();
    console.log('Onboarding visit pruning complete', await pruneStaleOnboardingVisits({
      visitRepo: new SqlPharmacyOnboardingVisitRepository(),
      findLatestRequest: gphcNumber => onboardingRepo.findLatestByGphc(gphcNumber),
    }));
  } catch (error) {
    console.error('Onboarding visit pruning failed', error instanceof Error ? error.message : 'unknown');
  }
  // Worldpay applications: principals, bank details and files go 30 days after closing; stale drafts after 90.
  try {
    console.log('Worldpay application retention complete', await applyWorldpayRetention(sqlWorldpayDeps()));
  } catch (error) {
    console.error('Worldpay application retention failed', error instanceof Error ? error.message : 'unknown');
  }
});

export const refreshCuraleafQuoteBankLondon = onSchedule({
  schedule: '0 3 * * *',
  timeZone: 'Europe/London',
  region: 'europe-west2',
  timeoutSeconds: 540,
  memory: '512MiB',
  maxInstances: 1,
  retryCount: 1,
}, async () => {
  const integrationRepo = new SqlIntegrationRepository();
  const quoteBankRepo = new SqlCuraleafQuoteBankRepository();
  const connections = await integrationRepo.listConnections();
  const summary = await refreshAllCuraleafQuoteBanks(connections, quoteBankRepo);
  console.log('Curaleaf quote bank refresh complete', { summary });
});

/**
 * Cloud Scheduler cannot run faster than once a minute. This job ticks the
 * Worldpay Payment Queries sweep every 10 seconds inside that minute.
 */
export const reconcileWorldpayPaymentsLondon = onSchedule({
  schedule: 'every 1 minutes',
  timeZone: 'Europe/London',
  region: 'europe-west2',
  timeoutSeconds: 55,
  memory: '256MiB',
  maxInstances: 1,
  retryCount: 0,
}, async () => {
  const deps = sqlWorkerDeps();
  await runEvery(WORLDPAY_SWEEP_MS, 50_000, async () => {
    const reconciliation = await reconcilePendingWorldpayPayments(deps);
    console.log('Worldpay reconciliation tick', { reconciliation });
  });
});

export const processPaymentLifecycleLondon = onSchedule({
  schedule: 'every 15 minutes',
  timeZone: 'Europe/London',
  region: 'europe-west2',
  timeoutSeconds: 180,
  memory: '256MiB',
  maxInstances: 1,
  retryCount: 0,
}, async () => {
  console.log('Payment lifecycle complete', await processPendingPaymentLifecycle(sqlWorkerDeps()));
});

export const maintainOrderFlowLondon = onSchedule({
  schedule: 'every 15 minutes',
  timeZone: 'Europe/London',
  region: 'europe-west2',
  timeoutSeconds: 300,
  memory: '256MiB',
  maxInstances: 1,
  retryCount: 0,
}, async () => {
  console.log('Paid order maintenance complete', await maintainPaidOrderFlow(sqlWorkerDeps()));
});

export const deliverPatientMessagesLondon = onSchedule({
  schedule: 'every 1 minutes',
  timeZone: 'Europe/London',
  region: 'europe-west2',
  timeoutSeconds: 120,
  memory: '256MiB',
  maxInstances: 1,
  retryCount: 0,
}, async () => {
  console.log('Patient message delivery complete', await deliverPatientMessages(sqlWorkerDeps()));
});

export const pollCuraleafEventsLondon = onSchedule({
  schedule: 'every 1 minutes',
  timeZone: 'Europe/London',
  region: 'europe-west2',
  timeoutSeconds: 180,
  memory: '256MiB',
  maxInstances: 1,
  retryCount: 0,
}, async () => {
  if (!eventPollingEnabled) return;
  const deps = sqlWorkerDeps();
  const connections = (await deps.integrationRepo.listConnections())
    .filter(connection => connection.integration === 'CURALEAF' && connection.status === 'ACTIVE');
  for (const connection of connections) {
    try {
      const result = await pollCuraleafEvents(connection, deps);
      console.log('Curaleaf event poll complete', result);
    } catch (error) {
      console.error('Curaleaf event poll failed', {
        organisationId: connection.organisationId,
        error: error instanceof Error ? error.message : 'Unknown error',
      });
    }
  }
});

export const cleanupPrescriptionFilesLondon = onSchedule({
  schedule: '30 3 * * *',
  timeZone: 'Europe/London',
  region: 'europe-west2',
  timeoutSeconds: 300,
  memory: '256MiB',
  maxInstances: 1,
  retryCount: 1,
}, async () => {
  const summary = await cleanupAbandonedPrescriptionFiles(sqlWorkerDeps());
  console.log('Prescription file cleanup complete', summary);
});

/**
 * Step 6 (ClickUp, Option A): tells HHH's ClickUp board about partner onboarding,
 * one card per pharmacy, from the ClickUp outbox. One-way; a ClickUp outage only
 * delays it. Until CLICKUP_LIST_ID and the CLICKUP connection's token are set, the
 * events stay queued.
 */
export const syncClickupLondon = onSchedule({
  schedule: 'every 5 minutes',
  timeZone: 'Europe/London',
  region: 'europe-west2',
  timeoutSeconds: 120,
  memory: '256MiB',
  maxInstances: 1,
  retryCount: 0,
}, async () => {
  const integrationRepo = new SqlIntegrationRepository();
  console.log('ClickUp sync complete', await syncClickup({
    clickupRepo: new SqlClickupRepository(),
    config: () => clickupConfig(),
    token: () => readClickupToken(() => integrationRepo.listConnections()),
  }));
});
