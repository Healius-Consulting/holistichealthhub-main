import { CheckCircle, FileScan, FileText, Pencil, RefreshCw, Save, ShieldCheck } from 'lucide-react';
import ManualPrescriptionEditor from '../../components/ManualPrescriptionEditor';
import MedicineLabel from '../../components/MedicineLabel';
import ProviderStatusNotice from '../../components/ProviderStatusNotice';
import type { CatalogueItem, LineItem, Prescription } from '../../context/AppContext';
import { isCuraleafTestCatalogue } from '../../utils/catalogueEstate';
import { catalogueStockLabel, catalogueStockPillClass, catalogueStockStatus } from '../../utils/catalogueStock';

type Step3FormularyPanelProps = {
  selectedRx: Prescription | null;
  catalogue: CatalogueItem[];
  catalogueLoading: boolean;
  catalogueError: string | null;
  catalogueSource?: 'curaleaf' | 'training' | 'unavailable';
  catalogueEnvironment?: string;
  onRetryCatalogue: () => void;
  editingClinicFormulary: boolean;
  onToggleEditFormulary: () => void;
  onSaveFormulary: () => void;
  onPrescriberChange: (value: string) => void;
  onMetadataChange: (field: string, value: string) => void;
  onUnlockInheritedSerial?: () => void;
  onAddItem: (item: LineItem) => void;
  onRemoveItem: (productId: string) => void;
  onUpdateQuantity: (productId: string, qty: number) => void;
  onUpdateUnits: (productId: string, unitsNeededCount: number) => void;
};

export default function Step3FormularyPanel({
  selectedRx,
  catalogue,
  catalogueLoading,
  catalogueError,
  catalogueSource,
  catalogueEnvironment,
  onRetryCatalogue,
  editingClinicFormulary,
  onToggleEditFormulary,
  onSaveFormulary,
  onPrescriberChange,
  onMetadataChange,
  onUnlockInheritedSerial,
  onAddItem,
  onRemoveItem,
  onUpdateQuantity,
  onUpdateUnits,
}: Step3FormularyPanelProps) {
  const manualOrEditing = selectedRx?.entryMode === 'manual' || editingClinicFormulary;

  return (
    <section id="rx-step-3" className="rx-surface card rx-formulary-stage rx-create-step">
      <header className="rx-surface__header">
        <div className="section-heading" style={{ margin: 0 }}>
          <div>
            <p className="section-label">Step 3 · Products</p>
            <h3>
              <ShieldCheck size={17} />
              {selectedRx?.entryMode === 'manual'
                ? 'Select the prescribed Curaleaf medicines'
                : editingClinicFormulary
                  ? 'Correct the Curaleaf formula and pack match'
                  : 'Review the Curaleaf formula and pack match'}
            </h3>
          </div>
        </div>
        <div className="rx-formulary-actions">
          {selectedRx?.items.length ? (
            <span className="pill pill-green">
              <CheckCircle size={11} /> {selectedRx.entryMode === 'clinic' && !editingClinicFormulary ? 'Matched automatically' : `${selectedRx.items.length} selected`}
            </span>
          ) : null}
          {selectedRx?.entryMode === 'clinic' && selectedRx.clinicScanId ? (
            editingClinicFormulary ? (
              <button type="button" className="btn btn-sm btn-primary" onClick={onSaveFormulary}><Save size={13} /> Save formulary</button>
            ) : (
              <button type="button" className="btn btn-secondary btn-sm" onClick={onToggleEditFormulary}><Pencil size={13} /> Edit formulary</button>
            )
          ) : null}
        </div>
      </header>
      {catalogueLoading ? <ProviderStatusNotice state="loading" title="Refreshing Curaleaf products" detail="The latest patient prices and pack information are being retrieved." /> : null}
      {catalogueError ? (
        <ProviderStatusNotice
          title="Curaleaf information is temporarily delayed"
          detail="Try again now. If this continues, contact your HHH administrator; pharmacy staff do not need to change the connection."
          action={(
            <button type="button" className="btn btn-secondary btn-sm" onClick={onRetryCatalogue}>
              <RefreshCw size={14} aria-hidden="true" /> Try again
            </button>
          )}
        />
      ) : null}
      {isCuraleafTestCatalogue(catalogueSource, catalogueEnvironment) ? (
        <ProviderStatusNotice
          state="waiting"
          title="Curaleaf test catalogue"
          detail="Prices and stock are from the sandbox estate."
        />
      ) : null}
      {/* An empty catalogue with no error is its own dead end — medicines cannot be
          added and nothing on screen says why — so it gets the same way out. */}
      {!catalogueLoading && !catalogueError && catalogue.length === 0 ? (
        <ProviderStatusNotice
          title="Catalogue has not loaded"
          detail="Medicines cannot be added until the Curaleaf catalogue arrives. Try again now; if it stays empty, contact your HHH administrator."
          action={(
            <button type="button" className="btn btn-secondary btn-sm" onClick={onRetryCatalogue}>
              <RefreshCw size={14} aria-hidden="true" /> Try again
            </button>
          )}
        />
      ) : null}
      {!selectedRx ? (
        <div className="rx-inline-empty"><FileText size={20} /><span><strong>Select a prescription record</strong><small>Its prescribed medicines will appear here.</small></span></div>
      ) : manualOrEditing ? (
        <ManualPrescriptionEditor
          view="formulary"
          hideSelectedList
          prescription={selectedRx}
          catalogue={catalogue}
          onPrescriberChange={onPrescriberChange}
          onMetadataChange={onMetadataChange}
          onUnlockInheritedSerial={onUnlockInheritedSerial}
          onAddItem={onAddItem}
          onRemoveItem={onRemoveItem}
          onUpdateQuantity={onUpdateQuantity}
          onUpdateUnits={onUpdateUnits}
        />
      ) : (
        <div className="rx-line-editor">
          <div className="rx-line-editor__heading"><span><small>Curaleaf formulary result</small><strong>{selectedRx.items.length} prescribed product{selectedRx.items.length === 1 ? '' : 's'}</strong></span><span>Matched automatically · read-only</span></div>
          {selectedRx.items.length === 0 ? (
            <div className="rx-inline-empty"><FileScan size={20} /><span><strong>Medicines appear after the barcode scan</strong><small>Curaleaf supplies the formula, prescribed quantity and matching pack automatically.</small></span></div>
          ) : (
            <div className="rx-item-stack">
              {selectedRx.items.map((item, index) => {
                const product = catalogue.find(candidate => candidate.id === item.productId);
                const stock = product ? catalogueStockStatus(product) : 'unknown';
                return (
                  <article className="rx-prescribed-item" key={item.productId}>
                    <header className="rx-prescribed-item__header">
                      <span className="rx-prescribed-item__index">Medicine {String(index + 1).padStart(2, '0')}</span>
                      <span className="rx-prescribed-item__identity"><MedicineLabel name={item.name} /><small>Matched from the Curaleaf prescription · {item.qty} {item.qty === 1 ? 'pack' : 'packs'} · {item.unitsNeededCount ?? '—'} {product?.unit ?? 'units'}</small></span>
                      <span className={`pill ${catalogueStockPillClass(stock)}`}>{catalogueStockLabel(stock)}</span>
                    </header>
                  </article>
                );
              })}
            </div>
          )}
        </div>
      )}
    </section>
  );
}
