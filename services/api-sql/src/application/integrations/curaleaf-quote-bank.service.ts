import { z } from 'zod';
import { curaleafMoneyPence, penceToCuraleafMoney } from '../../domain/integrations/curaleaf-money.js';
import { curaleafCataloguePackIsUnsafe } from '../../domain/curaleaf-catalogue-label.js';
import type { IntegrationConnectionRecord } from '../../repositories/ports/integration.port.js';
import type {
  CuraleafQuoteBankEntryRecord,
  CuraleafQuoteBankRepositoryPort,
  CuraleafQuoteBankSource,
  CuraleafStockStatus,
} from '../../repositories/ports/curaleaf-quote-bank.port.js';
import { fetchCuraleafCatalogue, fetchCuraleafQuote } from './curaleaf.service.js';

const QUOTE_BATCH_SIZE = 100;
const QUOTE_PACE_MS = 1_050;

const curaleafQuoteItemSchema = z.object({
  packId: z.string().trim().min(1),
  quantity: z.number().int().positive().max(100),
  inStock: z.boolean(),
  stockStatus: z.enum(['in_stock', 'low_stock', 'out_of_stock']).optional(),
  wholesalePackPrice: z.string().trim().min(1),
  patientPackPrice: z.string().trim().min(1),
});

const curaleafQuoteSchema = z.object({
  shippingPrice: z.string().trim().min(1),
  taxRate: z.string().trim().min(1),
  items: z.array(curaleafQuoteItemSchema).min(1).max(100),
});

export type ParsedCuraleafQuote = z.infer<typeof curaleafQuoteSchema>;

function normaliseStockStatus(inStock: boolean, stockStatus?: 'in_stock' | 'low_stock' | 'out_of_stock'): CuraleafStockStatus {
  if (!inStock || stockStatus === 'out_of_stock') return 'OUT_OF_STOCK';
  if (stockStatus === 'low_stock') return 'LOW_STOCK';
  return 'IN_STOCK';
}

function chunk<T>(items: T[], size: number) {
  const batches: T[][] = [];
  for (let index = 0; index < items.length; index += size) {
    batches.push(items.slice(index, index + size));
  }
  return batches;
}

export function parseCuraleafQuote(raw: unknown): ParsedCuraleafQuote {
  return curaleafQuoteSchema.parse(raw);
}

export function quoteBankEntryFromQuoteItem(
  connection: IntegrationConnectionRecord,
  item: z.infer<typeof curaleafQuoteItemSchema>,
  source: CuraleafQuoteBankSource,
  quotedAt: string,
  formulaId?: string | null,
) {
  return {
    environment: connection.environment,
    packId: item.packId,
    sourcedConnectionId: connection.id,
    formulaId: formulaId ?? null,
    quotedQuantity: item.quantity,
    wholesalePackPricePence: curaleafMoneyPence(item.wholesalePackPrice, 'wholesale pack price'),
    patientPackPricePence: curaleafMoneyPence(item.patientPackPrice, 'patient pack price'),
    inStock: item.inStock,
    stockStatus: normaliseStockStatus(item.inStock, item.stockStatus),
    source,
    quotedAt,
  };
}

function entryChanged(existing: CuraleafQuoteBankEntryRecord | undefined, next: ReturnType<typeof quoteBankEntryFromQuoteItem>) {
  if (!existing) return true;
  return existing.wholesalePackPricePence !== next.wholesalePackPricePence
    || existing.patientPackPricePence !== next.patientPackPricePence
    || existing.inStock !== next.inStock
    || existing.stockStatus !== next.stockStatus;
}

export async function upsertCuraleafQuoteBankFromQuote(
  connection: IntegrationConnectionRecord,
  rawQuote: unknown,
  source: CuraleafQuoteBankSource,
  repo: CuraleafQuoteBankRepositoryPort,
  formulaByPackId?: Map<string, string>,
) {
  const quote = parseCuraleafQuote(rawQuote);
  const quotedAt = new Date().toISOString();
  const existingEntries = await repo.listEntries(connection.environment);
  const existingByPack = new Map(existingEntries.map(entry => [entry.packId, entry]));
  let updated = 0;

  for (const item of quote.items) {
    const next = quoteBankEntryFromQuoteItem(
      connection,
      item,
      source,
      quotedAt,
      formulaByPackId?.get(item.packId),
    );
    if (!entryChanged(existingByPack.get(item.packId), next)) continue;
    await repo.upsertEntry(next);
    updated += 1;
  }

  return { quotedPacks: quote.items.length, updatedPacks: updated, quotedAt };
}

export function mergeQuoteBankIntoCatalogue<T extends Record<string, unknown>>(
  catalogue: {
    products: T[];
    fetchedAt: string;
    [key: string]: unknown;
  },
  entries: CuraleafQuoteBankEntryRecord[],
) {
  const bankByPack = new Map(entries.map(entry => [entry.packId, entry]));
  const quoteBankUpdatedAt = entries.reduce<string | null>((latest, entry) => {
    if (!latest || entry.quotedAt > latest) return entry.quotedAt;
    return latest;
  }, null);

  return {
    ...catalogue,
    quoteBankUpdatedAt,
    quoteBankPackCount: entries.length,
    products: catalogue.products.map(product => {
      const packId = String(product.id ?? '');
      const bank = bankByPack.get(packId);
      if (!bank) return product;
      return {
        ...product,
        patientPackPrice: penceToCuraleafMoney(bank.patientPackPricePence),
        wholesalePackPrice: penceToCuraleafMoney(bank.wholesalePackPricePence),
        quoteBankInStock: bank.inStock,
        quoteBankStockStatus: bank.stockStatus === 'IN_STOCK'
          ? 'in_stock'
          : bank.stockStatus === 'LOW_STOCK'
            ? 'low_stock'
            : 'out_of_stock',
        quoteBankQuotedAt: bank.quotedAt,
      };
    }),
  };
}

export async function refreshCuraleafQuoteBankDaily(
  connection: IntegrationConnectionRecord,
  repo: CuraleafQuoteBankRepositoryPort,
) {
  const catalogue = await fetchCuraleafCatalogue(connection);
  const products = catalogue.products as Array<Record<string, unknown>>;
  const formulas = (catalogue.formulas ?? []) as Array<Record<string, unknown>>;
  const formulaById = new Map(
    formulas
      .filter(formula => typeof formula.id === 'string')
      .map(formula => [String(formula.id), formula]),
  );
  const activePacks = products
    .filter(product => {
      if (String(product.state ?? '') !== 'ACTIVE' || typeof product.id !== 'string') return false;
      const formula = typeof product.formulaId === 'string' ? formulaById.get(product.formulaId) : undefined;
      return !curaleafCataloguePackIsUnsafe(product, formula);
    })
    .map(product => ({
      packId: String(product.id),
      formulaId: typeof product.formulaId === 'string' ? product.formulaId : null,
      quantity: 1,
    }));

  const formulaByPackId = new Map(
    activePacks
      .filter((pack): pack is typeof pack & { formulaId: string } => Boolean(pack.formulaId))
      .map(pack => [pack.packId, pack.formulaId]),
  );
  let quotedPacks = 0;
  let updatedPacks = 0;
  let lastError: string | null = null;

  try {
    for (const batch of chunk(activePacks, QUOTE_BATCH_SIZE)) {
      const rawQuote = await fetchCuraleafQuote(connection, batch.map(item => ({
        packId: item.packId,
        quantity: item.quantity,
      })));
      const result = await upsertCuraleafQuoteBankFromQuote(
        connection,
        rawQuote,
        'DAILY_REFRESH',
        repo,
        formulaByPackId,
      );
      quotedPacks += result.quotedPacks;
      updatedPacks += result.updatedPacks;
      await new Promise(resolve => setTimeout(resolve, QUOTE_PACE_MS));
    }

    await repo.upsertSync({
      environment: connection.environment,
      sourcedConnectionId: connection.id,
      lastDailyRefreshAt: new Date().toISOString(),
      packCount: quotedPacks,
      lastError: null,
    });
  } catch (error) {
    lastError = error instanceof Error ? error.message : 'Quote bank refresh failed.';
    await repo.upsertSync({
      environment: connection.environment,
      sourcedConnectionId: connection.id,
      packCount: quotedPacks,
      lastError,
    });
    throw error;
  }

  return {
    environment: connection.environment,
    sourcedConnectionId: connection.id,
    activePacks: activePacks.length,
    quotedPacks,
    updatedPacks,
    lastError,
  };
}

function referenceConnections(connections: IntegrationConnectionRecord[]) {
  const byEnvironment = new Map<string, IntegrationConnectionRecord>();
  for (const connection of connections) {
    if (connection.integration !== 'CURALEAF' || connection.status !== 'ACTIVE' || !connection.secretResourceName) continue;
    if (!byEnvironment.has(connection.environment)) {
      byEnvironment.set(connection.environment, connection);
    }
  }
  return [...byEnvironment.values()];
}

export async function refreshAllCuraleafQuoteBanks(
  connections: IntegrationConnectionRecord[],
  repo: CuraleafQuoteBankRepositoryPort,
) {
  const results = [];
  for (const connection of referenceConnections(connections)) {
    try {
      const result = await refreshCuraleafQuoteBankDaily(connection, repo);
      results.push({
        ...result,
        ok: true,
      });
    } catch (error) {
      results.push({
        environment: connection.environment,
        sourcedConnectionId: connection.id,
        ok: false,
        error: error instanceof Error ? error.message : 'Quote bank refresh failed.',
      });
    }
  }
  return results;
}
