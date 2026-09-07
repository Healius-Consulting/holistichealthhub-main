/**
 * The two answers the clinic's criteria are applied to automatically. Terms 4.5 and
 * Privacy 3.3 promise the patient is told which one decided the outcome, so the rule
 * is recorded rather than inferred later from the answers.
 */
export type DeclineRule = 'TREATMENTS_NOT_TRIED' | 'PSYCHOSIS_HISTORY';

export type ScreeningAnswers = {
  triedTwoTreatments: boolean;
  psychiatricExclusion: boolean;
};

/**
 * Treatments first: when a patient fails both, the treatments answer is the one they
 * can act on, and it is the milder thing to be told. Only one rule is ever recorded.
 */
export function automaticDeclineRule(answers: ScreeningAnswers): DeclineRule | null {
  if (!answers.triedTwoTreatments) return 'TREATMENTS_NOT_TRIED';
  if (answers.psychiatricExclusion) return 'PSYCHOSIS_HISTORY';
  return null;
}

export function isAutomaticallyDeclined(answers: ScreeningAnswers): boolean {
  return automaticDeclineRule(answers) !== null;
}

/** The clause the patient sees in the decline screen, naming the question that decided it. */
export function declineReasonClause(rule: DeclineRule): string {
  return rule === 'TREATMENTS_NOT_TRIED' ? 'the treatments question' : 'the family-history question';
}
