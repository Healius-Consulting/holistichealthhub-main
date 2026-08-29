/**
 * Staff-facing Stock Status for a Curaleaf pack.
 *
 * Lifecycle (DISCONTINUED and any non-ACTIVE supplier state) wins over quote-bank
 * availability so a withdrawn pack cannot read as in stock. Quote-bank
 * availability then maps to in / low / out, and unknown stays "Not yet quoted"
 * until the bank has a line.
 */

export type CatalogueAvailability = 'unknown' | 'in' | 'low' | 'out';
export type CatalogueStockStatus = 'discontinued' | CatalogueAvailability;

export type CatalogueStockInput = {
  supplierState?: string;
  availability: CatalogueAvailability;
};

export function catalogueStockStatus(product: CatalogueStockInput): CatalogueStockStatus {
  if (product.supplierState && product.supplierState !== 'ACTIVE') return 'discontinued';
  return product.availability;
}

export function catalogueStockLabel(status: CatalogueStockStatus): string {
  if (status === 'discontinued') return 'Discontinued';
  if (status === 'in') return 'In stock';
  if (status === 'low') return 'Low stock';
  if (status === 'out') return 'Out of stock';
  return 'Not yet quoted';
}

/** Dot tone on Formulary. The label text is the status; colour is secondary. */
export function catalogueStockToneClass(status: CatalogueStockStatus): string {
  if (status === 'in') return 'stock-in';
  if (status === 'out' || status === 'discontinued') return 'stock-out';
  if (status === 'low') return 'stock-low';
  return 'stock-unknown';
}

export function catalogueStockPillClass(status: CatalogueStockStatus): string {
  if (status === 'in') return 'pill-green';
  if (status === 'out' || status === 'discontinued') return 'pill-red';
  return 'pill-amber';
}
