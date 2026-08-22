import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { isOriginPermitted } from './app.js';
import { isOriginAllowed } from '../security/csrf.js';
import type { Request } from 'express';

function requestWith(headers: Record<string, string | undefined>): Request {
  return {
    get(name: string) {
      return headers[name.toLowerCase()];
    },
  } as Request;
}

describe('isOriginPermitted', () => {
  it('allows the live public and portal origins', () => {
    assert.equal(isOriginPermitted('https://holistichealthhub.cc'), true);
    assert.equal(isOriginPermitted('https://www.holistichealthhub.cc'), true);
    assert.equal(isOriginPermitted('https://portal.holistichealthhub.cc'), true);
    assert.equal(isOriginPermitted('https://holistichealthhub.live'), true);
    assert.equal(isOriginPermitted('https://www.holistichealthhub.live'), true);
    assert.equal(isOriginPermitted('https://portal.holistichealthhub.live'), true);
  });

  it('allows the printed pharmacy QR host', () => {
    assert.equal(isOriginPermitted('https://hhh.thinktimeless.co.uk'), true);
    assert.equal(isOriginPermitted('https://www.hhh.thinktimeless.co.uk'), true);
  });

  it('rejects a www sibling that is not the twin of an allowlisted host', () => {
    assert.equal(isOriginPermitted('https://www.evil.holistichealthhub.cc'), false);
    assert.equal(isOriginPermitted('https://www.portal.hhh.thinktimeless.co.uk'), false);
  });

  it('rejects sibling subdomains, retired staging, and preview hosts', () => {
    assert.equal(isOriginPermitted('https://evil.holistichealthhub.cc'), false);
    assert.equal(isOriginPermitted('https://portal.evil.holistichealthhub.cc'), false);
    assert.equal(isOriginPermitted('https://staging.thinktimeless.co.uk'), false);
    assert.equal(isOriginPermitted('https://portal.hhh.thinktimeless.co.uk'), false);
    assert.equal(isOriginPermitted('https://hhh-git-main.vercel.app'), false);
    assert.equal(isOriginPermitted('https://ha.thinktimeless.co.uk'), false);
    assert.equal(isOriginPermitted('https://thinktimeless.co.uk'), false);
    assert.equal(isOriginPermitted('https://evil.example'), false);
  });

  it('treats a missing origin as a non-browser client', () => {
    assert.equal(isOriginPermitted(undefined), true);
  });
});

describe('isOriginAllowed', () => {
  it('accepts the live portal origin and referer', () => {
    assert.equal(isOriginAllowed(requestWith({ origin: 'https://portal.holistichealthhub.cc' })), true);
    assert.equal(
      isOriginAllowed(requestWith({ referer: 'https://portal.holistichealthhub.cc/pharmacy' })),
      true,
    );
  });

  it('rejects a sibling subdomain even when the CSRF cookie would match', () => {
    assert.equal(isOriginAllowed(requestWith({ origin: 'https://evil.holistichealthhub.cc' })), false);
  });
});
