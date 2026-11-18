/**
 * Shown at the top of an onboarding form when some fields arrived filled in.
 * Names the fields so the pharmacy knows exactly what to check.
 */
export function PrefillReviewBanner({ fields, source }: { fields: readonly string[]; source: string }) {
  if (fields.length === 0) return null;
  return (
    <div className="prefill-review-banner" role="note">
      <strong>Check the details we filled in</strong>
      <span>
        {fields.length === 1 ? 'One field was' : `${fields.length} fields were`} filled in from {source}.
        Check each one is right for your pharmacy and change anything that is not.
      </span>
      <span className="prefill-review-banner__fields">{fields.join(' · ')}</span>
    </div>
  );
}
