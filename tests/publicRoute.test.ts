import assert from 'node:assert/strict';
import test from 'node:test';
import { canonicalEligibilityRedirect, parsePublicReceiptHash, publicHeaderVariant, resolvePublicView } from '../apps/public/src/publicRoute.ts';

test('legacy pharmacy QR URLs open the eligibility form from the public root', () => {
  assert.equal(
    resolvePublicView('/', '?mode=eligibility&token=bbd8fc4749934797a49398c0b95e68cf873d4868c33c42a2949d6f65359d44c5'),
    'eligibility',
  );
  assert.equal(resolvePublicView('///', '?token=value&mode=eligibility'), 'eligibility');
});

test('the canonical eligibility path and payment return paths retain their views', () => {
  assert.equal(resolvePublicView('/eligibility', ''), 'eligibility');
  assert.equal(resolvePublicView('/eligibility', '?token=value'), 'eligibility');
  assert.equal(resolvePublicView('/payments/complete', ''), 'payment-complete');
  assert.equal(resolvePublicView('/payment/success', ''), 'payment-complete');
  assert.equal(resolvePublicView('/payments/cancelled/', ''), 'payment-cancelled');
  assert.equal(resolvePublicView('/payment/cancelled', ''), 'payment-cancelled');
});

test('patient payment receipt hashes open the receipt view', () => {
  const hash = '6a68fcc99544d3ba835649c1ae690b8b6aeb4be84e9748180251d427a036cf8a';
  assert.equal(resolvePublicView(`/receipt/${hash}`, ''), 'receipt');
  assert.equal(resolvePublicView(`/receipt/${hash}/`, ''), 'receipt');
  assert.equal(parsePublicReceiptHash(`/receipt/${hash}`), hash);
  assert.equal(parsePublicReceiptHash('/receipt/not-a-hash'), null);
  assert.equal(resolvePublicView('/receipt/short', ''), 'site');
  assert.equal(resolvePublicView('/receipt/', ''), 'site');
});

test('unknown root modes remain on the public site', () => {
  assert.equal(resolvePublicView('/', '?mode=other&token=value'), 'site');
  assert.equal(resolvePublicView('/about', '?mode=eligibility'), 'site');
});

test('retired .cc eligibility URLs canonicalise onto the brand domain without changing pharmacy tokens', () => {
  assert.equal(
    canonicalEligibilityRedirect(
      'holistichealthhub.cc',
      '/',
      '?mode=eligibility&token=bbd8fc4749934797a49398c0b95e68cf873d4868c33c42a2949d6f65359d44c5',
    ),
    'https://holistichealthhub.live/eligibility?token=bbd8fc4749934797a49398c0b95e68cf873d4868c33c42a2949d6f65359d44c5',
  );
  assert.equal(
    canonicalEligibilityRedirect('holistichealthhub.cc', '/eligibility', '?token=eastwood&source=qr&postcode=SW1A1AA&email=person%40example.com&utm_campaign=poster'),
    'https://holistichealthhub.live/eligibility?token=eastwood&source=qr&utm_campaign=poster',
  );
});

test('all protected production tokens retain every supported URL shape', () => {
  const tokens = [
    '3509a44084ab461aa9aafe603047e9add4e6e7a51e214e40b830753202b7131d',
    '0a93ebde7ab143cfafd7c2a34329b3587148fb1ff9fb4e6fbf02f517fac05d30',
    'bbd8fc4749934797a49398c0b95e68cf873d4868c33c42a2949d6f65359d44c5',
    '68e83b76e7824084997d97b5d2159e1840aefdb4d26f4d5c81b0aed86844f83a',
  ];
  for (const token of tokens) {
    assert.equal(resolvePublicView('/', `?mode=eligibility&token=${token}`), 'eligibility');
    assert.equal(resolvePublicView('/eligibility', `?token=${token}`), 'eligibility');
    assert.equal(canonicalEligibilityRedirect('holistichealthhub.cc', '/eligibility', `?token=${token}`), `https://holistichealthhub.live/eligibility?token=${token}`);
  }
  for (const token of ['kchem-7x4p9k', 'eastwood-3m8q2v']) assert.equal(resolvePublicView('/eligibility', `?token=${token}`), 'eligibility');
});

test('printed thinktimeless stone URLs with a second ? still open eligibility', () => {
  const stone = '?mode=eligibility?token=eastwood-3m8q2v';
  assert.equal(resolvePublicView('/', stone), 'eligibility');
  assert.equal(
    canonicalEligibilityRedirect('hhh.thinktimeless.co.uk', '/', stone),
    'https://holistichealthhub.live/eligibility?token=eastwood-3m8q2v',
  );
});

test('the exact printed Eastwood and K-Chem URLs redirect onto holistichealthhub.live', () => {
  const links = [
    'bbd8fc4749934797a49398c0b95e68cf873d4868c33c42a2949d6f65359d44c5',
    '0a93ebde7ab143cfafd7c2a34329b3587148fb1ff9fb4e6fbf02f517fac05d30',
  ];
  for (const token of links) {
    const search = `?mode=eligibility&token=${token}`;
    assert.equal(resolvePublicView('/', search), 'eligibility');
    assert.equal(
      canonicalEligibilityRedirect('hhh.thinktimeless.co.uk', '/', search),
      `https://holistichealthhub.live/eligibility?token=${token}`,
    );
  }
});

test('the shared public header stays in marketing mode except on pharmacy token links', () => {
  assert.equal(publicHeaderVariant('/about', ''), 'site');
  assert.equal(publicHeaderVariant('/eligibility', ''), 'eligibility');
  assert.equal(publicHeaderVariant('/eligibility', '?token=eastwood-3m8q2v'), 'token');
});

test('the canonical and unrelated public hosts never redirect themselves', () => {
  assert.equal(canonicalEligibilityRedirect('holistichealthhub.live', '/eligibility', '?token=value'), null);
  assert.equal(canonicalEligibilityRedirect('www.holistichealthhub.live', '/', '?mode=eligibility?token=eastwood-3m8q2v'), null);
  assert.equal(canonicalEligibilityRedirect('holistichealthhub.cc', '/about', '?token=value'), null);
  assert.equal(canonicalEligibilityRedirect('holistichealthhub.cc', '/eligibility', ''), null);
});

// `.cc` remains an attachable Vercel host for preview/flicker testing. Only its
// tokenised eligibility links canonicalise; every other path is left alone so the
// host keeps serving whatever deployment it is attached to.
test('only tokenised eligibility links are canonicalised away from the .cc flicker host', () => {
  assert.equal(canonicalEligibilityRedirect('holistichealthhub.cc', '/', '?mode=eligibility'), null);
  assert.equal(canonicalEligibilityRedirect('holistichealthhub.cc', '/faq', ''), null);
  assert.equal(canonicalEligibilityRedirect('portal.holistichealthhub.cc', '/eligibility', '?token=value'), null);
});
