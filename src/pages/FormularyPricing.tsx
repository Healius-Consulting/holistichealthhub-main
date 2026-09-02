import { useEffect, useMemo, useRef, useState, type CSSProperties } from 'react';
import { ChevronLeft, ChevronRight, CircleDollarSign, Package, RefreshCw, Search, ShieldCheck, Tags } from 'lucide-react';
import ProviderStatusNotice from '../components/ProviderStatusNotice';
import MedicineLabel from '../components/MedicineLabel';
import { WHOLESALE_LABEL, money, TYPE_LABELS, useApp } from '../context/AppContext';
import { isCuraleafTestCatalogue } from '../utils/catalogueEstate';
import { catalogueStockLabel, catalogueStockStatus, catalogueStockToneClass } from '../utils/catalogueStock';

const TYPE_FILTERS = ['All', 'oil', 'flos', 'capsule', 'lozenge', 'vape', 'other'] as const;
const PAGE_SIZE = 25;

export default function FormularyPricing() {
  const { state, dispatch } = useApp();
  const [query, setQuery] = useState('');
  const [typeFilter, setTypeFilter] = useState<string>('All');
  const [page, setPage] = useState(1);
  const ledgerRef = useRef<HTMLElement>(null);

  const products = useMemo(() => state.catalogue.filter(product => {
    const needle = query.trim().toLowerCase();
    const matchesQuery = !needle || `${product.name} ${product.unit ?? ''}`.toLowerCase().includes(needle);
    return matchesQuery && (typeFilter === 'All' || product.type === typeFilter);
  }), [query, state.catalogue, typeFilter]);

  const pageCount = Math.max(1, Math.ceil(products.length / PAGE_SIZE));
  const currentPage = Math.min(page, pageCount);
  const rangeStart = products.length === 0 ? 0 : (currentPage - 1) * PAGE_SIZE;
  const rangeEnd = Math.min(rangeStart + PAGE_SIZE, products.length);
  const pageProducts = products.slice(rangeStart, rangeEnd);

  const inStockCount = state.catalogue.filter(product => catalogueStockStatus(product) === 'in').length;
  const pricedCount = state.catalogue.filter(product => product.retail > 0).length;
  const updatedAt = state.catalogueUpdatedAt
    ? new Date(state.catalogueUpdatedAt).toLocaleString('en-GB', { dateStyle: 'medium', timeStyle: 'short' })
    : null;

  useEffect(() => {
    setPage(1);
  }, [query, typeFilter]);

  useEffect(() => {
    if (state.navigationTarget?.kind !== 'catalogue') return;
    setTypeFilter('All');
    setQuery(state.navigationTarget.query);
    setPage(1);
    dispatch({ type: 'CLEAR_NAVIGATION_TARGET' });
  }, [dispatch, state.navigationTarget]);

  const retryAction = (
    <button type="button" className="btn btn-secondary btn-sm" onClick={() => dispatch({ type: 'REQUEST_CATALOGUE_REFRESH' })}>
      <RefreshCw size={14} aria-hidden="true" /> Try again
    </button>
  );

  const goToPage = (nextPage: number) => {
    setPage(nextPage);
    ledgerRef.current?.scrollIntoView({ block: 'start' });
  };

  return (
    <div className="page-body formulary-pricing-workspace" data-tour="catalogue">
      <section className="pricing-brief pricing-brief--readonly">
        <div className="pricing-brief__copy">
          <span className="pricing-brief__icon"><ShieldCheck size={18} /></span>
          <span>
            <small>Curaleaf-managed catalogue</small>
            <strong>Recommended patient prices are supplied by Curaleaf and are read-only.</strong>
            <em>{WHOLESALE_LABEL} and stock availability come from the shared Curaleaf quote bank when available, and are confirmed for exact pack quantities at checkout.</em>
          </span>
        </div>
        <dl className="pricing-position" aria-label="Curaleaf catalogue position">
          <div><dt>Products</dt><dd>{state.catalogue.length}</dd></div>
          <div><dt>In stock</dt><dd>{inStockCount}</dd></div>
          <div><dt>Recommended patient prices</dt><dd>{pricedCount}</dd></div>
        </dl>
      </section>

      {state.catalogueLoading ? (
        <ProviderStatusNotice state="loading" title="Refreshing Curaleaf catalogue" detail="The latest products and recommended patient prices are being retrieved." />
      ) : state.catalogueError ? (
        <ProviderStatusNotice
          title="Curaleaf information is temporarily delayed"
          detail="Try again now. If this continues, contact your HHH administrator; pharmacy staff do not need to change any connection settings."
          action={retryAction}
        />
      ) : state.catalogueSource !== 'curaleaf' ? (
        <ProviderStatusNotice
          title="Catalogue has not loaded"
          detail="Try again now. If it remains unavailable, contact your HHH administrator; pharmacy staff do not need to change any connection settings."
          action={retryAction}
        />
      ) : isCuraleafTestCatalogue(state.catalogueSource, state.catalogueEnvironment) ? (
        <ProviderStatusNotice
          state="waiting"
          title="Curaleaf test catalogue"
          detail="Prices and stock are from the sandbox estate. Create order uses this table as a training preview until Curaleaf is live."
        />
      ) : null}

      <section className="pricing-ledger" ref={ledgerRef}>
        <header className="pricing-ledger__header">
          <div>
            <small>Curaleaf catalogue</small>
            <strong>
              {products.length === 0
                ? 'No products to show'
                : `Showing ${rangeStart + 1}–${rangeEnd} of ${products.length}`}
              {updatedAt ? (
                <time className="pricing-ledger__refreshed" dateTime={state.catalogueUpdatedAt ?? undefined}>
                  {' '}· Refreshed {updatedAt}
                </time>
              ) : null}
            </strong>
          </div>
          <label className="pricing-search">
            <Search size={15} />
            <input className="input" value={query} onChange={event => setQuery(event.target.value)} placeholder="Search product or strength" aria-label="Search Curaleaf catalogue" />
          </label>
        </header>

        <div className="pricing-type-filter" role="group" aria-label="Filter formulary by type">
          {TYPE_FILTERS.map(type => (
            <button type="button" key={type} aria-pressed={typeFilter === type} onClick={() => setTypeFilter(type)}>
              {type === 'All' ? 'All products' : TYPE_LABELS[type] || type}
            </button>
          ))}
        </div>

        <div className="pricing-table pricing-table--readonly" role="table" aria-label="Curaleaf products and recommended patient prices">
          <div className="pricing-table__head" role="row">
            <span role="columnheader">Product</span>
            <span role="columnheader">Pack</span>
            <span role="columnheader">Stock Status</span>
            <span role="columnheader">Recommended patient price</span>
            <span role="columnheader">{WHOLESALE_LABEL}</span>
          </div>
          {products.length === 0 ? (
            <div className="pricing-empty">
              <Search size={20} />
              <span><strong>No products match</strong><small>Change the search or product type.</small></span>
            </div>
          ) : pageProducts.map((product, index) => {
            const stock = catalogueStockStatus(product);
            return (
            <div className="pricing-row pricing-row--readonly" role="row" key={product.id} style={{ '--stagger-index': index } as CSSProperties}>
              <span className="pricing-product" role="cell">
                <MedicineLabel name={product.name} />
                <small><Tags size={12} /> {TYPE_LABELS[product.type] || product.type}</small>
              </span>
              <span className="pricing-pack" role="cell">
                <Package size={14} aria-hidden="true" />
                <strong>{product.packSize ?? '—'} {product.unit ?? 'units'}</strong>
              </span>
              <span className={`pricing-stock ${catalogueStockToneClass(stock)}`} role="cell">
                <i aria-hidden="true" />{catalogueStockLabel(stock)}
              </span>
              <span className="pricing-patient-price" role="cell">
                <CircleDollarSign size={14} aria-hidden="true" />
                <strong>{product.retail > 0 ? money(product.retail) : 'Not supplied'}</strong>
              </span>
              <span className="pricing-cost" role="cell">
                <strong>{product.cost && product.cost > 0 ? money(product.cost) : 'Confirmed by quote'}</strong>
              </span>
            </div>
            );
          })
        }
        </div>
        {products.length > PAGE_SIZE ? (
          <nav className="pricing-pagination" aria-label="Catalogue pages">
            <button
              type="button"
              className="btn btn-secondary btn-sm"
              disabled={currentPage <= 1}
              onClick={() => goToPage(currentPage - 1)}
            >
              <ChevronLeft size={14} aria-hidden="true" /> Previous
            </button>
            <span>Page {currentPage} of {pageCount}</span>
            <button
              type="button"
              className="btn btn-secondary btn-sm"
              disabled={currentPage >= pageCount}
              onClick={() => goToPage(currentPage + 1)}
            >
              Next <ChevronRight size={14} aria-hidden="true" />
            </button>
          </nav>
        ) : null}
      </section>
    </div>
  );
}
