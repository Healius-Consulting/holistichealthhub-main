import { inflateSync } from 'node:zlib';

export const DEFAULT_EMAIL_HEADER_BACKGROUND = '#123f36';
const LIGHT_EMAIL_HEADER_BACKGROUND = '#ffffff';
const PNG_SIGNATURE = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
const OPAQUE_ALPHA = 250;
const INK_ALPHA = 96;
const CORNER_TOLERANCE = 18;

type Rgba = [number, number, number, number];
type DecodedPng = { width: number; height: number; pixels: Uint8Array };

function byte(source: Uint8Array, index: number) {
  return source[index] ?? 0;
}

function paeth(left: number, up: number, upLeft: number) {
  const estimate = left + up - upLeft;
  const toLeft = Math.abs(estimate - left);
  const toUp = Math.abs(estimate - up);
  const toUpLeft = Math.abs(estimate - upLeft);
  if (toLeft <= toUp && toLeft <= toUpLeft) return left;
  return toUp <= toUpLeft ? up : upLeft;
}

/**
 * Enough of PNG for the logos this service stores: 8-bit RGB or RGBA, not
 * interlaced, which is what a browser canvas exports. Anything else returns null
 * and the header keeps its default colour.
 */
export function decodeLogoPng(bytes: Buffer): DecodedPng | null {
  if (bytes.length < 33 || !bytes.subarray(0, 8).equals(PNG_SIGNATURE)) return null;
  let offset = 8;
  let width = 0;
  let height = 0;
  let channels = 0;
  const data: Buffer[] = [];
  while (offset + 8 <= bytes.length) {
    const length = bytes.readUInt32BE(offset);
    const type = bytes.toString('latin1', offset + 4, offset + 8);
    const body = bytes.subarray(offset + 8, offset + 8 + length);
    if (type === 'IHDR') {
      width = body.readUInt32BE(0);
      height = body.readUInt32BE(4);
      const bitDepth = body[8];
      const colourType = body[9];
      const interlace = body[12];
      if (bitDepth !== 8 || interlace !== 0) return null;
      if (colourType === 6) channels = 4;
      else if (colourType === 2) channels = 3;
      else return null;
    } else if (type === 'IDAT') {
      data.push(body);
    } else if (type === 'IEND') {
      break;
    }
    offset += 12 + length;
  }
  if (!width || !height || !channels || !data.length) return null;

  let raw: Buffer;
  try {
    raw = inflateSync(Buffer.concat(data));
  } catch {
    return null;
  }
  const stride = width * channels;
  if (raw.length < (stride + 1) * height) return null;

  const rows = new Uint8Array(stride * height);
  for (let y = 0; y < height; y += 1) {
    const filter = byte(raw, y * (stride + 1));
    const source = y * (stride + 1) + 1;
    const target = y * stride;
    for (let x = 0; x < stride; x += 1) {
      const value = byte(raw, source + x);
      const left = x >= channels ? byte(rows, target + x - channels) : 0;
      const up = y > 0 ? byte(rows, target - stride + x) : 0;
      const upLeft = y > 0 && x >= channels ? byte(rows, target - stride + x - channels) : 0;
      let decoded: number;
      if (filter === 0) decoded = value;
      else if (filter === 1) decoded = value + left;
      else if (filter === 2) decoded = value + up;
      else if (filter === 3) decoded = value + ((left + up) >> 1);
      else if (filter === 4) decoded = value + paeth(left, up, upLeft);
      else return null;
      rows[target + x] = decoded & 0xff;
    }
  }

  if (channels === 4) return { width, height, pixels: rows };
  const pixels = new Uint8Array(width * height * 4);
  for (let index = 0, out = 0; index < rows.length; index += 3, out += 4) {
    pixels[out] = byte(rows, index);
    pixels[out + 1] = byte(rows, index + 1);
    pixels[out + 2] = byte(rows, index + 2);
    pixels[out + 3] = 255;
  }
  return { width, height, pixels };
}

function hex([red, green, blue]: Rgba | [number, number, number]) {
  return `#${[red, green, blue].map(channel => Math.round(channel).toString(16).padStart(2, '0')).join('')}`;
}

function luminance(red: number, green: number, blue: number) {
  const linear = (channel: number) => {
    const value = channel / 255;
    return value <= 0.03928 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * linear(red) + 0.7152 * linear(green) + 0.0722 * linear(blue);
}

function contrast(left: number, right: number) {
  return (Math.max(left, right) + 0.05) / (Math.min(left, right) + 0.05);
}

function hexLuminance(value: string) {
  const channel = (start: number) => Number.parseInt(value.slice(start, start + 2), 16);
  return luminance(channel(1), channel(3), channel(5));
}

/** True when the header colour is light enough that its border and fallback text must go dark. */
export function isLightEmailHeader(background: string) {
  return hexLuminance(background) > 0.5;
}

/**
 * The header colour that lets a pharmacy's logo sit as it was designed.
 *
 * A logo kept on a solid background gets exactly that colour, so the banner reads
 * as one piece. A logo whose background was removed at upload no longer says what
 * it sat on, so the header takes whichever of white or the default dark green the
 * artwork contrasts with more: a green-on-white mark goes back on white, and a
 * white mark stays on green.
 */
export function emailHeaderBackgroundForLogo(bytes: Buffer): string {
  const decoded = decodeLogoPng(bytes);
  if (!decoded) return DEFAULT_EMAIL_HEADER_BACKGROUND;
  const { width, height, pixels } = decoded;
  const at = (x: number, y: number): Rgba => {
    const index = (y * width + x) * 4;
    return [byte(pixels, index), byte(pixels, index + 1), byte(pixels, index + 2), byte(pixels, index + 3)];
  };
  const corners = [at(0, 0), at(width - 1, 0), at(0, height - 1), at(width - 1, height - 1)];
  const cornersOpaque = corners.every(pixel => pixel[3] >= OPAQUE_ALPHA);
  if (cornersOpaque) {
    const mean = (channel: 0 | 1 | 2) => corners.reduce((total, pixel) => total + pixel[channel], 0) / corners.length;
    const average: [number, number, number] = [mean(0), mean(1), mean(2)];
    const consistent = corners.every(pixel => ([0, 1, 2] as const).every(channel => Math.abs(pixel[channel] - average[channel]) <= CORNER_TOLERANCE));
    if (consistent) return hex(average);
  }

  let weight = 0;
  let inkLuminance = 0;
  for (let index = 0; index < pixels.length; index += 4) {
    const alpha = byte(pixels, index + 3);
    if (alpha < INK_ALPHA) continue;
    weight += alpha;
    inkLuminance += luminance(byte(pixels, index), byte(pixels, index + 1), byte(pixels, index + 2)) * alpha;
  }
  if (!weight) return DEFAULT_EMAIL_HEADER_BACKGROUND;
  const ink = inkLuminance / weight;
  const onDark = contrast(ink, hexLuminance(DEFAULT_EMAIL_HEADER_BACKGROUND));
  const onLight = contrast(ink, hexLuminance(LIGHT_EMAIL_HEADER_BACKGROUND));
  return onLight > onDark ? LIGHT_EMAIL_HEADER_BACKGROUND : DEFAULT_EMAIL_HEADER_BACKGROUND;
}
