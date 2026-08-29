import { curaleafCataloguePackIsUnsafe } from '@hhh/domain/curaleaf-catalogue-label';
import type { CatalogueItem } from '../context/AppContext';
import type { CuraleafCatalogue } from '../shared/contracts';

function catalogueType(form: string | undefined): CatalogueItem['type'] {
  if (form === 'FLOS' || form === 'GRANULATE' || form === 'SHAKE' || form === 'PRE_ROLL') return 'flos';
  if (form === 'OIL' || form === 'ORAL_DROPS' || form === 'ORAL_SPRAY') return 'oil';
  if (form === 'CAPSULE') return 'capsule';
  if (form === 'LOZENGE' || form === 'PASTILLE') return 'lozenge';
  if (form === 'VAPE_CARTRIDGE' || form === 'DEVICE') return 'vape';
  return 'other';
}

export function mapCuraleafCatalogue(catalogue: CuraleafCatalogue): CatalogueItem[] {
  const formulaById = new Map(catalogue.formulas.map(formula => [formula.id, formula]));
  return catalogue.products
    .filter(product => {
      const formula = formulaById.get(product.formulaId);
      return !curaleafCataloguePackIsUnsafe(product, formula);
    })
    .map(product => {
      const formula = formulaById.get(product.formulaId);
      const packSize = Math.max(0, Number(product.quantity) || 0);
      const patientPackPrice = Math.max(0, Number(product.patientPackPrice) || 0);
      const wholesalePackPrice = product.wholesalePackPrice ? Math.max(0, Number(product.wholesalePackPrice) || 0) : null;
      const availability = product.quoteBankStockStatus === 'out_of_stock' || product.quoteBankInStock === false
        ? 'out' as const
        : product.quoteBankStockStatus === 'low_stock'
          ? 'low' as const
          : product.quoteBankStockStatus === 'in_stock' || product.quoteBankInStock === true
            ? 'in' as const
            : 'unknown' as const;
      return {
        id: product.id,
        formulaId: product.formulaId,
        name: product.formulaName || formula?.printedName || product.id,
        cost: wholesalePackPrice,
        retail: patientPackPrice,
        availability,
        type: catalogueType(formula?.formulaForm),
        unit: product.formulaUnit || formula?.unit,
        packSize,
        source: 'curaleaf' as const,
        supplierState: product.state,
      };
    })
    .sort((a, b) => a.name.localeCompare(b.name));
}
