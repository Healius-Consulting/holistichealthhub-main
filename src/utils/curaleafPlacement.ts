import type { CuraleafQuote, CuraleafQuoteRequestItem } from '../shared/contracts';
import { curaleafCatalogueEstate } from './catalogueEstate.ts';
import { catalogueStockStatus, type CatalogueStockInput } from './catalogueStock.ts';

/**
 * Real payment, Worldpay, and Curaleaf writes stay locked until the pharmacy is
 * live and Curaleaf is on the production estate. Training and the test catalogue
 * may still walk the create-order screens as a preview.
 */
export function curaleafPlacementUnlocked(input: {
  workspaceMode: string;
  localPreview: boolean;
  catalogueSource?: 'curaleaf' | 'training' | 'unavailable';
  catalogueEnvironment?: unknown;
}): boolean {
  if (input.localPreview) return false;
  if (input.workspaceMode !== 'live') return false;
  return input.catalogueSource === 'curaleaf' && curaleafCatalogueEstate(input.catalogueEnvironment) === 'production';
}

type SnapshotCatalogueRow = CatalogueStockInput & {
  id: string;
  cost: number | null;
  retail: number;
};

function stockStatusForQuote(product: CatalogueStockInput): CuraleafQuote['items'][number]['stockStatus'] {
  const stock = catalogueStockStatus(product);
  if (stock === 'out' || stock === 'discontinued') return 'out_of_stock';
  if (stock === 'low') return 'low_stock';
  if (stock === 'in') return 'in_stock';
  return undefined;
}

function quoteItemFromRow(packId: string, quantity: number, product: SnapshotCatalogueRow): CuraleafQuote['items'][number] {
  const stockStatus = stockStatusForQuote(product);
  return {
    packId,
    quantity,
    inStock: stockStatus !== 'out_of_stock',
    stockStatus,
    wholesalePackPrice: product.cost == null ? '' : product.cost.toFixed(2),
    patientPackPrice: product.retail.toFixed(2),
  };
}

/** Prices and stock from the loaded test/dev catalogue table — no Curaleaf write. */
export function snapshotQuoteFromCatalogue(
  items: CuraleafQuoteRequestItem[],
  catalogue: SnapshotCatalogueRow[],
  fallbackLines: Array<{ productId: string; cost: number | null; retail: number }> = [],
): { quote: CuraleafQuote; missingPackIds: string[] } {
  const byId = new Map(catalogue.map(product => [product.id, product]));
  const fallbackById = new Map(fallbackLines.map(line => [line.productId, line]));
  const missingPackIds: string[] = [];
  const quoteItems = items.flatMap(item => {
    const product = byId.get(item.packId);
    if (product) return [quoteItemFromRow(item.packId, item.quantity, product)];
    const fallback = fallbackById.get(item.packId);
    if (fallback && fallback.retail > 0) {
      return [quoteItemFromRow(item.packId, item.quantity, {
        id: item.packId,
        cost: fallback.cost,
        retail: fallback.retail,
        availability: 'in',
        supplierState: 'ACTIVE',
      })];
    }
    missingPackIds.push(item.packId);
    return [];
  });
  return {
    quote: {
      shippingPrice: '0.00',
      taxRate: '0',
      items: quoteItems,
    },
    missingPackIds: [...new Set(missingPackIds)],
  };
}
