import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import { HttpError } from '../../domain/common/errors.js';
import type { ChecklistTickRecord } from '../../domain/organisation/go-live-checklist.js';
import type { IntegrationConnectionRecord } from '../../repositories/ports/integration.port.js';
import type { OrganisationRecord } from '../../repositories/ports/organisation.port.js';
import { loadGoLiveChecklist, setGoLiveChecklistItem, type GoLiveChecklistDeps } from './go-live-checklist.js';

const ORG_A = '11111111-1111-4111-8111-111111111111';
const ORG_B = '22222222-2222-4222-8222-222222222222';

function organisation(id: string, overrides: Partial<OrganisationRecord> = {}): OrganisationRecord {
  return {
    id,
    companyId: null,
    name: `Pharmacy ${id.slice(0, 4)}`,
    tradingName: 'Trading Ltd',
    gphcNumber: id === ORG_A ? '1234567' : '7654321',
    superintendentName: 'A Pharmacist',
    mainContactName: null,
    mainContactPhone: null,
    mainContactEmail: null,
    address: '1 High Street',
    addressLine1: null,
    addressLine2: null,
    locality: null,
    county: null,
    postcode: null,
    latitude: null,
    longitude: null,
    primaryColour: '#000000',
    logoText: 'AP',
    status: 'ONBOARDING',
    classification: 'STANDARD',
    portalName: 'Portal',
    intakeEnabled: true,
    prescriptionEnabled: true,
    paymentsEnabled: true,
    supplierOrdersEnabled: true,
    patientsEnabled: true,
    resourcesEnabled: true,
    worldpayEnabled: false,
    defaultPaymentRoute: 'MANUAL',
    pharmacyDeliveryEnabled: false,
    autoPlacementEnabled: false,
    gdprComplianceFlag: false,
    pausedReason: null,
    pausedAt: null,
    version: 1,
    ...overrides,
  };
}

function harness(options: {
  orgA?: Partial<OrganisationRecord>;
  termsAt?: string | null;
  worldpayFormAt?: string | null;
  worldpay?: Partial<IntegrationConnectionRecord> | null;
  clickupThrows?: boolean;
} = {}) {
  const organisations = new Map([[ORG_A, organisation(ORG_A, options.orgA)], [ORG_B, organisation(ORG_B)]]);
  const ticks: ChecklistTickRecord[] = [];
  const progress: Array<{ organisationId: string; percent: number }> = [];
  const formLookups: string[] = [];
  const deps: GoLiveChecklistDeps = {
    findOrganisation: async id => organisations.get(id) ?? null,
    checklistRepo: {
      listTicks: async id => ticks.filter(row => row.organisationId === id),
      saveTick: async tick => {
        const index = ticks.findIndex(row => row.organisationId === tick.organisationId && row.itemKey === tick.itemKey);
        if (index >= 0) ticks[index] = tick;
        else ticks.push(tick);
      },
      termsAcceptedAt: async id => (id === ORG_A ? options.termsAt ?? null : null),
      worldpayFormSubmittedAt: async gphc => {
        formLookups.push(gphc);
        return gphc === '1234567' ? options.worldpayFormAt ?? null : null;
      },
    },
    findWorldpayConnection: async id => (id === ORG_A && options.worldpay ? {
      id: 'conn',
      organisationId: id,
      integration: 'WORLDPAY',
      environment: 'PRODUCTION',
      status: 'ACTIVE',
      secretResourceName: 'projects/p/secrets/hhh-worldpay-x-europe-west2',
      externalCustomerId: 'entity',
      maskedCredential: '••••tity',
      validatedAt: null,
      lastSuccessfulAt: '2026-11-21T09:00:00.000Z',
      lastErrorCode: null,
      version: 1,
      createdAt: '2026-11-21T09:00:00.000Z',
      updatedAt: '2026-11-21T09:00:00.000Z',
      ...options.worldpay,
    } : null),
    clickup: {
      checklistProgress: async input => {
        if (options.clickupThrows) throw new Error('ClickUp down');
        progress.push({ organisationId: input.organisation.id, percent: input.percent });
      },
    },
    now: () => new Date('2026-11-22T12:00:00.000Z'),
  };
  return { deps, ticks, progress, formLookups };
}

describe('loading the go-live checklist', () => {
  it('auto-ticks Platform live, Partner Terms and Worldpay validated from the platform', async () => {
    const { deps } = harness({ orgA: { status: 'LIVE' }, termsAt: '2026-11-19T09:00:00.000Z', worldpay: {} });
    const view = await loadGoLiveChecklist(deps, ORG_A);
    const done = Object.fromEntries(view.items.map(item => [item.key, item.done]));
    assert.equal(done.platform_live, true);
    assert.equal(done.partner_terms_accepted, true);
    assert.equal(done.worldpay_credentials_validated, true);
    assert.equal(done.worldpay_setup, undefined);
  });

  it('looks the Worldpay form up by the branch\'s compact GPhC and switches the Worldpay item', async () => {
    const before = harness();
    assert.ok((await loadGoLiveChecklist(before.deps, ORG_A)).items.some(item => item.key === 'worldpay_setup'));
    const after = harness({ orgA: { gphcNumber: ' 1234567 ' }, worldpayFormAt: '2026-11-20T09:00:00.000Z' });
    const view = await loadGoLiveChecklist(after.deps, ORG_A);
    assert.deepEqual(after.formLookups, ['1234567']);
    const worldpay = view.items.find(item => item.key === 'worldpay_credentials_validated');
    assert.equal(worldpay?.section, 'required');
    assert.equal(worldpay?.done, false);
    assert.ok(!view.items.some(item => item.key === 'worldpay_setup'));
  });

  it('shows the Required Worldpay item when worldpayEnabled is on with no form', async () => {
    const { deps } = harness({ orgA: { worldpayEnabled: true } });
    const view = await loadGoLiveChecklist(deps, ORG_A);
    assert.ok(view.items.some(item => item.key === 'worldpay_credentials_validated'));
  });

  it('refuses an unknown branch', async () => {
    const { deps } = harness();
    await assert.rejects(loadGoLiveChecklist(deps, '33333333-3333-4333-8333-333333333333'), (error: unknown) => error instanceof HttpError && error.statusCode === 404);
  });
});

describe('ticking the go-live checklist', () => {
  it('ticks and unticks a self-declared item, recording who and when', async () => {
    const { deps, ticks } = harness();
    let view = await setGoLiveChecklistItem(deps, { organisationId: ORG_A, itemKey: 'sops_approved', done: true, uid: 'staff-1' });
    assert.equal(view.items.find(item => item.key === 'sops_approved')!.done, true);
    assert.deepEqual(ticks, [{ organisationId: ORG_A, itemKey: 'sops_approved', status: 'DONE', tickedByUid: 'staff-1', tickedAt: '2026-11-22T12:00:00.000Z' }]);
    view = await setGoLiveChecklistItem(deps, { organisationId: ORG_A, itemKey: 'sops_approved', done: false, uid: 'staff-2' });
    assert.equal(view.items.find(item => item.key === 'sops_approved')!.done, false);
    assert.equal(ticks.length, 1);
    assert.equal(ticks[0]!.status, 'OPEN');
    assert.equal(ticks[0]!.tickedByUid, 'staff-2');
  });

  for (const itemKey of ['platform_live', 'partner_terms_accepted', 'worldpay_credentials_validated', 'worldpay_setup']) {
    it(`refuses to tick ${itemKey} by hand`, async () => {
      const { deps, ticks, progress } = harness();
      await assert.rejects(
        setGoLiveChecklistItem(deps, { organisationId: ORG_A, itemKey, done: true, uid: 'staff-1' }),
        (error: unknown) => error instanceof HttpError && error.statusCode === 409 && error.code === 'CHECKLIST_ITEM_NOT_SELF_DECLARED',
      );
      assert.equal(ticks.length, 0);
      assert.equal(progress.length, 0);
    });
  }

  it('refuses an item that is not on the list', async () => {
    const { deps } = harness();
    await assert.rejects(
      setGoLiveChecklistItem(deps, { organisationId: ORG_A, itemKey: 'made_up', done: true, uid: 'staff-1' }),
      (error: unknown) => error instanceof HttpError && error.statusCode === 404,
    );
  });

  it('keeps each branch\'s ticks to itself', async () => {
    const { deps } = harness();
    await setGoLiveChecklistItem(deps, { organisationId: ORG_A, itemKey: 'formulary_uploaded', done: true, uid: 'staff-a' });
    const other = await loadGoLiveChecklist(deps, ORG_B);
    assert.equal(other.items.find(item => item.key === 'formulary_uploaded')!.done, false);
    const own = await loadGoLiveChecklist(deps, ORG_A);
    assert.equal(own.items.find(item => item.key === 'formulary_uploaded')!.done, true);
  });

  it('tells ClickUp the overall percentage on every tick and untick', async () => {
    const { deps, progress } = harness();
    await setGoLiveChecklistItem(deps, { organisationId: ORG_A, itemKey: 'sops_approved', done: true, uid: 'staff-1' });
    await setGoLiveChecklistItem(deps, { organisationId: ORG_A, itemKey: 'staff_training', done: true, uid: 'staff-1' });
    await setGoLiveChecklistItem(deps, { organisationId: ORG_A, itemKey: 'staff_training', done: false, uid: 'staff-1' });
    // 11 items shown before Worldpay is started.
    assert.deepEqual(progress, [
      { organisationId: ORG_A, percent: 9 },
      { organisationId: ORG_A, percent: 18 },
      { organisationId: ORG_A, percent: 9 },
    ]);
  });

  it('still saves the tick when ClickUp fails', async () => {
    const { deps, ticks } = harness({ clickupThrows: true });
    const view = await setGoLiveChecklistItem(deps, { organisationId: ORG_A, itemKey: 'sops_approved', done: true, uid: 'staff-1' });
    assert.equal(view.items.find(item => item.key === 'sops_approved')!.done, true);
    assert.equal(ticks.length, 1);
  });
});

describe('go-live checklist routes', () => {
  const here = dirname(fileURLToPath(import.meta.url));
  const source = readFileSync(join(here, '../../transport/portal/go-live-checklist.router.ts'), 'utf8');

  it('scopes the pharmacy routes to the session\'s own branch, never a branch in the request', () => {
    const pharmacyRoutes = source.match(/router\.get\('\/portal\/go-live-checklist'[\s\S]*?router\.get\('\/portal\/admin/)?.[0];
    assert.ok(pharmacyRoutes);
    assert.match(pharmacyRoutes, /requireStaff\('pharmacy'\)/);
    assert.match(pharmacyRoutes, /assertTenantScope/);
    assert.match(pharmacyRoutes, /organisationId: tenant\.organisationId/);
    assert.doesNotMatch(pharmacyRoutes, /req\.body\??\.organisationId|req\.query/);
    assert.match(pharmacyRoutes, /router\.post\('\/portal\/go-live-checklist\/items\/:itemKey', requireCsrf, requireStaff\('pharmacy'\)/);
  });

  it('keeps the per-branch view for any branch to HHH admin', () => {
    assert.match(source, /router\.get\('\/portal\/admin\/organisations\/:id\/go-live-checklist', requireStaff\('admin'\)/);
    assert.match(source, /assertPlatformScope/);
  });
});
