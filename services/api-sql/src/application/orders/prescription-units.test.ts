import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  buildPrescriptionPlacementItems,
  packSizeFromLineRecord,
  packSizeFromProductRecord,
  resolveUnitsNeededCount,
  stampPackFieldsOnSnapshot,
} from './prescription-units.js';

describe('resolveUnitsNeededCount', () => {
  it('multiplies pack count by the product pack size', () => {
    assert.deepEqual(resolveUnitsNeededCount({ packCount: 2, packSize: 10 }), {
      unitsNeededCount: 20,
      packSize: 10,
    });
    assert.deepEqual(resolveUnitsNeededCount({ packCount: 1, packSize: 1 }), {
      unitsNeededCount: 1,
      packSize: 1,
    });
    assert.deepEqual(resolveUnitsNeededCount({ packCount: 2, packSize: 30 }), {
      unitsNeededCount: 60,
      packSize: 30,
    });
    assert.deepEqual(resolveUnitsNeededCount({ packCount: 3, packSize: 5 }), {
      unitsNeededCount: 15,
      packSize: 5,
    });
  });

  it('does not invent a 10-unit pack', () => {
    assert.equal(resolveUnitsNeededCount({ packCount: 1 }), null);
    assert.equal(resolveUnitsNeededCount({ packCount: 2, packSize: 0 }), null);
  });
});

describe('pack size records', () => {
  it('does not treat line quantity as pack size', () => {
    assert.equal(packSizeFromLineRecord({ quantity: 2, unitsNeededCount: 10 }), null);
    assert.equal(packSizeFromLineRecord({ packSize: 10, quantity: 2 }), 10);
  });

  it('reads Curaleaf product.quantity as pack size', () => {
    assert.equal(packSizeFromProductRecord({ id: 'vape', quantity: 1 }), 1);
    assert.equal(packSizeFromProductRecord({ id: 'flower', quantity: 10 }), 10);
  });
});

describe('buildPrescriptionPlacementItems', () => {
  const flowerPack = '9f2d6958-2d76-4338-9e5f-6fd383dfff36';
  const vapePack = '7c40abf8-8909-4b53-aca9-3917415668be';
  const flowerFormula = 'f74f63de-dc89-4074-9d8c-be35f5398963';
  const vapeFormula = 'cfa4e439-0c28-4cae-a2de-557c836f61ca';

  it('uses catalogue pack size when snapshot lines have no units', () => {
    const result = buildPrescriptionPlacementItems({
      rawLines: [
        { packId: flowerPack, formulaId: flowerFormula, quantity: 2 },
        { packId: vapePack, formulaId: vapeFormula, quantity: 1 },
      ],
      prescriptionItems: [
        { packId: flowerPack, formulaId: flowerFormula, quantity: 2, unitsNeededCount: 10 },
        { packId: vapePack, formulaId: vapeFormula, quantity: 1, unitsNeededCount: 1 },
      ],
      catalogPackSizeByPackId: new Map([
        [flowerPack, 10],
        [vapePack, 1],
      ]),
    });

    assert.deepEqual(result.missingPackSize, []);
    assert.deepEqual(result.items, [
      { productId: flowerPack, count: 2, formulaId: flowerFormula, unitsNeededCount: 20, packSize: 10 },
      { productId: vapePack, count: 1, formulaId: vapeFormula, unitsNeededCount: 1, packSize: 1 },
    ]);
  });

  it('prefers stored packSize over a stale unitsNeededCount', () => {
    const result = buildPrescriptionPlacementItems({
      rawLines: [
        { packId: flowerPack, formulaId: flowerFormula, quantity: 2, packSize: 10, unitsNeededCount: 10 },
      ],
    });
    assert.equal(result.items[0]?.unitsNeededCount, 20);
  });

  it('stamps pack count × pack size onto snapshot line items', () => {
    const next = stampPackFieldsOnSnapshot({
      lineItems: [{ packId: flowerPack, quantity: 2 }],
    }, [{ packId: flowerPack, packSize: 10, quantity: 2 }]);
    assert.deepEqual((next.lineItems as Array<{ unitsNeededCount: number; packSize: number }>)[0], {
      packId: flowerPack,
      quantity: 2,
      packSize: 10,
      unitsNeededCount: 20,
    });
  });

  it('fails closed when pack size is unknown', () => {
    const result = buildPrescriptionPlacementItems({
      rawLines: [{ packId: vapePack, formulaId: vapeFormula, quantity: 1 }],
    });
    assert.deepEqual(result.items, []);
    assert.deepEqual(result.missingPackSize, [vapePack]);
  });
});
