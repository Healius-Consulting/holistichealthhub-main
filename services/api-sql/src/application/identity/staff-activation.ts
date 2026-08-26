interface FirebaseMfaUser {
  disabled: boolean;
  multiFactor?: { enrolledFactors: Array<{ factorId: string }> };
}

export function hasEnrolledTotp(user: FirebaseMfaUser): boolean {
  return !user.disabled
    && (user.multiFactor?.enrolledFactors ?? []).some(factor => factor.factorId === 'totp');
}
