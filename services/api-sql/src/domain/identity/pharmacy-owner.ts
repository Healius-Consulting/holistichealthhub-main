/**
 * The pharmacy owner is a contact tag, not an auth role.
 * An assigned uid wins when that account is still on the staff list; otherwise
 * the earliest remaining account is used so existing pharmacies keep working
 * until HHH assigns the real owner.
 */
export function resolveOwnerUid<T extends { uid: string; createdAt?: string | null }>(
  staff: T[],
  assignedOwnerUid?: string | null,
) {
  if (assignedOwnerUid && staff.some(member => member.uid === assignedOwnerUid)) {
    return assignedOwnerUid;
  }
  const sorted = [...staff].sort((left, right) => String(left.createdAt ?? '').localeCompare(String(right.createdAt ?? '')));
  return sorted[0]?.uid ?? null;
}
