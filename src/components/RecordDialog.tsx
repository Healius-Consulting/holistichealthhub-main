import { useEffect, useRef, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { X } from 'lucide-react';

/** Nested CRM dialogs share one body scroll lock. */
let openCrmDialogCount = 0;

/**
 * Large record dialog shared by the CRM boards. Portaled to `document.body` so a
 * parked (keep-alive) Orders/Patients screen can still open a record on top of
 * the screen the operator is actually looking at — e.g. patient from an order
 * without leaving the Orders tab.
 *
 * Focus and Escape wiring run once on mount. The close callback is read from a
 * ref so parent re-renders (e.g. typing in a controlled field) do not re-focus
 * the dialog shell and kick the caret out of the input.
 */
export default function RecordDialog({ label, onClose, children }: {
  label: string;
  onClose: () => void;
  children: ReactNode;
}) {
  const dialogRef = useRef<HTMLDivElement>(null);
  const scrimRef = useRef<HTMLDivElement>(null);
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      const scrims = document.querySelectorAll('.crm-dialog__scrim');
      if (scrims.length && scrims[scrims.length - 1] !== scrimRef.current) return;
      onCloseRef.current();
    };
    document.addEventListener('keydown', onKeyDown);
    const previous = document.activeElement as HTMLElement | null;
    openCrmDialogCount += 1;
    document.body.style.overflow = 'hidden';
    dialogRef.current?.focus({ preventScroll: true });
    return () => {
      document.removeEventListener('keydown', onKeyDown);
      openCrmDialogCount = Math.max(0, openCrmDialogCount - 1);
      if (openCrmDialogCount === 0) document.body.style.overflow = '';
      previous?.focus?.();
    };
  }, []);

  return createPortal(
    <div
      ref={scrimRef}
      className="crm-dialog__scrim"
      role="presentation"
      onClick={event => { if (event.target === event.currentTarget) onCloseRef.current(); }}
    >
      <div className="crm-dialog" role="dialog" aria-modal="true" aria-label={label} ref={dialogRef} tabIndex={-1}>
        <button type="button" className="crm-dialog__close icon-button" aria-label="Close record" onClick={() => onCloseRef.current()}>
          <X size={16} aria-hidden="true" />
        </button>
        <div className="crm-dialog__body">{children}</div>
      </div>
    </div>,
    document.body,
  );
}
