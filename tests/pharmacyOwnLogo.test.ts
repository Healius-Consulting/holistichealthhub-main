import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const read = (path: string) => readFileSync(new URL(path, import.meta.url), 'utf8');

test('a pharmacy uploads, replaces and removes its own logo through its own routes', () => {
  const api = read('../src/shared/api.ts');
  assert.match(api, /apiRequest<OwnLogoView>\('\/v1\/portal\/organisation\/logo'\)/);
  assert.match(api, /'\/v1\/portal\/organisation\/logo\/upload-url'/);
  assert.match(api, /'\/v1\/portal\/organisation\/logo\/complete'/);
  assert.match(api, /'\/v1\/portal\/organisation\/logo', \{ method: 'DELETE' \}/);
  // The pharmacy's routes never name a branch: the server takes it from the session.
  const ownBlock = api.slice(api.indexOf('export function getOwnLogo'), api.indexOf('export function removeOrganisationLogo'));
  assert.doesNotMatch(ownBlock, /organisationId/);
});

test('the Logo card prepares the image first, and Demo mode never uploads', () => {
  const card = read('../src/components/PharmacyLogoCard.tsx');
  assert.match(card, /normalisePharmacyLogo\(file\)/);
  const sandboxBranch = card.slice(card.indexOf('if (sandbox) {'), card.indexOf('} else {', card.indexOf('if (sandbox) {')));
  assert.doesNotMatch(sandboxBranch, /uploadOwnLogo/);
  assert.match(card, /if \(!sandbox\) await removeOwnLogo\(\)/);
  assert.match(card, /if \(sandbox\) return;/, 'no server read in Demo mode or local preview');
});

test('Settings shows the Logo card in Assets, and the poster pack uses that logo', () => {
  const settings = read('../src/pages/PharmacySettings.tsx');
  assert.match(settings, /<PharmacyLogoCard[\s\S]*?sandbox=\{sandboxPortal\}[\s\S]*?onChange=\{setOwnLogoUrl\}/);
  assert.match(settings, /downloadPosterPack\(organisation, formUrl, ownLogoUrl\)/);
  assert.match(read('../src/utils/posterPackDownload.ts'), /branchLogo\(logoUrl\)/);
});
