/**
 * The two answers the clinic's criteria are checked against at submission. A failed
 * check no longer decides the application: it is recorded as a flag for HHH admin,
 * who accept or decline with the full picture. The flag names the question so the
 * decision can be explained to the patient and audited.
 */
export type ScreeningRule = 'TREATMENTS_NOT_TRIED' | 'PSYCHOSIS_HISTORY';

export type ScreeningAnswers = {
  triedTwoTreatments: boolean;
  psychiatricExclusion: boolean;
};

/**
 * Treatments first: when a patient fails both, the treatments answer is the one they
 * can act on, and it is the milder thing to be told. Only one rule is ever recorded.
 */
export function screeningFlagFor(answers: ScreeningAnswers): ScreeningRule | null {
  if (!answers.triedTwoTreatments) return 'TREATMENTS_NOT_TRIED';
  if (answers.psychiatricExclusion) return 'PSYCHOSIS_HISTORY';
  return null;
}

/** The clause used when the patient is told which question decided a decline. */
export function screeningQuestionClause(rule: ScreeningRule): string {
  return rule === 'TREATMENTS_NOT_TRIED' ? 'the treatments question' : 'the family-history question';
}

/** The admin decline reason that corresponds to a screening flag, offered as the default. */
export function declineReasonForScreeningFlag(rule: ScreeningRule): 'ELIGIBILITY_NOT_MET' | 'PSYCHIATRIC_EXCLUSION' {
  return rule === 'TREATMENTS_NOT_TRIED' ? 'ELIGIBILITY_NOT_MET' : 'PSYCHIATRIC_EXCLUSION';
}
