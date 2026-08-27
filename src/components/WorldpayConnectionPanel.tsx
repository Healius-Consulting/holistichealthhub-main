import { useCallback, useEffect, useRef, useState } from 'react';
import { CheckCircle2, Eye, EyeOff, KeyRound, RefreshCw, ShieldCheck, Unplug } from 'lucide-react';
import {
  connectWorldpayPharmacy,
  getWorldpayConnectionStatus,
  removeWorldpayConnection,
} from '../shared/api';
import type { WorldpayConnectionStatus } from '../shared/contracts';
import './WorldpayConnectionPanel.css';

const EMPTY_FORM = { username: '', password: '', entityId: '' };

export default function WorldpayConnectionPanel({
  organisationId,
  onConnected,
  onNotify,
}: {
  organisationId: string;
  onConnected: (status: WorldpayConnectionStatus) => void;
  /** Reports the outcome of a person-initiated refresh; automatic loads stay silent. */
  onNotify?: (message: string, tone: 'success' | 'warning' | 'error') => void;
}) {
  const [status, setStatus] = useState<WorldpayConnectionStatus | null>(null);
  const [form, setForm] = useState(EMPTY_FORM);
  const [showSecrets, setShowSecrets] = useState(false);
  const [rotating, setRotating] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const onConnectedRef = useRef(onConnected);

  useEffect(() => { onConnectedRef.current = onConnected; }, [onConnected]);

  const applyStatus = useCallback((result: WorldpayConnectionStatus) => {
    setStatus(result);
    setRotating(false);
    setForm(EMPTY_FORM);
    onConnectedRef.current(result);
  }, []);

  const onNotifyRef = useRef(onNotify);
  useEffect(() => { onNotifyRef.current = onNotify; }, [onNotify]);

  const refresh = useCallback(async (announce = false) => {
    setBusy(true);
    setError(null);
    try {
      const result = await getWorldpayConnectionStatus(organisationId);
      applyStatus(result);
      // Only a person who pressed Refresh gets told; the load on mount would
      // otherwise fire a toast every time Settings is opened.
      if (announce) {
        onNotifyRef.current?.(
          result.connected
            ? 'Worldpay merchant connection re-checked and still verified.'
            : result.configured
              ? 'Worldpay answered but the merchant connection still needs verifying.'
              : 'Worldpay is not connected for this pharmacy yet.',
          result.connected ? 'success' : 'warning',
        );
      }
    } catch (refreshError) {
      const message = refreshError instanceof Error ? refreshError.message : 'Worldpay connection status could not be loaded.';
      setError(message);
      if (announce) onNotifyRef.current?.(message, 'error');
    } finally {
      setBusy(false);
    }
  }, [applyStatus, organisationId]);

  useEffect(() => { void refresh(); }, [refresh]);

  const connect = async () => {
    if (!form.username.trim() || !form.password || !form.entityId.trim()) return;
    setBusy(true);
    setError(null);
    try {
      applyStatus(await connectWorldpayPharmacy({
        organisationId,
        username: form.username.trim(),
        password: form.password,
        entityId: form.entityId.trim(),
      }));
    } catch (connectError) {
      setError(connectError instanceof Error ? connectError.message : 'Worldpay could not verify these merchant details.');
    } finally {
      setBusy(false);
    }
  };

  const removeConnection = async () => {
    const confirmed = window.confirm('Remove this pharmacy’s Worldpay connection? New orders will not be able to use Worldpay until it is connected again.');
    if (!confirmed) return;
    setBusy(true);
    setError(null);
    try {
      applyStatus(await removeWorldpayConnection(organisationId));
    } catch (removeError) {
      setError(removeError instanceof Error ? removeError.message : 'The Worldpay connection could not be removed.');
    } finally {
      setBusy(false);
    }
  };

  const showCredentialForm = !status?.connected || rotating;

  return (
    <section className="worldpay-connect-panel">
      <header>
        <span className="worldpay-connect-panel__icon"><KeyRound size={17} /></span>
        <span>
          <strong>{status?.connected ? 'Worldpay merchant connected' : status?.configured ? 'Worldpay verification required' : 'Connect this pharmacy’s merchant account'}</strong>
          <small>Your Worldpay details are verified securely and are never displayed again after saving.</small>
        </span>
        {status?.connected ? <span className="pill pill-green"><CheckCircle2 size={11} /> Connected</span> : null}
      </header>

      {status?.maskedIdentifier ? <div className="worldpay-connect-panel__masked"><ShieldCheck size={14} /> Merchant entity {status.maskedIdentifier}</div> : null}

      {showCredentialForm && (
        <div className="worldpay-connect-panel__fields">
          <label><span>Worldpay username</span><input className="input" autoComplete="off" value={form.username} onChange={event => setForm(current => ({ ...current, username: event.target.value }))} /></label>
          <label><span>Worldpay password</span><input className="input" type={showSecrets ? 'text' : 'password'} autoComplete="new-password" value={form.password} onChange={event => setForm(current => ({ ...current, password: event.target.value }))} /></label>
          <label><span>Merchant entity ID</span><input className="input" autoComplete="off" placeholder="PO…" value={form.entityId} onChange={event => setForm(current => ({ ...current, entityId: event.target.value }))} /></label>
          <button type="button" className="btn btn-sm worldpay-connect-panel__reveal" onClick={() => setShowSecrets(value => !value)}>{showSecrets ? <EyeOff size={13} /> : <Eye size={13} />}{showSecrets ? 'Hide secrets' : 'Show while entering'}</button>
          <button type="button" className="btn btn-primary" disabled={busy || !form.username.trim() || !form.password || !form.entityId.trim()} onClick={() => void connect()}>{busy ? <RefreshCw size={14} className="spin" /> : <ShieldCheck size={14} />}{busy ? 'Verifying with Worldpay…' : rotating ? 'Rotate and verify connection' : 'Save and verify connection'}</button>
        </div>
      )}

      {status?.connected ? (
        <div className="worldpay-connect-panel__actions">
          <button type="button" className="btn btn-sm" disabled={busy} onClick={() => { setRotating(value => !value); setError(null); }}>
            <RefreshCw size={13} /> {rotating ? 'Cancel rotate' : 'Rotate credentials'}
          </button>
          <button type="button" className="btn btn-sm btn-danger" disabled={busy} onClick={() => void removeConnection()}>
            <Unplug size={13} /> Remove connection
          </button>
          <button type="button" className="btn btn-sm" disabled={busy} onClick={() => void refresh(true)}>
            <RefreshCw size={13} className={busy ? 'spin' : ''} /> Refresh status
          </button>
        </div>
      ) : status?.configured ? (
        <button type="button" className="btn btn-sm" disabled={busy} onClick={() => void refresh(true)}><RefreshCw size={13} className={busy ? 'spin' : ''} /> Refresh connection status</button>
      ) : null}

      {error ? <p className="worldpay-connect-panel__error">{error}</p> : null}
    </section>
  );
}
