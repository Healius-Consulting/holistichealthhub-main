import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { matchLegacyPharmacy, type LegacyPharmacyCandidate } from './legacy-pharmacy-match.js';

const pharmacies: LegacyPharmacyCandidate[] = [
  { id: 'sedgley', name: 'Sedgley park pharmacy', tradingName: 'C&D Healthcare Ltd', postcode: 'M25 9JY', address: '33 Bury New Rd, Prestwich', status: 'LIVE' },
  { id: 'rupert', name: 'RUPERT STREET PHARMACY', tradingName: 'RUPERTSTREET LTD', postcode: 'BL3 6RN', address: 'Rupert St, Bolton', status: 'LIVE' },
  { id: 'lincoln', name: 'East Midlands Pharmacy', tradingName: '3SIXTY HEALTHCARE LIMITED', postcode: 'LN5 7ET', address: '15 Sincil Street, Lincoln', status: 'LIVE' },
  { id: 'westhill', name: 'West Hill Pharmacy', tradingName: 'Heswoo Investments limited', postcode: 'YO16 4RB', address: '29 Bessingby Gate, Bridlington', status: 'LIVE' },
  { id: 'rochdale', name: 'Evercare Pharmacy (ROCHDALE)', tradingName: 'SHEALMORE LIMITED', postcode: 'OL16 2DP', address: '242 YORKSHIRE STREET, ROCHDALE', status: 'LIVE' },
  { id: 'haggerston', name: 'Haggerston Pharmacy', tradingName: 'KKPR LTD', postcode: 'E8 4HU', address: '201 Haggerston Road, London', status: 'LIVE' },
  { id: 'hornsey', name: 'Hornsey Road Pharmacy', tradingName: 'KKPR Ltd', postcode: 'N7 7NN', address: '84 Hornsey Road, London', status: 'LIVE' },
  { id: 'mistry', name: 'The House Of Mistry Pharmacy', tradingName: 'the house of mistry ltd', postcode: 'NW3 2PT', address: '15-17 S End Rd, London', status: 'LIVE' },
  { id: 'bentley', name: 'Holdens Chemist - Bentley', tradingName: 'Hello Meds Ltd', postcode: 'DN5 0AP', address: '81 high street, Bentley', status: 'LIVE' },
  { id: 'sherwood', name: 'Sherwood Avenue Pharmacy', tradingName: 'HMW Healthcare Ltd', postcode: 'NG24 1QH', address: '47 Sherwood Ave, Newark', status: 'LIVE' },
  { id: 'carlton', name: 'Carlton Pharmacy', tradingName: 'CARLTON PHARMACIES LTD', postcode: 'DE13 0UW', address: '118 Calais Rd, Burton-on-Trent', status: 'LIVE' },
  { id: 'express', name: "Holden's Chemist Express", tradingName: 'Hello meds Ltd', postcode: 'DN11 8DE', address: 'Unit 3 First Floor, Bircotes', status: 'LIVE' },
  { id: 'scawsby', name: "Holden's Chemist - Scawsby", tradingName: 'Hello meds Ltd', postcode: 'DN5 8QE', address: 'Unit 4, Scawsby', status: 'LIVE' },
  { id: 'mclaren', name: 'Mclaren Pharmacy', tradingName: 'RIGHTPHARM LTD', postcode: 'MK13 0BH', address: '32 ST JAMES STREET NEW, BRADWELL', status: 'LIVE' },
  { id: 'calverton', name: 'Calverton Pharmacy', tradingName: 'CALVERTON PHARMACY LTD', postcode: 'LU3 2SZ', address: '62 CALVERTON ROAD, LUTON', status: 'LIVE' },
  { id: 'escon', name: 'CARERX PHARMACY (Eaton Socon)', tradingName: 'RIGHTPHARM LTD', postcode: 'PE19 8BB', address: 'HEALTH CENTRE EATON SOCON, ST NEOTS', status: 'LIVE' },
  { id: 'churchfield', name: 'CareRx (Churchfield)', tradingName: 'RIGHTPHARM LTD', postcode: 'LU2 9SB', address: '322 CRAWLEY GREEN ROAD, LUTON', status: 'LIVE' },
  { id: 'bancroft', name: 'CareRx (Bancroft)', tradingName: 'RIGHTPHARM LTD', postcode: 'SG5 1NQ', address: 'UNITS 1-5, BANCROFT', status: 'LIVE' },
  { id: 'gamlingay', name: 'Gamlingay Pharmacy', tradingName: 'GAMLINGAY PHARMACY LTD', postcode: 'SG19 3JH', address: '37 CHURCH STREET, GAMLINGAY', status: 'LIVE' },
  { id: 'colne-market', name: 'Evercare Pharmacy (COLNE-MARKET ST)', tradingName: 'SHEALMORE LIMITED', postcode: 'BB8 0LJ', address: '13 MARKET STREET, COLNE', status: 'LIVE' },
  { id: 'colne-albert', name: 'Evercare Pharmacy (ALBERT RD)', tradingName: 'COLNE HEALTHCARE LIMITED', postcode: 'BB8 0RY', address: '7 ALBERT ROAD, COLNE', status: 'LIVE' },
  { id: 'little-village', name: 'THE LITTLE VILLAGE PHARMACY', tradingName: 'ZVF PHARMA LTD', postcode: 'RG7 3TF', address: '24 WEST END ROAD, MORTIMER', status: 'LIVE' },
];

const sheet = [
  ['Sedgley Park Pharmacy', '33 Bury New Road, Prestwich, Prestwich, M259JY', 'sedgley'],
  ['Rupert street', 'Great Lever Health Centre,Rupert Street, Great Lever, BOLTON, BL36RN', 'rupert'],
  ['East Midlands Pharmacy Lincoln', '15 Sincil Street, Lincoln, LN57ET', 'lincoln'],
  ['West Hill Pharmacy', '29 Bessingby Gate, bridlington, Bridlington, YO164RB', 'westhill'],
  ['EVERCARE PHARMACY', '242 YORKSHIRE STREET, Rochdale, OL162DP', 'rochdale'],
  ['Haggerston Pharmacy', '201 Haggerston Road, Hackney, London, E84HU', 'haggerston'],
  ['Hornsey Road', '84 Hornsey Road, Holloway, Islington, N77NN', 'hornsey'],
  ['House of Mistry (Chemist)', '15-17 South End Road, Hampstead, Little London, NW32PT', 'mistry'],
  ["HOLDEN'S CHEMIST BENTLEY", 'COLOSSEUM BUILDING, 81 HIGH STREET, BENTLEY, Doncaster, DN50AP', 'bentley'],
  ['SHERWOOD AVENUE PHARMACY', '47 SHERWOOD AVENUE, Newark-on-Trent, NG241QH', 'sherwood'],
  ['Carlton Pharmacy', '118 Calais Road, Burton upon Trent, DE130UW', 'carlton'],
  ["HOLDEN'S CHEMIST EXPRESS", 'UNIT 3, OLD POLICE STN, SHREWSBURY ROAD, Doncaster, DN118DE', 'express'],
  ["HOLDEN'S CHEMISTS SCAWSBY", 'UNIT 4, BARNSLEY ROAD, SCAWSBY, Doncaster, DN58QE', 'scawsby'],
  ['mclaren pharmacy', '32 st james street, new bradwell, Milton Keynes, MK130BH', 'mclaren'],
  ['Calverton Pharmacy', '62 Calverton Road, Luton, LU32SZ', 'calverton'],
  ['CareRX Escon', 'Eaton Socon Health Centre, St Neots, PE198BB', 'escon'],
  ['CareRX Churchfield', 'CARERX PHARMACY 322 CRAWLEY GREEN ROAD, Churchfield Medical Centre, Lutton, LU29SB', 'churchfield'],
  ['CareRX Pharmacy Bancroft', 'Units 2-5,95-98 Bancroft, Hitchin, SG51NQ', 'bancroft'],
  ['Gamlingay Pharmacy', '37 Church Street, Gamlingay, Sandy, SG193JH', 'gamlingay'],
  ['Evercare Pharmacy', 'EVERCARE PHARMACY, 13 MARKET STREET, Colne, BB80LJ', 'colne-market'],
  ['Evercare Pharmacy', '7 Albert Road, Colne, BB80RY', 'colne-albert'],
] as const;

describe('PharmSmart pharmacy matching', () => {
  it('matches each spreadsheet pharmacy to the organisation at that postcode', () => {
    for (const [name, address, id] of sheet) {
      const match = matchLegacyPharmacy({ name, address }, pharmacies);
      assert.equal(match.status, 'matched', `${name} ${address}`);
      if (match.status === 'matched') assert.equal(match.organisationId, id);
    }
  });

  it('does not map medalchemy to the nearby Little Village Pharmacy', () => {
    const match = matchLegacyPharmacy({
      name: 'medalchemy ltd',
      address: '72 VICTORIA ROAD, Reading, RG73SQ',
    }, pharmacies);
    assert.equal(match.status, 'unmatched');
  });

  it('prefers the live pharmacy when a paused one shares the postcode and name', () => {
    const match = matchLegacyPharmacy(
      { name: 'Sedgley Park Pharmacy', address: 'Prestwich, M25 9JY' },
      [
        ...pharmacies,
        { id: 'sedgley-paused', name: 'Sedgley park pharmacy', tradingName: 'C&D Healthcare Ltd', postcode: 'M25 9JY', address: '33 Bury New Rd', status: 'PAUSED' },
      ],
    );
    assert.deepEqual(match, { status: 'matched', organisationId: 'sedgley', name: 'Sedgley park pharmacy' });
  });
});
