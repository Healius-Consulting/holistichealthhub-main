/**
 * The pharmacy owner is the earliest staff account created for the tenant.
 * The portal uses this only as a contact tag — it does not grant extra permissions.
 */
export function resolveOwnerUid<T extends { uid: string; createdAt?: string | null }>(staff: T[]) {
  const sorted = [...staff].sort((left, right) => String(left.createdAt ?? '').localeCompare(String(right.createdAt ?? '')));
  return sorted[0]?.uid ?? null;
}
