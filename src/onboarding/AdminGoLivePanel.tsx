import { useEffect, useState } from 'react';
import { AlertTriangle } from 'lucide-react';
import type { PharmacyTenant } from '../context/AppContext';
import type { GoLiveReadiness } from '../shared/contracts';
import { getGoLiveReadiness, isApiConfigured, revertLiveOrganisation, updateAdminPharmacySetupTask } from '../shared/api';
import { isLocalPortalPreview } from '../dev/localPortalPreview';

interface AdminGoLivePanelProps {
  organisation: PharmacyTenant;
  goLiveError: string | null;
  goLiveBusy: boolean;
  onFlipLive: (options?: { acknowledgedCuraleafTest?: boolean }) => void;
  onReverted?: (status: PharmacyTenant['status']) => void;
}

const INTAKE_EVIDENCE = 'HHH logged the intake call.';
export const GO_LIVE_CURALEAF_TEST_ACK =
  'This pharmacy has been advised not to create or place orders until Curaleaf is switched from test to live under Integrations on Overview.';

export function AdminGoLivePanel({
  organisation,
  goLiveError,
  goLiveBusy,
  onFlipLive,
  onReverted,
}: AdminGoLivePanelProps) {
  const liveWorkspace = organisation.status === 'live';
  const paused = organisation.status === 'paused';
  const trainingTenant = organisation.workspaceClassification === 'training';
  const [readiness, setReadiness] = useState<GoLiveReadiness | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [loggingIntake, setLoggingIntake] = useState(false);
  const [reverting, setReverting] = useState(false);
  const [acknowledgedCuraleafTest, setAcknowledgedCuraleafTest] = useState(false);

  const refresh = async () => {
    if (isLocalPortalPreview || !isApiConfigured) return;
    setLoadError(null);
    try {
      setReadiness(await getGoLiveReadiness(organisation.id));
    } catch (error) {
      setLoadError(error instanceof Error ? error.message : 'Go-live status could not be loaded.');
    }
  };

  useEffect(() => {
    void refresh();
  }, [organisation.id]);

  const operational = readiness?.operational;
  const intakeLogged = operational?.intakeCall.completed === true;
  const curaleafProduction = operational?.curaleaf.production === true;
  const curaleafLabel = operational?.curaleaf.label ?? 'Waiting';
  const serverReady = readiness?.ready === true;
  const needsCuraleafAck = !liveWorkspace && !curaleafProduction;
  const canFlip = !liveWorkspace && !paused && !trainingTenant && (isLocalPortalPreview || serverReady) && (!needsCuraleafAck || acknowledgedCuraleafTest);

  useEffect(() => {
    setAcknowledgedCuraleafTest(false);
  }, [organisation.id, needsCuraleafAck]);

  const logIntakeCall = async () => {
    if (isLocalPortalPreview) return;
    setLoggingIntake(true);
    setLoadError(null);
    try {
      await updateAdminPharmacySetupTask(organisation.id, 'intake_call', { completed: true, evidence: INTAKE_EVIDENCE });
      await refresh();
    } catch (error) {
      setLoadError(error instanceof Error ? error.message : 'The intake call could not be logged.');
    } finally {
      setLoggingIntake(false);
    }
  };

  const revertLive = async () => {
    if (isLocalPortalPreview) {
      onReverted?.('onboarding');
      return;
    }
    setReverting(true);
    setLoadError(null);
    try {
      const next = await revertLiveOrganisation(organisation.id);
      onReverted?.(next.status);
      setReadiness(next);
    } catch (error) {
      setLoadError(error instanceof Error ? error.message : 'The workspace could not be returned to training.');
    } finally {
      setReverting(false);
    }
  };

  const facts = [
    { id: 'intake_call', title: 'Intake call', value: intakeLogged ? 'Logged' : 'Not logged', passed: intakeLogged },
    { id: 'curaleaf', title: 'Curaleaf', value: curaleafLabel, passed: curaleafProduction },
  ];

  return (
    <section className="card admin-golive-panel">
      <div className="admin-golive-panel__head">
        <div>
          <p className="section-label">Go live</p>
          <h2>Pharmacy workspace</h2>
          <p>Log the intake call, then flip the workspace live. If Curaleaf is still on test, confirm that the pharmacy has been told not to create or place orders until it is switched to live. Intake stays on independently. Worldpay stays optional until they connect a merchant in Settings.</p>
        </div>
        {liveWorkspace ? (
          <button type="button" className="btn btn-secondary btn-sm" disabled={goLiveBusy || reverting} onClick={() => void revertLive()}>
            {reverting ? 'Reverting…' : 'Return to training'}
          </button>
        ) : (
          <button
            type="button"
            className="btn btn-primary btn-sm"
            disabled={goLiveBusy || !canFlip}
            onClick={() => onFlipLive({ acknowledgedCuraleafTest: needsCuraleafAck })}
          >
            {goLiveBusy ? 'Flipping…' : 'Flip workspace to live'}
          </button>
        )}
      </div>

      {goLiveError || loadError ? <div className="banner banner-red" role="alert">{goLiveError || loadError}</div> : null}

      {needsCuraleafAck ? (
        <label className="admin-golive-ack">
          <AlertTriangle size={16} aria-hidden="true" />
          <input
            type="checkbox"
            checked={acknowledgedCuraleafTest}
            onChange={event => setAcknowledgedCuraleafTest(event.target.checked)}
          />
          <span>{GO_LIVE_CURALEAF_TEST_ACK}</span>
        </label>
      ) : null}

      <ul className="admin-golive-facts" aria-label={`Go-live status for ${organisation.tradingName}`}>
        {facts.map(row => (
          <li key={row.id}>
            <span>{row.title}</span>
            <span className={`pill ${row.passed ? 'pill-green' : 'pill-amber'}`}>{row.value}</span>
          </li>
        ))}
      </ul>

      {!liveWorkspace ? (
        <ul className="admin-golive-actions">
          <li>
            <div>
              <strong>Intake call</strong>
              <span>Log that HHH completed the intake call with this pharmacy.</span>
            </div>
            {intakeLogged ? (
              <span className="pill pill-green">Logged</span>
            ) : (
              <button
                type="button"
                className="btn btn-secondary btn-sm"
                disabled={loggingIntake || isLocalPortalPreview}
                onClick={() => void logIntakeCall()}
              >
                {loggingIntake ? 'Logging…' : 'Log intake call'}
              </button>
            )}
          </li>
          <li>
            <div>
              <strong>Curaleaf</strong>
              <span>Switch it from test to live under Integrations on Overview before they create or place orders. A test connection does not block go-live.</span>
            </div>
            <span className={`pill ${curaleafProduction ? 'pill-green' : 'pill-amber'}`}>{curaleafLabel}</span>
          </li>
        </ul>
      ) : null}

      {paused ? (
        <p className="admin-golive-panel__hint">Unpause this pharmacy before flipping the workspace to live.</p>
      ) : null}
      {trainingTenant && !liveWorkspace ? (
        <p className="admin-golive-panel__hint">Training tenants stay in the training workspace.</p>
      ) : null}
    </section>
  );
}
