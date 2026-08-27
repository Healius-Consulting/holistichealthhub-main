import { useMemo, useState } from 'react';
import { Check, Plus, Search, Star, X } from 'lucide-react';
import { CONDITIONS, conditionLabel } from '@hhh/domain';
import './ConditionEditor.css';

type ConditionEditorProps = {
  conditions: string[];
  primaryCondition: string;
  saving: boolean;
  error: string | null;
  onCancel: () => void;
  onSave: (conditionCodes: string[], primaryConditionCode: string) => void;
};

/**
 * Editing the conditions on a patient record.
 *
 * There is deliberately no cap on how many can be selected. The public
 * eligibility form allows three, to keep an unsupervised intake short; staff
 * here are transcribing a clinic letter, and a record that cannot hold what the
 * letter says is a record that disagrees with the prescription being dispensed.
 *
 * Exactly one condition is primary at all times. Removing the primary promotes
 * the next remaining one rather than leaving the record in a state that cannot
 * be saved — the alternative is a Save button that silently refuses.
 */
export default function ConditionEditor({
  conditions,
  primaryCondition,
  saving,
  error,
  onCancel,
  onSave,
}: ConditionEditorProps) {
  const [selected, setSelected] = useState<string[]>(() => {
    const unique = [...new Set(conditions.filter(Boolean))];
    return unique.length ? unique : [];
  });
  const [primary, setPrimary] = useState<string>(() => (
    primaryCondition && conditions.includes(primaryCondition) ? primaryCondition : conditions[0] ?? ''
  ));
  const [query, setQuery] = useState('');

  const available = useMemo(() => {
    const term = query.trim().toLowerCase();
    return CONDITIONS
      .filter(condition => !selected.includes(condition.id))
      .filter(condition => !term || condition.label.toLowerCase().includes(term));
  }, [query, selected]);

  const add = (id: string) => {
    setSelected(current => (current.includes(id) ? current : [...current, id]));
    setPrimary(current => current || id);
  };

  const remove = (id: string) => {
    setSelected(current => {
      const next = current.filter(code => code !== id);
      // Removing the primary promotes whatever is left, so the record is never
      // momentarily without one.
      if (id === primary) setPrimary(next[0] ?? '');
      return next;
    });
  };

  const canSave = selected.length > 0 && Boolean(primary) && selected.includes(primary) && !saving;

  return (
    <div className="condition-editor">
      <div className="condition-editor__selected" aria-label="Recorded conditions">
        {selected.length === 0 ? (
          <p className="condition-editor__empty">No conditions recorded. Add at least one before saving.</p>
        ) : (
          <ul>
            {selected.map(id => (
              <li key={id} className={id === primary ? 'is-primary' : undefined}>
                <span className="condition-editor__name">{conditionLabel(id)}</span>
                <button
                  type="button"
                  className="condition-editor__primary"
                  aria-pressed={id === primary}
                  aria-label={id === primary ? `${conditionLabel(id)} is the primary condition` : `Make ${conditionLabel(id)} the primary condition`}
                  onClick={() => setPrimary(id)}
                >
                  <Star size={13} aria-hidden="true" />
                  {id === primary ? 'Primary' : 'Set primary'}
                </button>
                <button
                  type="button"
                  className="condition-editor__remove"
                  aria-label={`Remove ${conditionLabel(id)}`}
                  onClick={() => remove(id)}
                >
                  <X size={13} aria-hidden="true" />
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>

      <div className="condition-editor__search">
        <Search size={14} aria-hidden="true" />
        <input
          className="input"
          value={query}
          placeholder="Search conditions to add"
          aria-label="Search conditions to add"
          onChange={event => setQuery(event.target.value)}
        />
      </div>

      <ul className="condition-editor__available" aria-label="Conditions available to add">
        {available.length === 0 ? (
          <li className="condition-editor__empty">
            {selected.length === CONDITIONS.length ? 'Every condition is already recorded.' : 'No conditions match that search.'}
          </li>
        ) : available.map(condition => (
          <li key={condition.id}>
            <button type="button" onClick={() => add(condition.id)}>
              <Plus size={13} aria-hidden="true" /> {condition.label}
            </button>
          </li>
        ))}
      </ul>

      {error ? <p className="condition-editor__error" role="alert">{error}</p> : null}

      <div className="condition-editor__actions">
        <button type="button" className="btn btn-primary btn-sm" disabled={!canSave} onClick={() => onSave(selected, primary)}>
          <Check size={14} aria-hidden="true" /> {saving ? 'Saving…' : 'Save conditions'}
        </button>
        <button type="button" className="btn btn-secondary btn-sm" disabled={saving} onClick={onCancel}>Cancel</button>
      </div>
    </div>
  );
}
