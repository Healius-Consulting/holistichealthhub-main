import { useCallback, useEffect, useState } from 'react';
import { CheckCircle2, Eye, EyeOff, KeyRound, RefreshCw, ShieldCheck } from 'lucide-react';
import { activateCuraleafPharmacy, getCuraleafConnectionStatus, refreshCuraleafConnection } from '../shared/api';
import type { CuraleafConnectionStatus } from '../shared/contracts';
import { isLocalPortalPreview } from '../dev/localPortalPreview';
import { useApp } from '../context/AppContext';

const EMPTY_FORM = { customerId: '', apiKey: '' };

function previewStatus(organisationId: string, customerId?: string): CuraleafConnectionStatus {
  return {
    configured: true,
    connected: true,
    writeConfigured: true,
    approved: true,
    status: 'connected',
    environment: 'test',
    checkedAt: new Date().toISOString(),
    message: 'Local preview connection. The API key is not stored.',
    activated: true,
    customerId: customerId || `preview-${organisationId.slice(0, 8)}`,
    maskedIdentifier: '••••preview',
  };
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

  const refresh = async () => {
    setBusy(true);
    setError(null);
    try {
      applyStatus(isLocalPortalPreview
        ? previewStatus(organisationId, form.customerId || customerIdHint || undefined)
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
        ? previewStatus(organisationId, form.customerId.trim())
        : await activateCuraleafPharmacy({
          organisationId,
          customerId: form.customerId.trim(),
          writeApiKey: form.apiKey.trim(),
        }));
      dispatch({ type: 'ADD_TOAST', message: rotating ? 'Curaleaf API key rotated and verified.' : 'Curaleaf connection saved and verified.', toastType: 'success' });
    } catch (saveError) {
      setError(saveError instanceof Error ? saveError.message : 'Curaleaf could not verify this API key.');
    } finally {
      setBusy(false);
    }
  };

  const showKeyForm = status !== null && (!status.connected || rotating || status.status === 'not_configured' || status.status === 'credential_update_required');
  const canSave = form.customerId.trim().length > 0 && form.apiKey.trim().length >= 16;

  return (
    <section className="admin-curaleaf-connect" aria-label="Curaleaf connection">
      <header>
        <span className="admin-curaleaf-connect__icon"><KeyRound size={17} /></span>
        <span>
          <strong>
            {status?.connected
              ? 'Curaleaf connected'
              : status?.configured
                ? 'Curaleaf needs a key update'
                : 'Connect this pharmacy’s Curaleaf account'}
          </strong>
          <small>The API key is verified with Curaleaf and stored server-side. It is never shown again after saving.</small>
        </span>
        {status?.connected ? <span className="pill pill-green"><CheckCircle2 size={11} /> Connected</span> : null}
      </header>

      {status ? (
        <div className="settings-meta-grid">
          <div><span>Connection</span><strong>{status.connected ? 'Connected' : status.status?.replaceAll('_', ' ') ?? 'Not configured'}</strong></div>
          <div><span>Environment</span><strong>{status.environment}</strong></div>
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
            <span>Curaleaf customer ID</span>
            <input
              className="input"
              autoComplete="off"
              value={form.customerId}
              onChange={event => setForm(current => ({ ...current, customerId: event.target.value }))}
            />
          </label>
          <label className="admin-curaleaf-connect__wide">
            <span>API key</span>
            <input
              className="input"
              type={showSecrets ? 'text' : 'password'}
              autoComplete="new-password"
              value={form.apiKey}
              onChange={event => setForm(current => ({ ...current, apiKey: event.target.value }))}
            />
          </label>
          <p className="admin-curaleaf-connect__hint admin-curaleaf-connect__wide">
            Paste the Curaleaf API key issued for this pharmacy. One key is used for every Curaleaf request.
          </p>
          <button type="button" className="btn btn-sm admin-curaleaf-connect__reveal" onClick={() => setShowSecrets(value => !value)}>
            {showSecrets ? <EyeOff size={13} /> : <Eye size={13} />}
            {showSecrets ? 'Hide key' : 'Show while entering'}
          </button>
          <button type="button" className="btn btn-primary" disabled={busy || !canSave} onClick={() => void saveKeys()}>
            {busy ? <RefreshCw size={14} className="spin" /> : <ShieldCheck size={14} />}
            {busy ? 'Verifying with Curaleaf…' : rotating ? 'Rotate and verify key' : 'Save and verify connection'}
          </button>
        </div>
      ) : null}

      <div className="admin-curaleaf-connect__actions">
        {status?.connected ? (
          <button
            type="button"
            className="btn btn-sm"
            disabled={busy}
            onClick={() => {
              setRotating(value => !value);
              setError(null);
              if (!rotating) {
                setForm(current => ({
                  ...EMPTY_FORM,
                  customerId: current.customerId || status.customerId || customerIdHint || '',
                }));
              }
            }}
          >
            <RefreshCw size={13} /> {rotating ? 'Cancel rotate' : 'Rotate key'}
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
