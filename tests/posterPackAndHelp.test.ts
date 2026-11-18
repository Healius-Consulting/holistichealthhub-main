import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import QRCode from 'qrcode';
import { PDFDocument, StandardFonts } from 'pdf-lib';
import { buildPosterPdfs, POSTER_FORMATS, posterImageType, wrapText } from '../src/utils/posterPack.ts';
import { POSTER_COPY, POSTER_TEMPLATES_READY, posterPackAvailable } from '../src/utils/posterPackRules.ts';
import { HELP_TOPICS, ONBOARDING_INBOX, PHARMACY_FAQ, PHARMACY_GUIDES, searchFaq } from '../src/onboarding/pharmacyHelp.ts';
import { isSupportedPortalRelativePath } from '../packages/domain/portal-route.js';

const MM = 72 / 25.4;
const qrPng = () => QRCode.toBuffer('https://holistichealthhub.live/eligibility?token=abcdefghijklmnop', { width: 360, margin: 2 }).then(buffer => new Uint8Array(buffer));
// A 1x1 PNG, as an uploaded branch logo.
const tinyPng = Uint8Array.from(Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==', 'base64'));

test('the poster pack stays off until HHH supplies its templates and wording', () => {
  assert.equal(POSTER_TEMPLATES_READY, false);
  assert.match(POSTER_COPY.headline, /to be supplied by HHH/);
  const settings = readFileSync(new URL('../src/pages/PharmacySettings.tsx', import.meta.url), 'utf8');
  assert.match(settings, /POSTER_TEMPLATES_READY \|\| isLocalPortalPreview/);
  assert.match(settings, /Coming soon/);
});

test('posters are offered from Awaiting Curaleaf onwards, while the eligibility link works', () => {
  for (const status of ['onboarding', 'intake_live', 'live']) assert.equal(posterPackAvailable(status), true, status);
  for (const status of ['paused', 'not_available', undefined, null]) assert.equal(posterPackAvailable(status), false, String(status));
});

test('the pack is an A4 poster, an A5 leaflet and an A6 counter card, one page each at paper size', async () => {
  const files = await buildPosterPdfs({ pharmacyName: 'Carlton Pharmacy', address: '1 High Street, Leeds LS1 1AA', primary: '#0f766e', qr: await qrPng(), logo: { bytes: tinyPng, type: 'png' } });
  assert.deepEqual(files.map(file => file.filename), ['a4-poster.pdf', 'a5-leaflet.pdf', 'a6-counter-card.pdf']);
  for (const [index, file] of files.entries()) {
    const pdf = await PDFDocument.load(file.bytes);
    assert.equal(pdf.getPageCount(), 1);
    const { width, height } = pdf.getPage(0).getSize();
    assert.ok(Math.abs(width - POSTER_FORMATS[index].widthMm * MM) < 0.5, `${file.filename} width`);
    assert.ok(Math.abs(height - POSTER_FORMATS[index].heightMm * MM) < 0.5, `${file.filename} height`);
    assert.match(pdf.getTitle() ?? '', /Carlton Pharmacy/);
  }
});

test('without a usable logo the poster prints the pharmacy name, and a bad colour falls back', async () => {
  const svg = new TextEncoder().encode('<svg xmlns="http://www.w3.org/2000/svg"/>');
  assert.equal(posterImageType(svg), null);
  assert.equal(posterImageType(tinyPng), 'png');
  assert.equal(posterImageType(Uint8Array.from([0xff, 0xd8, 0xff, 0xe0, 0, 0])), 'jpg');
  const files = await buildPosterPdfs({ pharmacyName: 'A Very Long Pharmacy Name That Has To Wrap Onto More Than One Line', address: '', primary: 'teal', qr: await qrPng(), logo: null });
  assert.equal(files.length, 3);
  // A broken logo file doesn't stop the pack either.
  const broken = await buildPosterPdfs({ pharmacyName: 'Carlton Pharmacy', address: '', primary: '#0f766e', qr: await qrPng(), logo: { bytes: Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 1, 2, 3, 4, 5]), type: 'png' } });
  assert.equal(broken.length, 3);
});

test('text wraps to the width and drops characters the PDF font cannot print', async () => {
  const pdf = await PDFDocument.create();
  const font = await pdf.embedFont(StandardFonts.Helvetica);
  const lines = wrapText('Scan → here 🌿 to check your eligibility today', font, 12, 90);
  assert.ok(lines.length > 1);
  for (const line of lines) {
    assert.ok(font.widthOfTextAtSize(line, 12) <= 90 || !line.includes(' '), line);
    assert.doesNotMatch(line, /[→🌿]/u);
  }
});

test('the Help page has a route, a nav entry and a header title', () => {
  assert.equal(isSupportedPortalRelativePath('pharmacy', '/help'), true);
  const nav = readFileSync(new URL('../src/components/Navigation.tsx', import.meta.url), 'utf8');
  assert.match(nav, /key: 'help'/);
  const header = readFileSync(new URL('../src/components/Header.tsx', import.meta.url), 'utf8');
  assert.match(header, /help: 'Help'/);
  const app = readFileSync(new URL('../src/App.tsx', import.meta.url), 'utf8');
  assert.match(app, /case 'help': return <PharmacyHelp \/>/);
});

test('every FAQ entry is unique, in a known topic, and every topic has questions', () => {
  const ids = PHARMACY_FAQ.map(item => item.id);
  assert.equal(new Set(ids).size, ids.length);
  const topics = new Set(HELP_TOPICS.map(topic => topic.id));
  for (const item of PHARMACY_FAQ) assert.ok(topics.has(item.topic), item.id);
  for (const topic of topics) assert.ok(PHARMACY_FAQ.some(item => item.topic === topic), topic);
  assert.ok(PHARMACY_FAQ.some(item => item.answer.includes(ONBOARDING_INBOX)));
});

test('the FAQ search matches every word, in list order, and an empty search shows everything', () => {
  assert.equal(searchFaq('').length, PHARMACY_FAQ.length);
  assert.deepEqual(searchFaq('WORLDPAY form').map(item => item.id), ['worldpay']);
  assert.deepEqual(searchFaq('demo').map(item => item.id).slice(0, 1), ['demo-mode']);
  assert.deepEqual(searchFaq('zebra crossing'), []);
});

test('the guides link to files that ship with the site', () => {
  for (const guide of PHARMACY_GUIDES) {
    assert.ok(guide.href.startsWith('/'), guide.href);
    assert.doesNotThrow(() => readFileSync(new URL(`../public${guide.href}`, import.meta.url)), guide.href);
  }
});
