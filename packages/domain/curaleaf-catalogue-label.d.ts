export function curaleafCatalogueLabelIsUnsafe(value: unknown): boolean;
export function curaleafCatalogueRecordIsUnsafe(record: unknown): boolean;
export function curaleafCataloguePackIsUnsafe(product: unknown, formula?: unknown): boolean;
export function stripUnsafeCuraleafCatalogue<T>(formulas: T[], products: T[]): { formulas: T[]; products: T[] };
