import assert from 'node:assert/strict';
import test from 'node:test';
import {
  imageHasTransparency,
  knockoutEdgeBackground,
  sampleCornerBackground,
} from '../src/utils/pharmacyLogo.ts';

function rgba(width: number, height: number, fill: [number, number, number, number]) {
  const pixels = new Uint8ClampedArray(width * height * 4);
  for (let index = 0; index < pixels.length; index += 4) {
    pixels[index] = fill[0];
    pixels[index + 1] = fill[1];
    pixels[index + 2] = fill[2];
    pixels[index + 3] = fill[3];
  }
  return pixels;
}

function setPixel(pixels: Uint8ClampedArray, width: number, x: number, y: number, fill: [number, number, number, number]) {
  const index = (y * width + x) * 4;
  pixels[index] = fill[0];
  pixels[index + 1] = fill[1];
  pixels[index + 2] = fill[2];
  pixels[index + 3] = fill[3];
}

test('a white JPEG-style frame around a mark becomes transparent', () => {
  const width = 5;
  const height = 5;
  const pixels = rgba(width, height, [255, 255, 255, 255]);
  setPixel(pixels, width, 2, 2, [16, 80, 64, 255]);
  const { background, consistent } = sampleCornerBackground(pixels, width, height);
  assert.equal(consistent, true);
  knockoutEdgeBackground(pixels, width, height, background);
  assert.equal(pixels[3], 0);
  assert.equal(pixels[((2 * width) + 2) * 4 + 3], 255);
  assert.equal(imageHasTransparency(pixels), true);
});

test('white inside a closed colour shape is kept, because it is not connected to the edge', () => {
  const width = 5;
  const height = 5;
  const pixels = rgba(width, height, [255, 255, 255, 255]);
  for (const [x, y] of [[1, 1], [2, 1], [3, 1], [1, 2], [3, 2], [1, 3], [2, 3], [3, 3]]) {
    setPixel(pixels, width, x, y, [16, 80, 64, 255]);
  }
  setPixel(pixels, width, 2, 2, [255, 255, 255, 255]);
  const { background } = sampleCornerBackground(pixels, width, height);
  knockoutEdgeBackground(pixels, width, height, background);
  assert.equal(pixels[((2 * width) + 2) * 4 + 3], 255);
  assert.equal(pixels[3], 0);
});

test('a solid block that matches the corners is left alone', () => {
  const pixels = rgba(3, 3, [240, 240, 240, 255]);
  const { background } = sampleCornerBackground(pixels, 3, 3);
  assert.equal(knockoutEdgeBackground(pixels, 3, 3, background), 0);
  assert.equal(pixels[3], 255);
});
