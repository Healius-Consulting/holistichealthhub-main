import { curaleafEntityRecord } from '../integrations/curaleaf-events.js';
import { snapshotRxList } from '../prescriptions/snapshot-rx.js';
import type { IntegrationConnectionRecord } from '../../repositories/ports/integration.port.js';
import type { OrderRecord } from '../../repositories/ports/order.port.js';
import { pendingPlacements, placementRetrySkipReason } from './retry-curaleaf-placements.js';

/**
 * When paid orders have waited 3 days for Curaleaf to verify their prescriber, email
 * the HHH admin inbox something they can forward to Curaleaf as it is: the pharmacy,
 * its Curaleaf customer ID, the prescriber's details and the order numbers waiting.
 * One email per pharmacy and prescriber, again every 3 days while any still wait.
 * No patient details: the prescriber and the order numbers are all Curaleaf needs.
 */

const DAY = 24 * 60 * 60 * 1000;
export const PRESCRIBER_STUCK_AFTER_MS = 3 * DAY;
export const PRESCRIBER_ALERT_REPEAT_MS = 3 * DAY;

export function prescriberAlertRecipients() {
  const raw = process.env.CURALEAF_STUCK_ALERT_TO?.trim();
  const list = raw ? raw.split(',').map(address => address.trim().toLowerCase()).filter(Boolean) : [];
  return list.length ? list : ['admin@holistichealthhub.live'];
}

type Prescriber = { name: string | null; pin: string | null; gmcNumber: string | null; gphcNumber: string | null };

export type StuckPrescriberGroup = {
  organisationId: string;
  prescriberId: string;
  prescriber: Prescriber;
  orders: Array<{ orderNumber: string; waitingSince: string }>;
};

function text(value: unknown) {
  if (typeof value === 'number') return String(value);
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

/** Orders waiting 3+ days on an unverified prescriber, grouped by pharmacy and prescriber. */
export function stuckPrescriberGroups(orders: OrderRecord[], now: Date): StuckPrescriberGroup[] {
  const groups = new Map<string, StuckPrescriberGroup>();
  for (const order of orders) {
    if (placementRetrySkipReason(order)) continue;
    const since = String(order.paidAt || order.createdAt || '');
    const sinceMs = Date.parse(since);
    if (!Number.isFinite(sinceMs) || now.getTime() - sinceMs < PRESCRIBER_STUCK_AFTER_MS) continue;
    const prescriptions = snapshotRxList(order.quoteSnapshot);
    for (const pending of pendingPlacements(order.quoteSnapshot)) {
      if (pending.waitingFor !== 'prescriber_verification' || !pending.prescriberId) continue;
      const key = `${order.organisationId}:${pending.prescriberId}`;
      const details = (prescriptions[pending.rxIndex]?.prescriber ?? {}) as Record<string, unknown>;
      const group = groups.get(key) ?? {
        organisationId: order.organisationId,
        prescriberId: pending.prescriberId,
        prescriber: { name: text(details.name), pin: text(details.pin), gmcNumber: text(details.gmcNumber), gphcNumber: text(details.gphcNumber) },
        orders: [],
      };
      const orderNumber = order.orderNumber || order.id;
      if (!group.orders.some(entry => entry.orderNumber === orderNumber)) group.orders.push({ orderNumber, waitingSince: since });
      groups.set(key, group);
    }
  }
  for (const group of groups.values()) group.orders.sort((left, right) => left.waitingSince.localeCompare(right.waitingSince));
  return [...groups.values()];
}

function ukDate(iso: string) {
  return new Intl.DateTimeFormat('en-GB', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'Europe/London' }).format(new Date(iso));
}

/** Subject and paragraphs; the part from "Hello" down is written to forward to Curaleaf. */
export function prescriberAlertEmail(
  group: StuckPrescriberGroup,
  pharmacy: { name: string; gphcNumber: string | null },
  connection: Pick<IntegrationConnectionRecord, 'externalCustomerId' | 'environment'>,
  now: Date,
) {
  const prescriberName = group.prescriber.name || 'the prescriber';
  const days = Math.floor((now.getTime() - Date.parse(group.orders[0]!.waitingSince)) / DAY);
  const count = group.orders.length;
  const ordersWord = count === 1 ? 'order' : 'orders';
  const test = connection.environment === 'TEST';
  return {
    subject: `${test ? '[Curaleaf UAT] ' : ''}Please verify prescriber ${prescriberName} for ${pharmacy.name} (${count} ${ordersWord} waiting)`,
    paragraphs: [
      `${count} paid ${ordersWord} at ${pharmacy.name} ${count === 1 ? 'has' : 'have'} waited ${days} days for Curaleaf to verify the prescriber. Nothing can go to Curaleaf until they do. Forward this email to Curaleaf; everything they need is below.`,
      'Hello Curaleaf team,',
      `Please could you verify the prescriber below on our account. We have ${count} paid ${ordersWord} waiting on them.`,
      [
        `Pharmacy: ${pharmacy.name}${pharmacy.gphcNumber ? ` (GPhC ${pharmacy.gphcNumber})` : ''}`,
        `Curaleaf customer ID: ${connection.externalCustomerId || 'not recorded'}`,
        ...(test ? ['Environment: UAT (test)'] : []),
      ].join('\n'),
      [
        `Prescriber: ${prescriberName}`,
        `PIN: ${group.prescriber.pin || 'not given'}`,
        ...(group.prescriber.gmcNumber ? [`GMC: ${group.prescriber.gmcNumber}`] : []),
        ...(group.prescriber.gphcNumber ? [`GPhC: ${group.prescriber.gphcNumber}`] : []),
        `Curaleaf prescriber ID: ${group.prescriberId}`,
      ].join('\n'),
      [`Orders waiting:`, ...group.orders.map(entry => `${entry.orderNumber} (paid ${ukDate(entry.waitingSince)})`)].join('\n'),
      'Once the prescriber is verified, the orders are sent to you automatically within the hour.',
      'Thank you,\nHolistic Health Hub',
    ],
  };
}

export type PrescriberAlertDeps = {
  lastSentAt(key: string): Promise<string | null>;
  recordSent(key: string, organisationId: string, at: string): Promise<void>;
  curaleafGet(connection: IntegrationConnectionRecord, path: string): Promise<unknown>;
  pharmacy(organisationId: string): Promise<{ name: string; gphcNumber: string | null } | null>;
  send(email: { to: string[]; subject: string; paragraphs: string[]; idempotencyKey: string }): Promise<void>;
};

export const prescriberAlertKey = (organisationId: string, prescriberId: string) =>
  `worker:curaleaf-prescriber-alert:${organisationId}:${prescriberId}`;

export async function alertStuckPrescribers(
  connections: IntegrationConnectionRecord[],
  orders: OrderRecord[],
  deps: PrescriberAlertDeps,
  now = new Date(),
) {
  const summary = { stuck: 0, sent: 0, errors: 0 };
  const byOrganisation = new Map(connections.map(connection => [connection.organisationId, connection]));
  for (const group of stuckPrescriberGroups(orders, now)) {
    const connection = byOrganisation.get(group.organisationId);
    if (!connection) continue;
    summary.stuck += 1;
    const key = prescriberAlertKey(group.organisationId, group.prescriberId);
    try {
      const last = Date.parse(String(await deps.lastSentAt(key) ?? ''));
      if (Number.isFinite(last) && now.getTime() - last < PRESCRIBER_ALERT_REPEAT_MS) continue;
      // Our record can lag Curaleaf by up to an hour; ask before telling anyone it is stuck.
      const state = String(curaleafEntityRecord(
        await deps.curaleafGet(connection, `/v1/prescribers/${encodeURIComponent(group.prescriberId)}/`),
        'prescriber',
      ).state || '').toUpperCase();
      if (state !== 'UNVERIFIED') continue;
      const pharmacy = await deps.pharmacy(group.organisationId);
      if (!pharmacy) continue;
      const email = prescriberAlertEmail(group, pharmacy, connection, now);
      await deps.send({
        to: prescriberAlertRecipients(),
        ...email,
        idempotencyKey: `${key}:${now.toISOString().slice(0, 10)}`,
      });
      await deps.recordSent(key, group.organisationId, now.toISOString());
      summary.sent += 1;
    } catch (error) {
      summary.errors += 1;
      console.warn('[Curaleaf prescriber alert] Alert failed.', {
        organisationId: group.organisationId,
        error: error instanceof Error ? error.message : 'Unknown error',
      });
    }
  }
  return summary;
}
