#!/usr/bin/env -S npx tsx
/**
 * Register PharmSmart eligibility tokens as extra referral hashes.
 *
 * The previous owner redirects each old add-patient link to
 * /eligibility?token=<the original base64 token>. This script stores only the
 * SHA-256 of that token against the pharmacy already on the platform. It does
 * not replace the link the pharmacy was issued, and it does not write the raw token.
 *
 * Dry run by default. Pass --apply to insert hashes that are not already stored.
 *
 *   npx tsx scripts/register-pharmsmart-referral-aliases.ts --project hhh26-4ebd2 --spreadsheet "/path/to/links.xlsx"
 *   npx tsx scripts/register-pharmsmart-referral-aliases.ts --project hhh26-4ebd2 --spreadsheet "/path/to/links.xlsx" --apply
 */
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import JSZip from 'jszip';
import { asUuid } from '../services/api-sql/src/domain/common/uuid.js';
import { matchLegacyPharmacy, type LegacyPharmacyCandidate } from '../services/api-sql/src/domain/referrals/legacy-pharmacy-match.js';
import { normaliseReferralToken } from '../services/api-sql/src/domain/referrals/referral-token.js';

const SERVICE_ID = 'hhh-platform-service';
const LOCATION = 'europe-west2';

const args = process.argv.slice(2);
function argument(name: string) {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : undefined;
}

const projectId = argument('--project');
const spreadsheet = argument('--spreadsheet');
const apply = args.includes('--apply');

if (!projectId || !spreadsheet) {
  throw new Error(
    'Pass --project <project-id> and --spreadsheet <path>. No writes were made. '
    + 'Through npm the flags need a separator: npm run migrate:pharmsmart-referral-aliases -- --project <project-id> --spreadsheet <path>',
  );
}

type SheetRow = { name: string; address: string; token: string | null };
type OrganisationRow = LegacyPharmacyCandidate;
type TokenRow = { id: string; organisationId: string; revokedAt: string | null };

function executeGraphql<T>(operation: string, variables: Record<string, unknown>): T {
  const directory = mkdtempSync(join(tmpdir(), 'hhh-pharmsmart-alias-'));
  const operationPath = join(directory, 'operation.gql');
  const variablesPath = join(directory, 'variables.json');
  writeFileSync(operationPath, operation.trim(), { mode: 0o600 });
  writeFileSync(variablesPath, JSON.stringify(variables), { mode: 0o600 });
  try {
    let output: string;
    try {
      output = execFileSync('firebase', [
        'dataconnect:execute', operationPath,
        '--project', projectId!,
        '--service', SERVICE_ID,
        '--location', LOCATION,
        '--variables', `@${variablesPath}`,
        '--no-debug-details',
      ], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 32 * 1024 * 1024 });
    } catch (error) {
      const stdout = error && typeof error === 'object' && 'stdout' in error ? String(error.stdout || '') : '';
      const stderr = error && typeof error === 'object' && 'stderr' in error ? String(error.stderr || '') : '';
      if (/credentials are no longer valid|login --reauth/i.test(`${stdout}\n${stderr}`)) {
        throw new Error('Firebase CLI authentication has expired. Run `firebase login --reauth`, then repeat the dry run.');
      }
      throw new Error('Firebase Data Connect call failed. Nothing further was attempted.');
    }
    const start = output.indexOf('{');
    if (start < 0) throw new Error('Firebase Data Connect returned no JSON payload.');
    return JSON.parse(output.slice(start)) as T;
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

function decodeXml(value: string) {
  return value
    .replaceAll('&lt;', '<')
    .replaceAll('&gt;', '>')
    .replaceAll('&quot;', '"')
    .replaceAll('&apos;', "'")
    .replaceAll('&amp;', '&');
}

async function readSheet(path: string): Promise<SheetRow[]> {
  const zip = await JSZip.loadAsync(await readFile(path));
  const shared = await zip.file('xl/sharedStrings.xml')?.async('string');
  const sheet = await zip.file('xl/worksheets/sheet1.xml')?.async('string');
  if (!shared || !sheet) throw new Error('The spreadsheet has no first sheet.');
  const strings = [...shared.matchAll(/<si[^>]*>([\s\S]*?)<\/si>/g)].map(item => (
    decodeXml([...item[1].matchAll(/<t[^>]*>([\s\S]*?)<\/t>/g)].map(text => text[1]).join(''))
  ));
  const rows: SheetRow[] = [];
  for (const row of sheet.matchAll(/<row[^>]*>([\s\S]*?)<\/row>/g)) {
    const cells: Record<string, string> = {};
    for (const cell of row[1].matchAll(/<c\b([^>]*)>([\s\S]*?)<\/c>/g)) {
      const attrs = cell[1] ?? '';
      const column = attrs.match(/\br="([A-Z]+)\d+"/)?.[1];
      const type = attrs.match(/\bt="([^"]+)"/)?.[1];
      const value = cell[2]?.match(/<v>([\s\S]*?)<\/v>/)?.[1];
      if (!column || value == null) continue;
      cells[column] = type === 's' ? (strings[Number(value)] ?? '') : value;
    }
    const link = cells.A ?? '';
    if (!link.startsWith('http')) continue;
    let token: string | null = null;
    try {
      token = normaliseReferralToken(new URL(link).searchParams.get('token') ?? '');
    } catch {
      token = null;
    }
    rows.push({ name: cells.B ?? '', address: cells.C ?? '', token });
  }
  return rows;
}

function tokenHash(token: string) {
  return createHash('sha256').update(token).digest('hex');
}

const LIST_ORGANISATIONS = `
  query ListPharmaciesForPharmSmartAliases {
    organisations(where: { archivedAt: { isNull: true } }, limit: 500) {
      id
      name
      tradingName
      postcode
      address
      status
    }
  }
`;

const FIND_TOKEN = `
  query FindPharmSmartReferralToken($tokenHash: String!) {
    referralTokens(where: { tokenHash: { eq: $tokenHash } }, limit: 1) {
      id
      organisationId
      revokedAt
    }
  }
`;

const INSERT_TOKEN = `
  mutation InsertPharmSmartReferralToken($organisationId: UUID!, $tokenHash: String!) {
    referralToken_insert(data: {
      organisationId: $organisationId
      tokenHash: $tokenHash
      intakeVersion: "v2"
      createdByUid: null
    })
  }
`;

const rows = await readSheet(spreadsheet);
const listed = executeGraphql<{ data?: { organisations?: OrganisationRow[] } }>(LIST_ORGANISATIONS, {});
const organisations = listed.data?.organisations ?? [];
if (organisations.length === 0) throw new Error('No pharmacies were returned. Nothing was written.');

let inserted = 0;
let pending = 0;
for (const row of rows) {
  if (!row.token) {
    console.log(`invalid token | ${row.name} | not registered`);
    continue;
  }
  const match = matchLegacyPharmacy(row, organisations);
  if (match.status !== 'matched') {
    console.log(`unmatched | ${row.name} | ${match.reason}`);
    continue;
  }
  const hash = tokenHash(row.token);
  const existing = executeGraphql<{ data?: { referralTokens?: TokenRow[] } }>(FIND_TOKEN, { tokenHash: hash });
  const stored = existing.data?.referralTokens?.[0];
  if (stored && stored.organisationId.replaceAll('-', '').toLowerCase() === match.organisationId.replaceAll('-', '').toLowerCase()) {
    console.log(`already stored | ${row.name} | ${match.name} | ${stored.revokedAt ? 'revoked' : 'active'}`);
    continue;
  }
  if (stored) {
    console.log(`conflict | ${row.name} | hash is stored for a different pharmacy | not written`);
    continue;
  }
  if (!apply) {
    pending += 1;
    console.log(`ready | ${row.name} | ${match.name} | ${match.organisationId}`);
    continue;
  }
  executeGraphql(INSERT_TOKEN, { organisationId: asUuid(match.organisationId), tokenHash: hash });
  inserted += 1;
  console.log(`inserted | ${row.name} | ${match.name} | ${match.organisationId}`);
}

if (!apply) {
  console.log(`Dry run only. ${pending} alias hash(es) would be registered. Re-run with --apply to write them.`);
} else {
  console.log(`Registered ${inserted} PharmSmart alias hash(es) in ${projectId}.`);
}
