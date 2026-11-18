/**
 * Which order an Orders navigation target means. Screens in the browser pass the local
 * order number, with the prescription after it ("12" or "12-3"). The API's Overview
 * "needs you" items pass the order's database id (a UUID), and the demo data copies
 * that. Orders accepts both.
 */
export function findTargetOrder<T extends { order: { id: number; backendId?: string } }>(records: readonly T[], key: string): T | undefined {
  const trimmed = key.trim();
  const byBackendId = records.find(record => record.order.backendId === trimmed);
  if (byBackendId) return byBackendId;
  const local = /^(\d+)(?:-\d+)?$/.exec(trimmed);
  if (!local) return undefined;
  const orderId = Number(local[1]);
  return records.find(record => record.order.id === orderId);
}
