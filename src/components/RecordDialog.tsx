import { useEffect, useLayoutEffect, useRef, useSyncExternalStore, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { X } from 'lucide-react';

/** Nested CRM dialogs share one body scroll lock. */
let openCrmDialogCount = 0;

const mountedLayers = new Set<number>();
const layerListeners = new Set<() => void>();

export const RECORD_DIALOG_BASE_Z = 1400;
export const RECORD_DIALOG_LAYER_STEP = 10;

function emitRecordLayerChange() {
  layerListeners.forEach(listener => listener());
}

/** Next free layer above every record that is already open. */
export function allocateRecordLayer() {
  return (mountedLayers.size ? Math.max(...mountedLayers) : -1) + 1;
}

export function currentTopRecordLayer() {
  return mountedLayers.size ? Math.max(...mountedLayers) : -1;
}

export function recordDialogZIndex(layer: number) {
  return RECORD_DIALOG_BASE_Z + layer * RECORD_DIALOG_LAYER_STEP;
}

function subscribeRecordLayers(onChange: () => void) {
  layerListeners.add(onChange);
  return () => { layerListeners.delete(onChange); };
}

/**
 * Large record dialog shared by the CRM boards. Portaled to `document.body` so a
 * parked (keep-alive) Orders/Patients screen can still open a record on top of
 * the screen the operator is actually looking at — e.g. patient from an order
 * without leaving the Orders tab.
 *
 * `layer` is a global stack index: later records sit above earlier ones even when
 * the two boards portal in a different DOM order. Escape, Tab and scrim click only
 * run on the top layer.
 *
 * Focus and Escape wiring run once on mount. The close callback is read from a
 * ref so parent re-renders (e.g. typing in a controlled field) do not re-focus
 * the dialog shell and kick the caret out of the input.
 */
export default function RecordDialog({ label, layer, onClose, children }: {
  label: string;
  layer: number;
  onClose: () => void;
  children: ReactNode;
}) {
  const dialogRef = useRef<HTMLDivElement>(null);
  const scrimRef = useRef<HTMLDivElement>(null);
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;
  const topLayer = useSyncExternalStore(subscribeRecordLayers, currentTopRecordLayer, currentTopRecordLayer);
  const isTop = layer === topLayer;
  const isTopRef = useRef(isTop);
  isTopRef.current = isTop;

  useLayoutEffect(() => {
    mountedLayers.add(layer);
    emitRecordLayerChange();
    return () => {
      mountedLayers.delete(layer);
      emitRecordLayerChange();
    };
  }, [layer]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (!isTopRef.current) return;
      if (document.querySelector('.order-handout-backdrop')) return;
      if (event.key === 'Escape') {
        onCloseRef.current();
        return;
      }
      if (event.key !== 'Tab') return;
      const focusable = [...(dialogRef.current?.querySelectorAll<HTMLElement>(
        'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])',
      ) ?? [])].filter(element => element.getClientRects().length > 0);
      if (!focusable.length) {
        event.preventDefault();
        dialogRef.current?.focus();
        return;
      }
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (event.shiftKey && (document.activeElement === first || document.activeElement === dialogRef.current)) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };
    document.addEventListener('keydown', onKeyDown);
    const previous = document.activeElement as HTMLElement | null;
    openCrmDialogCount += 1;
    document.body.style.overflow = 'hidden';
    return () => {
      document.removeEventListener('keydown', onKeyDown);
      openCrmDialogCount = Math.max(0, openCrmDialogCount - 1);
      if (openCrmDialogCount === 0) document.body.style.overflow = '';
      previous?.focus?.();
    };
  }, []);

  useEffect(() => {
    if (!isTop) return;
    if (document.querySelector('.order-handout-backdrop')) return;
    dialogRef.current?.focus({ preventScroll: true });
  }, [isTop]);

  return createPortal(
    <div
      ref={scrimRef}
      className="crm-dialog__scrim"
      role="presentation"
      data-layer={layer}
      style={{ zIndex: recordDialogZIndex(layer) }}
      inert={!isTop}
      onClick={event => { if (isTop && event.target === event.currentTarget) onCloseRef.current(); }}
    >
      <div
        className="crm-dialog"
        role="dialog"
        aria-modal={isTop}
        aria-hidden={!isTop}
        aria-label={label}
        ref={dialogRef}
        tabIndex={-1}
      >
        <div className="crm-dialog__chrome">
          <button type="button" className="crm-dialog__close icon-button" aria-label="Close record" onClick={() => { if (isTop) onCloseRef.current(); }}>
            <X size={16} aria-hidden="true" />
          </button>
        </div>
        <div className="crm-dialog__body">{children}</div>
      </div>
    </div>,
    document.body,
  );
}
