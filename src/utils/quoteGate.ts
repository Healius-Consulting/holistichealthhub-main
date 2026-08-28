import type { CuraleafQuoteCheckSummary } from '../shared/contracts';

/** The current payment gate is actionable only when its latest check is not matched. */
export function visiblePaymentGateCheck(
  quoteChecks: CuraleafQuoteCheckSummary[] | undefined,
  activeQuoteCheck?: CuraleafQuoteCheckSummary | null,
) {
  const checks = quoteChecks?.length
    ? [...quoteChecks].filter(check => Number.isFinite(new Date(check.checkedAt).getTime()))
      .sort((left, right) => new Date(left.checkedAt).getTime() - new Date(right.checkedAt).getTime())
    : activeQuoteCheck && Number.isFinite(new Date(activeQuoteCheck.checkedAt).getTime())
      ? [activeQuoteCheck]
      : [];
  const latest = checks.at(-1);
  return latest?.status === 'MATCHED' ? null : latest ?? null;
}
