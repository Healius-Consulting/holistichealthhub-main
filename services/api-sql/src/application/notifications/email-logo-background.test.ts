import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { deflateSync } from 'node:zlib';
import { DEFAULT_EMAIL_HEADER_BACKGROUND, decodeLogoPng, emailHeaderBackgroundForLogo } from './email-logo-background.js';
import { renderEmailTemplate } from './email-renderer.js';

type Rgba = [number, number, number, number];

function chunk(type: string, body: Buffer) {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(body.length);
  return Buffer.concat([length, Buffer.from(type, 'latin1'), body, Buffer.alloc(4)]);
}

/** A 16×8 RGBA PNG: `edge` around a 2px border, `ink` inside, rows Sub-filtered to exercise unfiltering. */
function logoPng(edge: Rgba, ink: Rgba) {
  const width = 16;
  const height = 8;
  const raw: number[] = [];
  for (let y = 0; y < height; y += 1) {
    raw.push(1);
    let previous: Rgba = [0, 0, 0, 0];
    for (let x = 0; x < width; x += 1) {
      const inside = x >= 2 && x < width - 2 && y >= 2 && y < height - 2;
      const pixel = inside ? ink : edge;
      raw.push(...pixel.map((channel, index) => (channel - (previous[index] ?? 0) + 256) & 0xff));
      previous = pixel;
    }
  }
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header[8] = 8;
  header[9] = 6;
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk('IHDR', header),
    chunk('IDAT', deflateSync(Buffer.from(raw))),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

const transparent: Rgba = [255, 255, 255, 0];

describe('email header background for a pharmacy logo', () => {
  it('decodes filtered rows back to the original pixels', () => {
    const decoded = decodeLogoPng(logoPng(transparent, [30, 110, 70, 255]));
    assert.ok(decoded);
    const index = (3 * decoded.width + 5) * 4;
    assert.deepEqual([...decoded.pixels.slice(index, index + 4)], [30, 110, 70, 255]);
  });

  it('puts a green mark whose white background was removed back on white', () => {
    assert.equal(emailHeaderBackgroundForLogo(logoPng(transparent, [30, 110, 70, 255])), '#ffffff');
  });

  it('keeps the dark green header for a light mark', () => {
    assert.equal(emailHeaderBackgroundForLogo(logoPng(transparent, [250, 250, 250, 255])), DEFAULT_EMAIL_HEADER_BACKGROUND);
  });

  it('matches a logo that still carries its own solid background', () => {
    assert.equal(emailHeaderBackgroundForLogo(logoPng([20, 40, 120, 255], [255, 255, 255, 255])), '#142878');
  });

  it('falls back to the default for bytes it cannot read', () => {
    assert.equal(emailHeaderBackgroundForLogo(Buffer.from('not a png')), DEFAULT_EMAIL_HEADER_BACKGROUND);
  });

  it('paints the pharmacy header with the chosen colour and ignores malformed values', () => {
    const base = {
      firstName: 'Avery',
      orderNumber: 'ORD-1',
      pharmacyName: 'Hartwell Pharmacy',
      organisationId: '6d0176bb-89a0-4e32-9bce-c934c9557c42',
      hasBrandLogo: 'true',
    };
    const light = renderEmailTemplate('patient_referred', { ...base, brandHeaderBackground: '#ffffff' });
    assert.match(light.html, /border-bottom:1px solid #e1e8e6; background:#ffffff;/);
    const injected = renderEmailTemplate('patient_referred', { ...base, brandHeaderBackground: 'red;position:fixed' });
    assert.match(injected.html, /background:#123f36;/);
    assert.doesNotMatch(injected.html, /position:fixed/);
  });
});
