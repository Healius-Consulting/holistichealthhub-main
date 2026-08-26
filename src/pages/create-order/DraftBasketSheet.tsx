import { AlertTriangle, ChevronDown, ChevronUp } from 'lucide-react';
import { money } from '../../context/AppContext';
import type { WizardProgress } from './types';

type DraftBasketSheetProps = {
  open: boolean;
  onToggle: () => void;
  progress: WizardProgress;
  draftBasketCount: number;
  draftBasketTotal: number;
  draftBasketBlockedCount: number;
  draftBasketWarningCount: number;
};

export default function DraftBasketSheet({
  open,
  onToggle,
  progress,
  draftBasketCount,
  draftBasketTotal,
  draftBasketBlockedCount,
  draftBasketWarningCount,
}: DraftBasketSheetProps) {
  if (!progress.basketUnlocked && !progress.basketIsProvisional) return null;

  return (
    <aside className={`rx-basket-sheet${open ? ' is-open' : ''}`} aria-label="Draft order summary">
      <button
        type="button"
        className="rx-basket-sheet__toggle"
        aria-expanded={open}
        onClick={onToggle}
      >
        <span>
          <small>{progress.basketIsProvisional ? 'Provisional basket' : 'Review order'}</small>
          <strong>
            {progress.basketIsProvisional
              ? `${draftBasketCount} medicine${draftBasketCount === 1 ? '' : 's'} queued`
              : `${draftBasketCount} medicine${draftBasketCount === 1 ? '' : 's'} · ${money(draftBasketTotal)}`}
          </strong>
        </span>
        <span className="rx-basket-sheet__hint">{open ? 'Hide' : 'Show'}{open ? <ChevronDown size={16} /> : <ChevronUp size={16} />}</span>
      </button>
      {open ? (
        <div className="rx-basket-sheet__panel">
          {progress.basketIsProvisional ? (
            <p className="rx-basket-sheet__provisional" role="status">
              <AlertTriangle size={14} aria-hidden="true" />
              Medicines are carried forward from the replacement order. Prices appear after you authenticate the new prescription.
            </p>
          ) : (
            <p className="rx-basket-sheet__note">Open the desktop summary rail or continue to payment for the full breakdown.</p>
          )}
          {draftBasketBlockedCount ? (
            <p className="rx-basket-sheet__alert" role="status">
              {draftBasketBlockedCount} unavailable line{draftBasketBlockedCount === 1 ? '' : 's'}
              {draftBasketWarningCount ? ` · ${draftBasketWarningCount} stock warning${draftBasketWarningCount === 1 ? '' : 's'}` : ''}
            </p>
          ) : null}
        </div>
      ) : null}
    </aside>
  );
}
