import { useEffect, useMemo, useRef, useState } from 'react';
import { normalisePrescriptionDateParts, prescriptionDateWindowStatus, prescriptionExpiryDisplay, serialReuseDisplay } from '@hhh/domain/prescription-date';
import { Check, ChevronLeft, ChevronRight, Minus, Package, Plus, Search, Trash2 } from 'lucide-react';
import MedicineLabel from './MedicineLabel';
import type { CatalogueItem, LineItem, Prescription } from '../context/AppContext';
import { PATIENT_PRICE_LABEL, WHOLESALE_LABEL, WHOLESALE_LABEL_SHORT, formatMargin, marginToneClass, money, useApp } from '../context/AppContext';
import './ManualPrescriptionEditor.css';
import { createPrescriberDirectoryRecord, getPrescriberDirectory, isApiConfigured } from '../shared/api';
import type { PrescriberDirectoryRecord } from '../shared/contracts';
import { isLocalPortalPreview } from '../dev/localPortalPreview';

type MetadataField = 'issueDate' | 'prescriberPin' | 'prescriberGmcNumber' | 'prescriberGphcNumber' | 'serialNumber';

export type ManualPrescriptionEditorView = 'details' | 'formulary' | 'all';
type CatalogueTypeFilter = 'all' | CatalogueItem['type'];

const catalogueTypeLabels: Record<CatalogueItem['type'], string> = {
  oil: 'Oil',
  flos: 'Flower',
  capsule: 'Capsule',
  lozenge: 'Lozenge',
  vape: 'Vape',
  other: 'Other',
};

const GUIDED_PAGE_SIZE = 24;
const COMPACT_PAGE_SIZE = 16;

const dateParts = (value?: string) => {
  const match = value?.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  return match ? { day: match[3], month: match[2], year: match[1] } : { day: '', month: '', year: '' };
};

function ManualDateField({ label, value, onChange, readOnly = false }: { label: string; value?: string; onChange: (value: string) => void; readOnly?: boolean }) {
  const initial = dateParts(value);
  const [day, setDay] = useState(initial.day);
  const [month, setMonth] = useState(initial.month);
  const [year, setYear] = useState(initial.year);
  const [validationError, setValidationError] = useState<string | null>(null);
  const preserveInvalidInput = useRef(false);

  useEffect(() => {
    if (preserveInvalidInput.current && !value) {
      preserveInvalidInput.current = false;
      return;
    }
    const next = dateParts(value);
    setDay(next.day);
    setMonth(next.month);
    setYear(next.year);
  }, [value]);

  const commit = (nextDay: string, nextMonth: string, nextYear: string, force = false) => {
    const result = normalisePrescriptionDateParts(nextDay, nextMonth, nextYear);
    if (result.status === 'empty') {
      setValidationError(null);
      onChange('');
      return;
    }
    if (result.status === 'incomplete') {
      if (!force) return;
      setValidationError('Enter a complete date using DD/MM/YYYY.');
      preserveInvalidInput.current = true;
      onChange('');
      return;
    }
    if (result.status === 'invalid') {
      setValidationError('Enter a real calendar date.');
      preserveInvalidInput.current = true;
      onChange('');
      return;
    }
    if (prescriptionDateWindowStatus(result.value) === 'future') {
      setValidationError('Prescription issue date cannot be in the future.');
      preserveInvalidInput.current = true;
      onChange('');
      return;
    }
    preserveInvalidInput.current = false;
    setValidationError(null);
    const normalised = dateParts(result.value);
    setDay(normalised.day);
    setMonth(normalised.month);
    setYear(normalised.year);
    onChange(result.value);
  };

  const updatePart = (part: 'day' | 'month' | 'year', rawValue: string) => {
    const limit = part === 'year' ? 4 : 2;
    const nextValue = rawValue.replace(/\D/g, '').slice(0, limit);
    const nextDay = part === 'day' ? nextValue : day;
    const nextMonth = part === 'month' ? nextValue : month;
    const nextYear = part === 'year' ? nextValue : year;
    if (part === 'day') setDay(nextValue);
    if (part === 'month') setMonth(nextValue);
    if (part === 'year') setYear(nextValue);
    if (nextDay.length === 2 && nextMonth.length === 2 && nextYear.length === 4) commit(nextDay, nextMonth, nextYear);
  };

  const localDate = normalisePrescriptionDateParts(day, month, year);
  const expiry = localDate.status === 'valid' && prescriptionDateWindowStatus(localDate.value) !== 'future' ? prescriptionExpiryDisplay(localDate.value) : null;

  return (
    <label className="manual-rx-date-label">
      <span>{label}</span>
      <span className="manual-rx-date-field" role="group" aria-label={label} aria-disabled={readOnly || undefined} aria-invalid={Boolean(validationError) || undefined} onBlur={event => { if (readOnly) return; if (!event.currentTarget.contains(event.relatedTarget as Node | null)) commit(day, month, year, true); }}>
        <input aria-label={`${label} day`} inputMode="numeric" placeholder="DD" value={day} readOnly={readOnly} disabled={readOnly} onChange={event => updatePart('day', event.target.value)} />
        <i>/</i>
        <input aria-label={`${label} month`} inputMode="numeric" placeholder="MM" value={month} readOnly={readOnly} disabled={readOnly} onChange={event => updatePart('month', event.target.value)} />
        <i>/</i>
        <input aria-label={`${label} year`} inputMode="numeric" placeholder="YYYY" value={year} readOnly={readOnly} disabled={readOnly} onChange={event => updatePart('year', event.target.value)} />
      </span>
      <small className={validationError ? 'manual-rx-field-error' : 'manual-rx-field-help'}>
        {validationError ?? 'Schedule 2 CD Rx valid 28 days from issue'}
      </small>
      {expiry ? <small className={`manual-rx-expiry manual-rx-expiry--${expiry.tone}`}>{expiry.text}</small> : null}
    </label>
  );
}

export default function ManualPrescriptionEditor({
  prescription,
  catalogue,
  view = 'all',
  hideSelectedList = false,
  onPrescriberChange,
  onMetadataChange,
  onUnlockInheritedSerial,
  onAddItem,
  onRemoveItem,
  onUpdateQuantity,
  onUpdateUnits,
}: {
  prescription: Prescription;
  catalogue: CatalogueItem[];
  view?: ManualPrescriptionEditorView;
  hideSelectedList?: boolean;
  onPrescriberChange: (value: string) => void;
  onMetadataChange: (field: MetadataField, value: string) => void;
  onUnlockInheritedSerial?: () => void;
  onAddItem: (item: LineItem) => void;
  onRemoveItem: (productId: string) => void;
  onUpdateQuantity: (productId: string, quantity: number) => void;
  onUpdateUnits: (productId: string, units: number) => void;
}) {
  const { state } = useApp();
  const [query, setQuery] = useState('');
  const [typeFilter, setTypeFilter] = useState<CatalogueTypeFilter>('all');
  const [page, setPage] = useState(1);
  const resultsRef = useRef<HTMLDivElement>(null);
  const [prescriberQuery, setPrescriberQuery] = useState(prescription.prescriber);
  const [prescribers, setPrescribers] = useState<PrescriberDirectoryRecord[]>([]);
  const [prescriberBusy, setPrescriberBusy] = useState(false);
  const [prescriberError, setPrescriberError] = useState<string | null>(null);
  const directoryEnabled = isApiConfigured && !isLocalPortalPreview && state.workspaceMode === 'live';
  const serialReuse = serialReuseDisplay(prescription.issueDate);
  const selectedProductIds = useMemo(() => new Set(prescription.items.map(item => item.productId)), [prescription.items]);
  const activeProducts = useMemo(
    () => catalogue.filter(product => product.supplierState === 'ACTIVE' && product.formulaId),
    [catalogue],
  );
  const availableTypes = useMemo(
    () => [...new Set(activeProducts.map(product => product.type))],
    [activeProducts],
  );
  const filteredProducts = useMemo(() => {
    const needle = query.trim().toLocaleLowerCase('en-GB');
    return activeProducts
      .filter(product => typeFilter === 'all' || product.type === typeFilter)
      .filter(product => !needle || `${product.name} ${product.type} ${product.unit ?? ''}`.toLocaleLowerCase('en-GB').includes(needle));
  }, [activeProducts, query, typeFilter]);
  const pageSize = hideSelectedList ? GUIDED_PAGE_SIZE : COMPACT_PAGE_SIZE;
  const pageCount = Math.max(1, Math.ceil(filteredProducts.length / pageSize));
  const currentPage = Math.min(page, pageCount);
  const rangeStart = filteredProducts.length === 0 ? 0 : (currentPage - 1) * pageSize;
  const rangeEnd = Math.min(rangeStart + pageSize, filteredProducts.length);
  const visibleProducts = filteredProducts.slice(rangeStart, rangeEnd);

  useEffect(() => {
    setPage(1);
  }, [query, typeFilter]);

  useEffect(() => {
    setPrescriberQuery(prescription.prescriber);
  }, [prescription.prescriber]);

  useEffect(() => {
    if (!directoryEnabled) return;
    const timer = window.setTimeout(() => {
      void getPrescriberDirectory(state.currentOrganisationId, prescriberQuery).then(setPrescribers).catch(error => setPrescriberError(error instanceof Error ? error.message : 'Prescribers could not be loaded.'));
    }, 250);
    return () => window.clearTimeout(timer);
  }, [directoryEnabled, prescriberQuery, state.currentOrganisationId]);

  const selectPrescriber = (record: PrescriberDirectoryRecord) => {
    onPrescriberChange(record.name);
    onMetadataChange('prescriberPin', record.pin);
    onMetadataChange('prescriberGmcNumber', record.gmcNumber?.toString() ?? '');
    onMetadataChange('prescriberGphcNumber', record.gphcNumber ?? '');
    setPrescriberQuery(record.name);
  };

  const addPrescriber = async () => {
    const name = prescriberQuery.trim();
    const pin = prescription.prescriberPin?.trim() ?? '';
    if (!name || !pin) return setPrescriberError('Enter the prescriber name and PIN before adding them.');
    setPrescriberBusy(true);
    setPrescriberError(null);
    try {
      const record = await createPrescriberDirectoryRecord({ organisationId: state.currentOrganisationId, name, initials: name.split(/\s+/).map(part => part[0]).join('').toUpperCase().slice(0, 20), pin, gmcNumber: prescription.prescriberGmcNumber ? Number(prescription.prescriberGmcNumber) : null, gphcNumber: prescription.prescriberGphcNumber?.trim() || null });
      setPrescribers(current => [record, ...current.filter(item => item.id !== record.id)]);
      selectPrescriber(record);
    } catch (error) {
      setPrescriberError(error instanceof Error ? error.message : 'The prescriber could not be added.');
    } finally {
      setPrescriberBusy(false);
    }
  };

  const addProduct = (product: CatalogueItem) => {
    if (selectedProductIds.has(product.id)) return;
    onAddItem({
      productId: product.id,
      formulaId: product.formulaId,
      name: product.name,
      qty: 1,
      unitsNeededCount: product.packSize ?? 1,
      cost: null,
      retail: product.retail,
    });
  };

  const updatePackQuantity = (item: LineItem, nextQuantity: number) => {
    const quantity = Math.max(1, Math.min(100, Math.floor(nextQuantity) || 1));
    const product = catalogue.find(candidate => candidate.id === item.productId);
    const currentPackSize = item.unitsNeededCount && item.qty ? item.unitsNeededCount / item.qty : 1;
    const packSize = product?.packSize ?? currentPackSize;
    onUpdateQuantity(item.productId, quantity);
    onUpdateUnits(item.productId, Math.max(1, Math.round(packSize * quantity)));
  };

  return (
    <div className="manual-rx-editor">
      {view !== 'formulary' ? (
        <div className="manual-rx-details">
          <header className="manual-rx-details__header">
            <span><small>Manual transcription</small><strong>Complete only what is printed on the prescription</strong></span>
            <small>Patient details come from the approved patient selected in Step 1.</small>
          </header>

          <section className="manual-rx-field-group manual-rx-field-group--plain" aria-label="Prescription details">
            <div className="manual-rx-fields">
              <label className="manual-rx-fields__wide">
                <span>Prescription serial number</span>
                <input
                  className="input"
                  value={prescription.serialNumber ?? ''}
                  maxLength={200}
                  placeholder="Enter exactly as printed on the prescription"
                  readOnly={Boolean(prescription.serialInherited)}
                  aria-readonly={prescription.serialInherited || undefined}
                  onChange={event => onMetadataChange('serialNumber', event.target.value)}
                />
              </label>
              <ManualDateField
                label="Issue date"
                value={prescription.issueDate}
                readOnly={Boolean(prescription.serialInherited)}
                onChange={issueDate => onMetadataChange('issueDate', issueDate)}
              />
            </div>
            {prescription.serialInherited ? (
              <div className="manual-rx-inherited">
                <small>
                  {serialReuse?.text
                    ?? 'This serial was copied from the previous prescription and stays locked while it is reused.'}
                </small>
                {onUnlockInheritedSerial ? (
                  <button type="button" className="btn btn-secondary btn-sm" onClick={onUnlockInheritedSerial}>
                    Use a different serial
                  </button>
                ) : null}
              </div>
            ) : serialReuse ? (
              <small className={serialReuse.tone === 'red' ? 'manual-rx-field-error' : 'manual-rx-field-help'}>
                {serialReuse.text}
              </small>
            ) : null}
          </section>


          <section className="manual-rx-field-group manual-rx-field-group--plain" aria-label="Prescriber details">
            <div className="manual-rx-fields manual-rx-fields--prescriber">
              <label className="manual-rx-fields__wide">
                <span>Prescriber’s full name</span>
                <input className="input" value={prescriberQuery} maxLength={200} placeholder="Search name, PIN, GMC or GPhC" onChange={event => { setPrescriberQuery(event.target.value); onPrescriberChange(event.target.value); }} />
                {directoryEnabled && prescribers.length ? <span className="manual-prescriber-results">{prescribers.slice(0, 6).map(record => <button type="button" key={record.id} onClick={() => selectPrescriber(record)}><strong>{record.name}</strong><small>PIN {record.pin}{record.gmcNumber ? ` · GMC ${record.gmcNumber}` : record.gphcNumber ? ` · GPhC ${record.gphcNumber}` : ''}</small></button>)}</span> : null}
                {directoryEnabled ? <button type="button" className="btn btn-sm" disabled={prescriberBusy || !prescriberQuery.trim() || !prescription.prescriberPin?.trim()} onClick={() => void addPrescriber()}>{prescriberBusy ? 'Adding…' : 'Add to central directory'}</button> : <small className="manual-rx-field-help">Directory search becomes available in the connected live workspace.</small>}
                {prescriberError ? <small className="manual-rx-field-error">{prescriberError}</small> : null}
              </label>
              <label>
                <span>Prescriber PIN</span>
                <input className="input" value={prescription.prescriberPin ?? ''} maxLength={100} onChange={event => onMetadataChange('prescriberPin', event.target.value)} />
              </label>
              <label>
                <span>GMC number <small>(when applicable)</small></span>
                <input className="input" inputMode="numeric" value={prescription.prescriberGmcNumber ?? ''} maxLength={12} onChange={event => onMetadataChange('prescriberGmcNumber', event.target.value.replace(/\D/g, ''))} />
              </label>
              <label>
                <span>GPhC number <small>(when applicable)</small></span>
                <input className="input" value={prescription.prescriberGphcNumber ?? ''} maxLength={100} onChange={event => onMetadataChange('prescriberGphcNumber', event.target.value)} />
              </label>
            </div>
          </section>
        </div>
      ) : null}

      {view !== 'details' ? <section className="manual-rx-medicines">
        {hideSelectedList ? null : <section className="manual-rx-selected">
          <header className="manual-rx-section-heading">
            <span><small>Section 3</small><strong>Selected medicines</strong><em>Set pack quantities for every medicine printed on the prescription.</em></span>
            <span className="manual-rx-section-count">{prescription.items.length} selected</span>
          </header>

          <div className="manual-rx-selected__list">
            {prescription.items.length ? prescription.items.map((item, index) => {
              const product = catalogue.find(candidate => candidate.id === item.productId);
              const packSize = product?.packSize ?? (item.unitsNeededCount && item.qty ? item.unitsNeededCount / item.qty : null);
              const packUnit = product?.unit ?? 'units';
              const patientTotal = item.retail * item.qty;
              const wholesaleTotal = item.cost === null ? null : item.cost * item.qty;
              const contribution = wholesaleTotal === null ? null : patientTotal - wholesaleTotal;
              const margin = wholesaleTotal === null || patientTotal <= 0 ? null : Math.round((contribution! / patientTotal) * 100);
              const stockLabel = product?.availability === 'out' ? 'Out of stock' : product?.availability === 'low' ? 'Low stock' : product?.availability === 'in' ? 'In stock' : 'Stock check required';
              const stockPill = product?.availability === 'out' ? 'pill-red' : product?.availability === 'low' || product?.availability === 'unknown' ? 'pill-amber' : 'pill-green';
              return (
                <article className="manual-pack-card" key={item.productId}>
                  <header className="manual-pack-card__header">
                    <span className="manual-rx-medicines__number">{index + 1}</span>
                    <span className="manual-rx-medicines__identity">
                      <small>{catalogueTypeLabels[product?.type ?? 'other']} · Curaleaf pack</small>
                      <MedicineLabel name={item.name} />
                    </span>
                    <span className={`pill ${stockPill}`}>{stockLabel}</span>
                    <button type="button" className="icon-button danger" aria-label={`Remove ${item.name}`} onClick={() => onRemoveItem(item.productId)}><Trash2 size={14} /></button>
                  </header>

                  <div className="manual-pack-card__body">
                    <div className="manual-pack-fact">
                      <span><Package size={15} /><small>Supplier pack size</small></span>
                      <strong>{packSize ?? '—'} {packUnit}</strong>
                    </div>

                    <div className="manual-pack-quantity">
                      <small>Packs to order</small>
                      <div className="manual-pack-stepper" aria-label={`Packs of ${item.name}`}>
                        <button type="button" aria-label={`Reduce packs of ${item.name}`} disabled={item.qty <= 1} onClick={() => updatePackQuantity(item, item.qty - 1)}><Minus size={14} /></button>
                        <span><strong>{item.qty}</strong><small>{item.qty === 1 ? 'pack' : 'packs'}</small></span>
                        <button type="button" aria-label={`Add pack of ${item.name}`} disabled={item.qty >= 100} onClick={() => updatePackQuantity(item, item.qty + 1)}><Plus size={14} /></button>
                      </div>
                    </div>

                    <dl className="manual-pack-pricing">
                      <div><dt>{PATIENT_PRICE_LABEL}</dt><dd>{money(item.retail)}</dd></div>
                      <div><dt>{WHOLESALE_LABEL}</dt><dd>{item.cost === null ? 'Quote required' : money(wholesaleTotal!)}</dd><small>{item.cost === null ? 'Returned on quote' : `${money(item.cost)} / pack`}</small></div>
                      <div className={contribution !== null && contribution < 0 ? 'is-negative' : marginToneClass(margin)}><dt>Gross margin</dt><dd>{formatMargin(contribution, patientTotal)}</dd></div>
                      <div className="manual-pack-pricing__total"><dt>Patient total</dt><dd>{money(patientTotal)}</dd><small>{item.qty} × {money(item.retail)}</small></div>
                    </dl>
                  </div>
                </article>
              );
            }) : (
              <div className="manual-rx-selected__empty"><Package size={18} /><span><strong>No medicines selected yet</strong><small>Add every prescribed pack from the live catalogue below.</small></span></div>
            )}
          </div>
        </section>}

        <section className="manual-rx-picker">
          <div className="manual-rx-picker__heading">
            <span><small>{hideSelectedList ? 'Catalogue' : 'Section 4'}</small><strong>Add medicines from the live Curaleaf catalogue</strong><em>{hideSelectedList ? 'Selected packs and prices stay in the basket drawer at the bottom of the screen.' : 'Results stay open so you can add several prescribed products quickly.'}</em></span>
            <small>{filteredProducts.length} matching active pack{filteredProducts.length === 1 ? '' : 's'}</small>
          </div>
          <div className="manual-rx-picker__field">
            <Search size={15} />
            <input
              className="input"
              value={query}
              placeholder="Search medicine, strength or form"
              aria-label="Search the Curaleaf catalogue"
              onChange={event => setQuery(event.target.value)}
            />
          </div>
          <div className="manual-rx-picker__filters" role="group" aria-label="Filter catalogue by medicine type">
            <button type="button" aria-pressed={typeFilter === 'all'} onClick={() => setTypeFilter('all')}>All <small>{activeProducts.length}</small></button>
            {availableTypes.map(type => (
              <button type="button" key={type} aria-pressed={typeFilter === type} onClick={() => setTypeFilter(type)}>{catalogueTypeLabels[type]} <small>{activeProducts.filter(product => product.type === type).length}</small></button>
            ))}
          </div>
          <div className="manual-rx-picker__results" aria-live="polite" ref={resultsRef}>
            {visibleProducts.length ? visibleProducts.map(product => {
              const selected = selectedProductIds.has(product.id);
              return (
                <button type="button" key={product.id} disabled={selected} className={selected ? 'is-selected' : ''} onClick={() => addProduct(product)}>
                  <span className="manual-rx-picker__product"><small>{catalogueTypeLabels[product.type]} · active</small><MedicineLabel name={product.name} /></span>
                  <span className="manual-rx-picker__pack"><small>Pack size</small><strong>{product.packSize ?? '—'} {product.unit ?? 'units'}</strong></span>
                  <span className="manual-rx-picker__price"><small>{PATIENT_PRICE_LABEL}</small><strong>{money(product.retail)}</strong></span>
                  <span className="manual-rx-picker__wholesale" title={WHOLESALE_LABEL}>
                    <small>{WHOLESALE_LABEL_SHORT}</small>
                    <strong>{product.cost !== null ? money(product.cost) : '—'}</strong>
                  </span>
                  <span className="manual-rx-picker__margin">
                    <small>Margin</small>
                    <strong>{formatMargin(product.cost === null ? null : product.retail - product.cost, product.retail)}</strong>
                  </span>
                  <span className="manual-rx-picker__add">{selected ? <Check size={14} /> : <Plus size={14} />} {selected ? 'Added' : 'Add'}</span>
                </button>
              );
            }) : <span className="manual-rx-picker__empty">No active Curaleaf packs match this search and medicine type.</span>}
          </div>
          {filteredProducts.length > pageSize ? (
            <nav className="manual-rx-picker__pager" aria-label="Catalogue pages">
              <button
                type="button"
                className="btn btn-secondary btn-sm"
                disabled={currentPage <= 1}
                onClick={() => {
                  setPage(currentPage - 1);
                  resultsRef.current?.scrollTo({ top: 0, behavior: window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth' });
                }}
              >
                <ChevronLeft size={14} aria-hidden="true" /> Previous
              </button>
              <span>Showing {rangeStart + 1}–{rangeEnd} of {filteredProducts.length} · Page {currentPage} of {pageCount}</span>
              <button
                type="button"
                className="btn btn-secondary btn-sm"
                disabled={currentPage >= pageCount}
                onClick={() => {
                  setPage(currentPage + 1);
                  resultsRef.current?.scrollTo({ top: 0, behavior: window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth' });
                }}
              >
                Next <ChevronRight size={14} aria-hidden="true" />
              </button>
            </nav>
          ) : null}
        </section>
      </section> : null}
    </div>
  );
}
