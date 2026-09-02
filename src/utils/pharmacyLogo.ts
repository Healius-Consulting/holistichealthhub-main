const EMAIL_LOGO_WIDTH = 640;
const EMAIL_LOGO_HEIGHT = 192;
const EMAIL_LOGO_PADDING = 12;
const MAX_SOURCE_BYTES = 8_000_000;
const ALPHA_SCAN_MAX_DIMENSION = 2048;
const VISIBLE_ALPHA_THRESHOLD = 8;
const INK_ALPHA_THRESHOLD = 96;
const INK_BOUNDS_PAD = 2;
const BACKGROUND_CHANNEL_TOLERANCE = 18;
const TRANSPARENT_PIXEL_RATIO = 0.02;
const KNOCKOUT_ABORT_RATIO = 0.97;
const ACCEPTED_TYPES = new Set(['image/png', 'image/jpeg', 'image/webp']);

export type Rgba = readonly [number, number, number, number];

function outputName(filename: string) {
  const stem = filename.replace(/\.[^.]+$/, '').replace(/[^a-z0-9_-]+/gi, '-').replace(/^-|-$/g, '') || 'pharmacy';
  return `${stem}-email-logo.png`;
}

export function pixelMatchesBackground(pixels: Uint8ClampedArray, index: number, background: Rgba, tolerance = BACKGROUND_CHANNEL_TOLERANCE) {
  return [0, 1, 2, 3].every(channel => Math.abs(pixels[index + channel] - background[channel]) <= tolerance);
}

export function sampleCornerBackground(pixels: Uint8ClampedArray, width: number, height: number) {
  const cornerIndexes = [
    0,
    (width - 1) * 4,
    ((height - 1) * width) * 4,
    ((height * width) - 1) * 4,
  ];
  const background = [0, 1, 2, 3].map(channel => (
    cornerIndexes.reduce((total, index) => total + pixels[index + channel], 0) / cornerIndexes.length
  )) as unknown as [number, number, number, number];
  const consistent = cornerIndexes.every(index => pixelMatchesBackground(pixels, index, background));
  return { background, consistent };
}

export function imageHasTransparency(pixels: Uint8ClampedArray) {
  let transparent = 0;
  for (let index = 3; index < pixels.length; index += 4) {
    if (pixels[index] <= VISIBLE_ALPHA_THRESHOLD) transparent += 1;
  }
  return transparent / (pixels.length / 4) >= TRANSPARENT_PIXEL_RATIO;
}

function neighbours(x: number, y: number, width: number, height: number) {
  const next: Array<[number, number]> = [];
  if (x > 0) next.push([x - 1, y]);
  if (x + 1 < width) next.push([x + 1, y]);
  if (y > 0) next.push([x, y - 1]);
  if (y + 1 < height) next.push([x, y + 1]);
  return next;
}

export function knockoutEdgeBackground(
  pixels: Uint8ClampedArray,
  width: number,
  height: number,
  background: Rgba,
  tolerance = BACKGROUND_CHANNEL_TOLERANCE,
) {
  const total = width * height;
  const snapshot = new Uint8ClampedArray(pixels);
  const visited = new Uint8Array(total);
  const stack: Array<[number, number]> = [];
  for (let x = 0; x < width; x += 1) {
    stack.push([x, 0], [x, height - 1]);
  }
  for (let y = 1; y < height - 1; y += 1) {
    stack.push([0, y], [width - 1, y]);
  }

  let knocked = 0;
  while (stack.length) {
    const [x, y] = stack.pop()!;
    const cell = y * width + x;
    if (visited[cell]) continue;
    visited[cell] = 1;
    const index = cell * 4;
    if (!pixelMatchesBackground(pixels, index, background, tolerance)) continue;
    pixels[index + 3] = 0;
    knocked += 1;
    stack.push(...neighbours(x, y, width, height));
  }

  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const index = (y * width + x) * 4;
      if (pixels[index + 3] <= VISIBLE_ALPHA_THRESHOLD) continue;
      if (!pixelMatchesBackground(pixels, index, background, tolerance + 8)) continue;
      const fringe = neighbours(x, y, width, height).some(([nx, ny]) => pixels[((ny * width) + nx) * 4 + 3] <= VISIBLE_ALPHA_THRESHOLD);
      if (!fringe) continue;
      pixels[index + 3] = 0;
      knocked += 1;
    }
  }

  if (knocked / total >= KNOCKOUT_ABORT_RATIO) {
    pixels.set(snapshot);
    return 0;
  }
  return knocked;
}

export function visibleBoundsFromPixels(pixels: Uint8ClampedArray, width: number, height: number, sourceWidth: number, sourceHeight: number) {
  const { background, consistent } = sampleCornerBackground(pixels, width, height);
  let left = width;
  let top = height;
  let right = -1;
  let bottom = -1;

  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const index = (y * width + x) * 4;
      if (pixels[index + 3] < INK_ALPHA_THRESHOLD) continue;
      if (consistent && background[3] >= INK_ALPHA_THRESHOLD && pixelMatchesBackground(pixels, index, background)) continue;
      left = Math.min(left, x);
      top = Math.min(top, y);
      right = Math.max(right, x);
      bottom = Math.max(bottom, y);
    }
  }

  if (right < left || bottom < top) throw new Error('The selected image does not contain a visible logo.');

  left = Math.max(0, left - INK_BOUNDS_PAD);
  top = Math.max(0, top - INK_BOUNDS_PAD);
  right = Math.min(width - 1, right + INK_BOUNDS_PAD);
  bottom = Math.min(height - 1, bottom + INK_BOUNDS_PAD);

  const scaleX = sourceWidth / width;
  const scaleY = sourceHeight / height;
  const x = Math.max(0, Math.floor(left * scaleX));
  const y = Math.max(0, Math.floor(top * scaleY));
  const rightEdge = Math.min(sourceWidth, Math.ceil((right + 1) * scaleX));
  const bottomEdge = Math.min(sourceHeight, Math.ceil((bottom + 1) * scaleY));
  return { x, y, width: rightEdge - x, height: bottomEdge - y };
}

function prepareSourceCanvas(bitmap: ImageBitmap) {
  const scanScale = Math.min(1, ALPHA_SCAN_MAX_DIMENSION / Math.max(bitmap.width, bitmap.height));
  const width = Math.max(1, Math.round(bitmap.width * scanScale));
  const height = Math.max(1, Math.round(bitmap.height * scanScale));
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const context = canvas.getContext('2d', { willReadFrequently: true });
  if (!context) return null;
  context.drawImage(bitmap, 0, 0, width, height);
  const image = context.getImageData(0, 0, width, height);
  if (!imageHasTransparency(image.data)) {
    const { background, consistent } = sampleCornerBackground(image.data, width, height);
    if (consistent && background[3] > VISIBLE_ALPHA_THRESHOLD) {
      knockoutEdgeBackground(image.data, width, height, background);
      context.putImageData(image, 0, 0);
    }
  }
  return { canvas, image, width, height };
}

export async function normalisePharmacyLogo(file: File) {
  if (!ACCEPTED_TYPES.has(file.type)) throw new Error('Choose a PNG, JPEG or WebP logo.');
  if (file.size > MAX_SOURCE_BYTES) throw new Error('The source logo must be smaller than 8 MB.');

  const bitmap = await createImageBitmap(file);
  try {
    if (!bitmap.width || !bitmap.height) throw new Error('The selected image has no usable dimensions.');
    const prepared = prepareSourceCanvas(bitmap);
    const source = prepared?.canvas ?? bitmap;
    const sourceWidth = prepared?.width ?? bitmap.width;
    const sourceHeight = prepared?.height ?? bitmap.height;
    const bounds = prepared
      ? visibleBoundsFromPixels(prepared.image.data, prepared.width, prepared.height, sourceWidth, sourceHeight)
      : { x: 0, y: 0, width: sourceWidth, height: sourceHeight };

    const canvas = document.createElement('canvas');
    canvas.width = EMAIL_LOGO_WIDTH;
    canvas.height = EMAIL_LOGO_HEIGHT;
    const context = canvas.getContext('2d');
    if (!context) throw new Error('This browser cannot prepare the logo.');

    context.clearRect(0, 0, canvas.width, canvas.height);
    const availableWidth = EMAIL_LOGO_WIDTH - EMAIL_LOGO_PADDING * 2;
    const availableHeight = EMAIL_LOGO_HEIGHT - EMAIL_LOGO_PADDING * 2;
    const scale = Math.min(availableWidth / bounds.width, availableHeight / bounds.height);
    const width = Math.max(1, Math.round(bounds.width * scale));
    const height = Math.max(1, Math.round(bounds.height * scale));
    const x = Math.round((EMAIL_LOGO_WIDTH - width) / 2);
    const y = Math.round((EMAIL_LOGO_HEIGHT - height) / 2);
    context.imageSmoothingEnabled = true;
    context.imageSmoothingQuality = 'high';
    context.drawImage(source, bounds.x, bounds.y, bounds.width, bounds.height, x, y, width, height);

    const blob = await new Promise<Blob>((resolve, reject) => {
      canvas.toBlob(result => result ? resolve(result) : reject(new Error('The logo could not be converted to PNG.')), 'image/png');
    });
    return new File([blob], outputName(file.name), { type: 'image/png', lastModified: Date.now() });
  } finally {
    bitmap.close();
  }
}

export const EMAIL_LOGO_SPEC = {
  assetWidth: EMAIL_LOGO_WIDTH,
  assetHeight: EMAIL_LOGO_HEIGHT,
  displayWidth: 480,
  displayHeight: 88,
} as const;
