import assert from 'node:assert/strict';
import test from 'node:test';

import type { UpsertPrescriberInput } from '../../repositories/ports/prescription.port.js';
import {
  recordVerifiedPrescriberInDirectory,
  verifiedPrescriberDirectoryInput,
} from './verified-prescriber-directory.js';

test('verified directory input requires a name, PIN, and at least one regulator number', () => {
  assert.equal(verifiedPrescriberDirectoryInput({
    name: 'Dr Example',
    pin: '1234',
  }), null);
  assert.equal(verifiedPrescriberDirectoryInput({
    name: 'Dr Example',
    gmcNumber: 1234567,
  }), null);
  assert.equal(verifiedPrescriberDirectoryInput({
    pin: '1234',
    gmcNumber: 1234567,
  }), null);
  assert.deepEqual(verifiedPrescriberDirectoryInput({
    name: 'Dr Example',
    pin: '1234',
    gmcNumber: 1234567,
  }), {
    name: 'Dr Example',
    initials: 'DE',
    pin: '1234',
    gmcNumber: 1234567,
    gphcNumber: null,
    createdByUid: null,
  });
  assert.equal(verifiedPrescriberDirectoryInput({
    name: 'Dr Example',
    initials: 'DX',
    pin: '1234',
    gphcNumber: 'GPhC123',
  })?.gphcNumber, 'GPhC123');
});

test('verified directory upsert is called with the mapped payload', async () => {
  const upserts: UpsertPrescriberInput[] = [];
  assert.equal(await recordVerifiedPrescriberInDirectory({
    upsertPrescriber: async input => {
      upserts.push(input);
      return {
        id: 'pr-1',
        name: input.name,
        initials: input.initials,
        pin: input.pin,
        gmcNumber: input.gmcNumber,
        gphcNumber: input.gphcNumber,
        active: true,
      };
    },
  }, {
    name: 'Dr Example',
    pin: '1234',
    gmcNumber: 1234567,
  }), 'saved');
  assert.equal(upserts.length, 1);
  assert.equal(upserts[0]?.pin, '1234');
});

test('verified directory upsert skips incomplete Curaleaf records', async () => {
  let called = false;
  assert.equal(await recordVerifiedPrescriberInDirectory({
    upsertPrescriber: async () => {
      called = true;
      throw new Error('should not run');
    },
  }, { name: 'Dr Example', pin: '1234' }), 'skipped');
  assert.equal(called, false);
});

test('verified directory upsert failures are swallowed', async () => {
  assert.equal(await recordVerifiedPrescriberInDirectory({
    upsertPrescriber: async () => {
      throw new Error('Data Connect unavailable');
    },
  }, {
    name: 'Dr Example',
    pin: '1234',
    gmcNumber: 1234567,
  }), 'failed');
});
