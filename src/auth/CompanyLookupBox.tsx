import { useId, useState, type KeyboardEvent } from 'react';
import { ApiRequestError, lookUpCompany, type CompanyLookup } from '../shared/api';

type State =
  | { kind: 'idle' }
  | { kind: 'loading' }
  | { kind: 'found'; company: CompanyLookup; filled: string[] }
  | { kind: 'error'; message: string };

const statusLabel = (status: string) => status.replace(/-/g, ' ');

/**
 * The optional company-number lookup at the top of the Curaleaf form. It fills what
 * Companies House holds and hands the record on, so the Worldpay form can use it too.
 * `onFound` applies the record and returns the labels of the fields it changed.
 */
export function CompanyLookupBox({
  intro,
  initialNumber = '',
  carriesToWorldpay = false,
  disabled,
  onFound,
}: {
  /** What the box says above the number: which details are already in, and what a lookup adds. */
  intro: string;
  /** A number the pharmacy already looked up (on the Curaleaf form), ready to look up again. */
  initialNumber?: string;
  /** On the Curaleaf form: say the directors and company details go on to Worldpay. */
  carriesToWorldpay?: boolean;
  disabled?: boolean;
  onFound: (company: CompanyLookup) => string[];
}) {
  const inputId = useId();
  const [number, setNumber] = useState(initialNumber);
  const [state, setState] = useState<State>({ kind: 'idle' });
  const loading = state.kind === 'loading';

  const run = async () => {
    if (loading || !number.trim()) return;
    setState({ kind: 'loading' });
    try {
      const company = await lookUpCompany(number);
      setState({ kind: 'found', company, filled: onFound(company) });
    } catch (cause) {
      setState({
        kind: 'error',
        message: cause instanceof ApiRequestError ? cause.message : 'Companies House could not be reached just now. Fill the form in yourself, or try again in a minute.',
      });
    }
  };

  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    // Enter looks the company up; it must not submit the Curaleaf form.
    if (event.key === 'Enter') {
      event.preventDefault();
      void run();
    }
  };

  return (
    <section className="company-lookup" aria-labelledby={`${inputId}-title`}>
      <p className="company-lookup__intro">
        <strong id={`${inputId}-title`}>Company number <span>Optional</span></strong>
        {intro} You can skip this.
      </p>
      <div className="company-lookup__row">
        <label className="sr-only" htmlFor={inputId}>Companies House number</label>
        <input
          id={inputId}
          className="input"
          value={number}
          onChange={event => setNumber(event.target.value)}
          onKeyDown={onKeyDown}
          placeholder="e.g. 01234567"
          autoComplete="off"
          spellCheck={false}
          maxLength={12}
          disabled={disabled || loading}
        />
        <button className="btn" type="button" onClick={() => void run()} disabled={disabled || loading || !number.trim()}>
          {loading ? 'Looking up…' : 'Look up'}
        </button>
      </div>
      <div aria-live="polite">
        {state.kind === 'found' ? (
          <p className={state.company.active ? 'company-lookup__found' : 'company-lookup__warning'}>
            <strong>{state.company.companyName}</strong> · {state.company.companyNumber} · {state.company.active ? 'Active' : statusLabel(state.company.status)}
            <br />
            {state.company.active
              ? null
              : <>Companies House lists this company as {statusLabel(state.company.status)}. Check the number, or speak to us before you carry on.<br /></>}
            {state.filled.length
              ? `Filled in: ${state.filled.join(', ')}. Check them before you submit.`
              : 'Nothing on this form needed changing.'}
            {carriesToWorldpay && (state.company.directors.length || state.company.businessType) ? ' Its directors and company details will carry into the Worldpay form.' : null}
          </p>
        ) : null}
        {state.kind === 'error' ? <p className="company-lookup__error" role="alert">{state.message}</p> : null}
      </div>
    </section>
  );
}
