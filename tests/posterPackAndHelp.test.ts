import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import QRCode from 'qrcode';
import { PDFDocument, PDFName, StandardFonts } from 'pdf-lib';
import { buildPosterPdfs, fitName, POSTER_TEMPLATES, posterImageType, wrapText } from '../src/utils/posterPack.ts';
import { POSTER_TEMPLATES_READY, posterPackAvailable } from '../src/utils/posterPackRules.ts';
import { HELP_TOPICS, ONBOARDING_INBOX, PHARMACY_FAQ, PHARMACY_GUIDES, searchFaq } from '../src/onboarding/pharmacyHelp.ts';
import { isSupportedPortalRelativePath } from '../packages/domain/portal-route.js';

const qrPng = () => QRCode.toBuffer('https://holistichealthhub.live/eligibility?token=abcdefghijklmnop', { width: 360, margin: 2 }).then(buffer => new Uint8Array(buffer));
// A 1x1 PNG, as an uploaded branch logo.
const tinyPng = Uint8Array.from(Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==', 'base64'));
/** Image objects in a PDF. */
function imageCount(pdf: PDFDocument) {
  return pdf.context.enumerateIndirectObjects().filter(([, object]) => {
    const dict = (object as { dict?: { get(name: unknown): unknown } }).dict;
    return String(dict?.get(PDFName.of('Subtype'))) === '/Image';
  }).length;
}

const templates = {
  poster: new Uint8Array(readFileSync(new URL('../public/posters/hhh-poster-a3.pdf', import.meta.url))),
  leaflet: new Uint8Array(readFileSync(new URL('../public/posters/hhh-leaflet-a5.pdf', import.meta.url))),
};

test('the poster pack is switched on in Settings', () => {
  assert.equal(POSTER_TEMPLATES_READY, true);
  const settings = readFileSync(new URL('../src/pages/PharmacySettings.tsx', import.meta.url), 'utf8');
  assert.match(settings, /POSTER_TEMPLATES_READY \|\| isLocalPortalPreview/);
  assert.match(settings, /An A3 poster and a two-sided A5 leaflet/);
});

test('posters are offered from Awaiting Curaleaf onwards, while the eligibility link works', () => {
  for (const status of ['onboarding', 'intake_live', 'live']) assert.equal(posterPackAvailable(status), true, status);
  for (const status of ['paused', 'on_hold', undefined, null]) assert.equal(posterPackAvailable(status), false, String(status));
});

test('the pack is HHH\'s A3 poster and two-sided A5 leaflet, stamped, at the templates\' own sizes', async () => {
  const files = await buildPosterPdfs({ pharmacyName: 'Carlton Pharmacy', qr: await qrPng(), logo: { bytes: tinyPng, type: 'png' }, templates });
  assert.deepEqual(files.map(file => file.filename), ['a3-poster.pdf', 'a5-leaflet.pdf']);
  for (const [index, file] of files.entries()) {
    const pdf = await PDFDocument.load(file.bytes);
    const template = POSTER_TEMPLATES[index]!;
    assert.equal(pdf.getPageCount(), template.pages.length, file.filename);
    for (const page of pdf.getPages()) {
      const box = page.getMediaBox();
      assert.ok(Math.abs(box.width - template.mediaBox.width) < 1 && Math.abs(box.y - template.mediaBox.y) < 1, `${file.filename} page box`);
    }
    assert.match(pdf.getTitle() ?? '', /Carlton Pharmacy/);
    const added = imageCount(pdf) - imageCount(await PDFDocument.load(templates[template.id]));
    assert.ok(added >= 2, `${file.filename} adds the QR and the logo (PNG transparency masks count as images too)`);
  }
});

test('the QR and logo slots sit inside each page', () => {
  for (const template of POSTER_TEMPLATES) {
    const { x, y, width, height } = template.mediaBox;
    for (const slots of template.pages) {
      for (const box of [slots.qr, slots.logo].filter(Boolean)) {
        assert.ok(box!.x >= x && box!.y >= y && box!.x + box!.width <= x + width && box!.y + box!.height <= y + height, template.id);
      }
    }
  }
  assert.ok(POSTER_TEMPLATES.find(template => template.id === 'leaflet')!.pages[1]!.qr === null, 'the leaflet back has no QR');
});

test('a template whose page size has changed is refused, not stamped in the wrong place', async () => {
  const resized = await PDFDocument.create();
  resized.addPage([595.28, 841.89]);
  await assert.rejects(
    buildPosterPdfs({ pharmacyName: 'Carlton Pharmacy', qr: await qrPng(), templates: { ...templates, poster: await resized.save() } }),
    /page box has changed|pages, not/,
  );
});

test('without a usable logo the pharmacy name is printed, and a broken logo does not stop the pack', async () => {
  const svg = new TextEncoder().encode('<svg xmlns="http://www.w3.org/2000/svg"/>');
  assert.equal(posterImageType(svg), null);
  assert.equal(posterImageType(tinyPng), 'png');
  assert.equal(posterImageType(Uint8Array.from([0xff, 0xd8, 0xff, 0xe0, 0, 0])), 'jpg');
  assert.equal((await buildPosterPdfs({ pharmacyName: 'A Very Long Pharmacy Name That Has To Wrap Onto More Than One Line', qr: await qrPng(), logo: null, templates })).length, 2);
  const broken = await buildPosterPdfs({ pharmacyName: 'Carlton Pharmacy', qr: await qrPng(), logo: { bytes: Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 1, 2, 3, 4, 5]), type: 'png' }, templates });
  assert.equal(broken.length, 2);
});

test('the name fits the logo box in at most three lines', async () => {
  const pdf = await PDFDocument.create();
  const font = await pdf.embedFont(StandardFonts.HelveticaBold);
  const box = { width: 81.8, height: 39.9 };
  for (const name of ['Boots', 'Carlton Road Pharmacy', 'The Very Long Name Community Pharmacy and Wellbeing Centre Ltd']) {
    const { size, lines } = fitName(name, font, box);
    assert.ok(lines.length >= 1 && lines.length <= 3, name);
    assert.ok(lines.length * size * 1.15 <= box.height + 0.01, `${name} height`);
    for (const line of lines) assert.ok(font.widthOfTextAtSize(line, size) <= box.width + 0.01, `${name}: ${line}`);
  }
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
