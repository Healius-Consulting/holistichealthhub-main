import assert from 'node:assert/strict';
import test from 'node:test';
import JSZip from 'jszip';
import { readOnboardingSpreadsheet } from '../src/auth/onboarding-sheet.ts';

test('an onboarding spreadsheet preview keeps each question with its answer', async () => {
  const zip = new JSZip();
  zip.file('xl/sharedStrings.xml', '<?xml version="1.0"?><sst xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><si><t>Nature of business</t></si><si><t>47730</t></si></sst>');
  zip.file('xl/worksheets/sheet1.xml', '<?xml version="1.0"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData><row r="1"><c r="A1" t="s"><v>0</v></c><c r="C1" t="s"><v>1</v></c></row><row r="2"></row></sheetData></worksheet>');
  const rows = await readOnboardingSpreadsheet(await zip.generateAsync({ type: 'arraybuffer' }));
  assert.deepEqual(rows, [{ label: 'Nature of business', value: '47730' }]);
});
