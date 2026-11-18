import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  buildGoLiveChecklist,
  GO_LIVE_CHECKLIST,
  worldpayValidatedAt,
  type ChecklistSignals,
  type ChecklistTickRecord,
} from './go-live-checklist.js';

const ORG = '11111111-1111-4111-8111-111111111111';
const OTHER = '22222222-2222-4222-8222-222222222222';

function signals(overrides: Partial<ChecklistSignals> = {}): ChecklistSignals {
  return {
    organisationStatus: 'ONBOARDING',
    worldpayEnabled: false,
    termsAcceptedAt: null,
    worldpayFormSubmittedAt: null,
    worldpayValidatedAt: null,
    ...overrides,
  };
}

function tick(itemKey: string, status: 'DONE' | 'OPEN' = 'DONE', organisationId = ORG): ChecklistTickRecord {
  return { organisationId, itemKey, status, tickedByUid: 'staff-1', tickedAt: '2026-11-20T10:00:00.000Z' };
}

describe('go-live checklist list (brief 2.5)', () => {
  it('lists Required first, then Optional, with the fixed owners', () => {
    assert.deepEqual(
      GO_LIVE_CHECKLIST.map(item => [item.section, item.key, item.owners.join('/')]),
      [
        ['required', 'platform_live', 'HHH/Curaleaf'],
        ['required', 'partner_terms_accepted', 'Pharmacy'],
        ['required', 'worldpay_credentials_validated', 'Pharmacy'],
        ['required', 'sops_approved', 'Pharmacy'],
        ['required', 'formulary_uploaded', 'Pharmacy'],
        ['optional', 'worldpay_setup', 'Pharmacy'],
        ['optional', 'staff_training', 'Pharmacy'],
        ['optional', 'patientsmart_campaign', 'Pharmacy'],
        ['optional', 'website_updated', 'Pharmacy'],
        ['optional', 'posters_leaflets', 'Pharmacy'],
        ['optional', 'branding_details', 'Pharmacy'],
        ['optional', 'delivery_enabled', 'Pharmacy'],
      ],
    );
  });

  it('marks the three platform-known items auto, the Worldpay form a link, and the rest self-declared', () => {
    const kinds = Object.fromEntries(GO_LIVE_CHECKLIST.map(item => [item.key, item.kind]));
    assert.equal(kinds.platform_live, 'auto');
    assert.equal(kinds.partner_terms_accepted, 'auto');
    assert.equal(kinds.worldpay_credentials_validated, 'auto');
    assert.equal(kinds.worldpay_setup, 'link');
    for (const key of ['sops_approved', 'formulary_uploaded', 'staff_training', 'patientsmart_campaign', 'website_updated', 'posters_leaflets', 'branding_details', 'delivery_enabled']) {
      assert.equal(kinds[key], 'self', key);
    }
  });
});

describe('auto-ticking items', () => {
  it('ticks Platform live only at LIVE', () => {
    const at = (status: string) => buildGoLiveChecklist(ORG, signals({ organisationStatus: status }), []).items.find(item => item.key === 'platform_live')!.done;
    assert.equal(at('ONBOARDING'), false);
    assert.equal(at('PAUSED'), false);
    assert.equal(at('LIVE'), true);
  });

  it('ticks Partner Terms accepted from the acceptance, with its date', () => {
    const view = buildGoLiveChecklist(ORG, signals({ termsAcceptedAt: '2026-11-19T09:00:00.000Z' }), []);
    const item = view.items.find(entry => entry.key === 'partner_terms_accepted')!;
    assert.equal(item.done, true);
    assert.equal(item.doneAt, '2026-11-19T09:00:00.000Z');
  });

  it('ticks Worldpay credentials validated from the validated live connection', () => {
    const view = buildGoLiveChecklist(ORG, signals({ worldpayEnabled: true, worldpayValidatedAt: '2026-11-21T09:00:00.000Z' }), []);
    assert.equal(view.items.find(item => item.key === 'worldpay_credentials_validated')!.done, true);
  });

  it('ignores a stored tick on an auto item', () => {
    const view = buildGoLiveChecklist(ORG, signals(), [tick('platform_live'), tick('partner_terms_accepted')]);
    assert.equal(view.items.find(item => item.key === 'platform_live')!.done, false);
    assert.equal(view.items.find(item => item.key === 'partner_terms_accepted')!.done, false);
  });

  it('counts only a live, ACTIVE, stored Worldpay connection that Worldpay answered as validated', () => {
    const base = { status: 'ACTIVE', environment: 'PRODUCTION', secretResourceName: 'projects/p/secrets/s', lastSuccessfulAt: '2026-11-21T09:00:00.000Z', validatedAt: null };
    assert.equal(worldpayValidatedAt(base), '2026-11-21T09:00:00.000Z');
    assert.equal(worldpayValidatedAt({ ...base, environment: 'TEST' }), null);
    assert.equal(worldpayValidatedAt({ ...base, status: 'DISCONNECTED' }), null);
    assert.equal(worldpayValidatedAt({ ...base, status: 'ERROR' }), null);
    assert.equal(worldpayValidatedAt({ ...base, secretResourceName: null }), null);
    assert.equal(worldpayValidatedAt({ ...base, lastSuccessfulAt: null }), null);
    assert.equal(worldpayValidatedAt(null), null);
  });
});

describe('Worldpay item switching', () => {
  const keys = (overrides: Partial<ChecklistSignals>) => buildGoLiveChecklist(ORG, signals(overrides), []).items.map(item => item.key);

  it('offers the Optional Worldpay set-up link until the pharmacy starts with Worldpay', () => {
    const shown = keys({});
    assert.ok(shown.includes('worldpay_setup'));
    assert.ok(!shown.includes('worldpay_credentials_validated'));
  });

  for (const [label, overrides] of [
    ['the form is submitted', { worldpayFormSubmittedAt: '2026-11-20T09:00:00.000Z' }],
    ['worldpayEnabled is on', { worldpayEnabled: true }],
    ['a live merchant is already validated', { worldpayValidatedAt: '2026-11-20T09:00:00.000Z' }],
  ] as const) {
    it(`moves to Required "Worldpay credentials validated" once ${label}`, () => {
      const shown = keys(overrides);
      assert.ok(shown.includes('worldpay_credentials_validated'));
      assert.ok(!shown.includes('worldpay_setup'));
    });
  }
});

describe('self-declared ticks and percentages', () => {
  it('uses the latest stored status of a self-declared item', () => {
    const view = buildGoLiveChecklist(ORG, signals(), [tick('sops_approved'), tick('formulary_uploaded', 'OPEN')]);
    const sops = view.items.find(item => item.key === 'sops_approved')!;
    assert.equal(sops.done, true);
    assert.equal(sops.tickedByUid, 'staff-1');
    assert.equal(view.items.find(item => item.key === 'formulary_uploaded')!.done, false);
  });

  it('never uses another branch\'s ticks', () => {
    const view = buildGoLiveChecklist(ORG, signals(), [tick('sops_approved', 'DONE', OTHER)]);
    assert.equal(view.items.find(item => item.key === 'sops_approved')!.done, false);
  });

  it('matches ticks whether the id is hyphenated or compact', () => {
    const view = buildGoLiveChecklist(ORG, signals(), [tick('sops_approved', 'DONE', ORG.replaceAll('-', ''))]);
    assert.equal(view.items.find(item => item.key === 'sops_approved')!.done, true);
  });

  it('works out a percentage for each section and overall', () => {
    // Required shown: platform live, terms, SOPs, formulary (4). Optional shown: Worldpay link + 6 (7).
    const view = buildGoLiveChecklist(ORG, signals({ organisationStatus: 'LIVE', termsAcceptedAt: '2026-11-19T09:00:00.000Z' }), [
      tick('sops_approved'),
      tick('staff_training'),
    ]);
    assert.deepEqual(view.sections, [
      { section: 'required', done: 3, total: 4, percent: 75 },
      { section: 'optional', done: 1, total: 7, percent: 14 },
    ]);
    assert.equal(view.percent, 36);
    assert.equal(view.requiredComplete, false);
    assert.equal(view.complete, false);
  });

  it('is required-complete once every Required item is done', () => {
    const view = buildGoLiveChecklist(ORG, signals({ organisationStatus: 'LIVE', termsAcceptedAt: '2026-11-19T09:00:00.000Z' }), [
      tick('sops_approved'),
      tick('formulary_uploaded'),
    ]);
    assert.equal(view.sections[0]!.percent, 100);
    assert.equal(view.requiredComplete, true);
  });
});
