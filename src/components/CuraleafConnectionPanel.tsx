import { useCallback, useEffect, useState } from 'react';
import { AlertTriangle, CheckCircle2, Eye, EyeOff, KeyRound, RefreshCw, ShieldCheck } from 'lucide-react';
import { activateCuraleafPharmacy, getCuraleafConnectionStatus, refreshCuraleafConnection } from '../shared/api';
import type { CuraleafConnectionStatus } from '../shared/contracts';
import { isLocalPortalPreview } from '../dev/localPortalPreview';
import { useApp } from '../context/AppContext';

const EMPTY_FORM = { customerId: '', apiKey: '' };

function previewStatus(organisationId: string, customerId?: string, environment: 'test' | 'production' = 'test'): CuraleafConnectionStatus {
  return {
    configured: true,
    connected: true,
    writeConfigured: true,
    approved: true,
    status: 'connected',
    environment,
    checkedAt: new Date().toISOString(),
    message: environment === 'production'
      ? 'Local preview live connection. The API key is not stored.'
      : 'Local preview test connection. The API key is not stored.',
    activated: true,
    customerId: customerId || `preview-${organisationId.slice(0, 8)}`,
    maskedIdentifier: '••••preview',
  };
}

function environmentLabel(environment: CuraleafConnectionStatus['environment'] | undefined) {
  return environment === 'production' ? 'Live' : 'Test';
}

export default function CuraleafConnectionPanel({
  organisationId,
  customerIdHint,
}: {
  organisationId: string;
  customerIdHint?: string | null;
}) {
  const { dispatch } = useApp();
  const [status, setStatus] = useState<CuraleafConnectionStatus | null>(null);
  const [form, setForm] = useState(EMPTY_FORM);
  const [showSecrets, setShowSecrets] = useState(false);
  const [rotating, setRotating] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const applyStatus = useCallback((result: CuraleafConnectionStatus) => {
    setStatus(result);
    setRotating(false);
    setForm(current => ({
      ...EMPTY_FORM,
      customerId: result.customerId || current.customerId || '',
    }));
    setShowSecrets(false);
  }, []);

  const loadStatus = useCallback(async () => {
    setBusy(true);
    setError(null);
    try {
      applyStatus(isLocalPortalPreview
        ? previewStatus(organisationId, customerIdHint ?? undefined)
        : await getCuraleafConnectionStatus(organisationId));
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : 'The Curaleaf connection status could not be loaded.');
    } finally {
      setBusy(false);
    }
  }, [applyStatus, customerIdHint, organisationId]);

  useEffect(() => {
    void loadStatus();
  }, [loadStatus]);

  const onTest = status?.environment !== 'production';
  const connected = status?.connected === true;
  const replacingTestWithLive = rotating && connected && onTest;
  const rotatingLive = rotating && connected && !onTest;
  const firstConnect = status !== null && !connected;
  const showKeyForm = status !== null && (firstConnect || rotating || status.status === 'not_configured' || status.status === 'credential_update_required');
  const pinLiveEstate = replacingTestWithLive || rotatingLive;
  const canSave = form.customerId.trim().length > 0 && form.apiKey.trim().length >= 16;

  const refresh = async () => {
    setBusy(true);
    setError(null);
    try {
      applyStatus(isLocalPortalPreview
        ? previewStatus(organisationId, form.customerId || customerIdHint || undefined, status?.environment)
        : await refreshCuraleafConnection(organisationId));
      dispatch({ type: 'ADD_TOAST', message: 'Curaleaf connection checked.', toastType: 'success' });
    } catch (refreshError) {
      setError(refreshError instanceof Error ? refreshError.message : 'The Curaleaf connection could not be refreshed.');
    } finally {
      setBusy(false);
    }
  };

  const saveKeys = async () => {
    if (!form.customerId.trim() || form.apiKey.trim().length < 16) return;
    setBusy(true);
    setError(null);
    try {
      applyStatus(isLocalPortalPreview
        ? previewStatus(
          organisationId,
          form.customerId.trim(),
          pinLiveEstate ? 'production' : 'test',
        )
        : await activateCuraleafPharmacy({
          organisationId,
          customerId: form.customerId.trim(),
          writeApiKey: form.apiKey.trim(),
          ...(pinLiveEstate ? { environment: 'PRODUCTION' as const } : {}),
        }));
      dispatch({
        type: 'ADD_TOAST',
        message: replacingTestWithLive
          ? 'Curaleaf live credentials verified.'
          : rotating
            ? 'Curaleaf API key rotated and verified.'
            : 'Curaleaf connection saved and verified.',
        toastType: 'success',
      });
    } catch (saveError) {
      setError(saveError instanceof Error ? saveError.message : 'Curaleaf could not verify this API key.');
    } finally {
      setBusy(false);
    }
  };

  const toggleCredentialForm = () => {
    setRotating(value => !value);
    setError(null);
    if (!rotating && status) {
      setForm(current => ({
        ...EMPTY_FORM,
        customerId: current.customerId || status.customerId || customerIdHint || '',
      }));
    }
  };

  const heading = connected
    ? (onTest ? 'Curaleaf connected on test' : 'Curaleaf connected on live')
    : status?.configured
      ? 'Curaleaf needs a key update'
      : 'Enter this pharmacy’s Curaleaf credentials';

  const hint = firstConnect
    ? 'Paste the customer ID and API key Curaleaf issued for this pharmacy. Test keys are fine while they are still onboarding.'
    : replacingTestWithLive
      ? 'Paste the live customer ID and API key. This replaces the test connection. Curaleaf will reject a test key here.'
      : rotatingLive
        ? 'Paste the new live API key. The previous key stops working as soon as this verifies.'
        : 'The API key is verified with Curaleaf and stored server-side. It is never shown again after saving.';

  return (
    <section className="admin-curaleaf-connect" aria-label="Curaleaf connection">
      <header>
        <span className="admin-curaleaf-connect__icon"><KeyRound size={17} /></span>
        <span>
          <strong>{heading}</strong>
          <small>{hint}</small>
        </span>
        {connected && onTest && !rotating ? (
          <button type="button" className="btn btn-primary btn-sm" disabled={busy} onClick={toggleCredentialForm}>
            Replace with live credentials
          </button>
        ) : rotating ? (
          <button type="button" className="btn btn-sm" disabled={busy} onClick={toggleCredentialForm}>
            Cancel
          </button>
        ) : connected ? (
          <span className="pill pill-green"><CheckCircle2 size={11} /> Live</span>
        ) : null}
      </header>

      {connected && onTest && !rotating ? (
        <p className="admin-curaleaf-connect__warn">
          <AlertTriangle size={16} aria-hidden="true" />
          <span>This pharmacy is still on test. Replace these credentials with live ones before they create or place orders.</span>
        </p>
      ) : null}

      {status ? (
        <div className="settings-meta-grid">
          <div><span>Connection</span><strong>{status.connected ? 'Connected' : status.status?.replaceAll('_', ' ') ?? 'Not configured'}</strong></div>
          <div><span>Environment</span><strong>{environmentLabel(status.environment)}</strong></div>
          <div><span>Customer ID</span><strong>{status.customerId ?? 'Not recorded'}</strong></div>
          {/* Null means the credential has never succeeded against Curaleaf — say that
              rather than printing today's date as if it had just been confirmed. */}
          <div><span>Last confirmed</span><strong>{status.checkedAt ? new Date(status.checkedAt).toLocaleString('en-GB') : 'Never confirmed'}</strong></div>
        </div>
      ) : (
        <div className="empty-state">{busy ? 'Loading the connection status…' : 'Connection status unavailable.'}</div>
      )}

      {status?.maskedIdentifier ? (
        <div className="admin-curaleaf-connect__masked"><ShieldCheck size={14} /> Stored identifier {status.maskedIdentifier}</div>
      ) : null}

      {status?.message ? <p className="admin-curaleaf-connect__hint">{status.message}</p> : null}

      {showKeyForm ? (
        <div className="admin-curaleaf-connect__fields">
          <label>
            <span>{replacingTestWithLive ? 'Live customer ID' : 'Curaleaf customer ID'}</span>
            <input
              className="input"
              autoComplete="off"
              value={form.customerId}
              onChange={event => setForm(current => ({ ...current, customerId: event.target.value }))}
            />
          </label>
          <label className="admin-curaleaf-connect__wide">
            <span>{replacingTestWithLive ? 'Live API key' : 'API key'}</span>
            <input
              className="input"
              type={showSecrets ? 'text' : 'password'}
              autoComplete="new-password"
              value={form.apiKey}
              onChange={event => setForm(current => ({ ...current, apiKey: event.target.value }))}
            />
          </label>
          <button type="button" className="btn btn-sm admin-curaleaf-connect__reveal" onClick={() => setShowSecrets(value => !value)}>
            {showSecrets ? <EyeOff size={13} /> : <Eye size={13} />}
            {showSecrets ? 'Hide key' : 'Show while entering'}
          </button>
          <button type="button" className="btn btn-primary" disabled={busy || !canSave} onClick={() => void saveKeys()}>
            {busy ? <RefreshCw size={14} className="spin" /> : <ShieldCheck size={14} />}
            {busy
              ? 'Verifying with Curaleaf…'
              : replacingTestWithLive
                ? 'Verify live credentials'
                : rotating
                  ? 'Rotate and verify key'
                  : 'Save and verify credentials'}
          </button>
        </div>
      ) : null}

      <div className="admin-curaleaf-connect__actions">
        {connected && !onTest && !rotating ? (
          <button type="button" className="btn btn-sm" disabled={busy} onClick={toggleCredentialForm}>
            <RefreshCw size={13} /> Rotate live key
          </button>
        ) : null}
        <button type="button" className="btn btn-sm" disabled={busy || !status} onClick={() => void refresh()}>
          <RefreshCw size={13} className={busy ? 'spin' : ''} /> Refresh connection
        </button>
      </div>

      {error ? <p className="admin-curaleaf-connect__error" role="alert">{error}</p> : null}
    </section>
  );
}
