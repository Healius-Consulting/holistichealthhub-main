import assert from 'node:assert/strict';
import test from 'node:test';
import { mergeTemplate } from '../services/api-sql/src/domain/common/content-template.ts';
import { ONBOARDING_CONTENT_DEFAULTS, ONBOARDING_EMAIL_KINDS, ONBOARDING_EMAIL_MERGE_HELP } from '../services/api-sql/src/domain/pharmacy-onboarding/content.ts';
import { normalizeTemplate, parseTemplate, serializeTemplate, unknownFields } from '../src/pages/admin/templateBlocks.ts';

const sample = (fields: string[]) => Object.fromEntries(fields.map(field => [field, `<${field}>`]));

/** Flags the server never sets together. */
const EXCLUSIVE = [
  ['no worldpay', 'worldpay submitted'],
  ['training link', 'no training link'],
  ['worldpay validated', 'worldpay not validated'],
  ['existing curaleaf customer', 'more information needed', 'curaleaf declined'],
];

/** Every combination of the flags the server can send, so a rewrite that changes any real variant fails. */
function flagSets(flags: string[]) {
  return Array.from({ length: 2 ** flags.length }, (_, mask) => Object.fromEntries(flags.map((flag, index) => [flag, Boolean(mask & (1 << index))])))
    .filter(set => EXCLUSIVE.every(group => group.filter(flag => set[flag]).length <= 1));
}

test('the editor layout sends exactly the same email as the stored body, for every default and every flag combination', () => {
  for (const kind of ONBOARDING_EMAIL_KINDS) {
    const { fields, flags } = ONBOARDING_EMAIL_MERGE_HELP[kind];
    const body = ONBOARDING_CONTENT_DEFAULTS[kind].body;
    const rewritten = serializeTemplate(parseTemplate(body));
    for (const set of flagSets(flags)) {
      assert.deepEqual(mergeTemplate(rewritten, sample(fields), set), mergeTemplate(body, sample(fields), set), `${kind} ${JSON.stringify(set)}`);
    }
  }
});

test('a condition that is its own paragraph becomes a "shown only when" block; one mid-sentence stays in its paragraph', () => {
  const blocks = parseTemplate('Hello,\n\n[If worldpay submitted]Worldpay will email you.[/If]\n\nYou accepted them.[If terms link] Read them at [Partner Terms link].[/If]');
  assert.deepEqual(blocks.map(({ flag, text }) => ({ flag, text })), [
    { flag: null, text: 'Hello,' },
    { flag: 'worldpay submitted', text: 'Worldpay will email you.' },
    { flag: null, text: 'You accepted them.[If terms link] Read them at [Partner Terms link].[/If]' },
  ]);
});

test('two conditions in one paragraph become two blocks, and a blank line inside a condition stays inside it', () => {
  const blocks = parseTemplate('[If a]One.\n\nTwo.[/If][If b]Three.[/If]');
  assert.deepEqual(blocks.map(({ flag, text }) => ({ flag, text })), [
    { flag: 'a', text: 'One.\n\nTwo.' },
    { flag: 'b', text: 'Three.' },
  ]);
});

test('normalising is stable, so an untouched email never shows as changed', () => {
  for (const kind of ONBOARDING_EMAIL_KINDS) {
    const once = normalizeTemplate(ONBOARDING_CONTENT_DEFAULTS[kind].body);
    assert.equal(normalizeTemplate(once), once);
  }
});

test('empty blocks are dropped and unknown merge fields are reported', () => {
  assert.equal(serializeTemplate([{ id: '1', flag: null, text: 'A' }, { id: '2', flag: 'x', text: '  ' }]), 'A');
  assert.deepEqual(unknownFields('Hi [Signer first name], [Brnch name] [If x]y[/If]', ['Signer first name']), ['Brnch name']);
});
