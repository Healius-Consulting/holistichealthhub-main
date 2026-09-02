import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const css = readFileSync(new URL('../src/index.css', import.meta.url), 'utf8');

test('the workspace locks document scroll and full-page views scroll themselves', () => {
  assert.match(css, /body\{[\s\S]*?overflow:\s*hidden;/);
  assert.match(css, /grid-template-rows:\s*minmax\(100%,\s*max-content\)/);
  assert.match(css, /\.staff-login-page \.staff-login-panel\{[\s\S]*?safe center/);
  assert.doesNotMatch(css, /\.staff-login-page\{[\s\S]{0,400}min-height:\s*100dvh;[\s\S]{0,80}height:\s*auto;/);
  assert.match(css, /\.payment-return-page\{[\s\S]*?height:\s*100%;[\s\S]*?overflow-y:\s*auto;[\s\S]*?safe center/);
});
