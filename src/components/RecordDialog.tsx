import { useEffect, useRef, type ReactNode } from 'react';
import { X } from 'lucide-react';

/**
 * Large record dialog shared by the CRM boards. Closes on Escape or a scrim
 * click, holds the page still while it is open, and hands focus back to
 * whatever opened it.
 */
export default function RecordDialog({ label, onClose, children }: {
  label: string;
  onClose: () => void;
  children: ReactNode;
}) {
  const dialogRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', onKeyDown);
    const previous = document.activeElement as HTMLElement | null;
    const bodyOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    dialogRef.current?.focus({ preventScroll: true });
    return () => {
      document.removeEventListener('keydown', onKeyDown);
      document.body.style.overflow = bodyOverflow;
      previous?.focus?.();
    };
  }, [onClose]);

  return (
    <div className="crm-dialog__scrim" role="presentation" onClick={event => { if (event.target === event.currentTarget) onClose(); }}>
      <div className="crm-dialog" role="dialog" aria-modal="true" aria-label={label} ref={dialogRef} tabIndex={-1}>
        <button type="button" className="crm-dialog__close icon-button" aria-label="Close record" onClick={onClose}>
          <X size={16} aria-hidden="true" />
        </button>
        <div className="crm-dialog__body">{children}</div>
      </div>
    </div>
  );
}
