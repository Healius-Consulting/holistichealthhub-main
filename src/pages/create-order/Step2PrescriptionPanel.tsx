import { AlertTriangle, CheckCircle, FileScan, FileText, Pencil, RefreshCw, ShieldCheck, Trash2, Upload } from 'lucide-react';
import ManualPrescriptionEditor from '../../components/ManualPrescriptionEditor';
import ProviderStatusNotice from '../../components/ProviderStatusNotice';
import type { CatalogueItem, LineItem, Prescription } from '../../context/AppContext';
import { PRESCRIPTION_FILE_ACCEPT } from '../../utils/prescriptionFile';
import type { RxSubStep } from './types';

type Step2PrescriptionPanelProps = {
  selectedRx: Prescription;
  rxSubStep: RxSubStep;
  routeChosen: boolean;
  isLocalPreview: boolean;
  workspaceMode: string;
  catalogue: CatalogueItem[];
  scanError: string | null;
  uploadingRxId: number | null;
  readingRxId: number | null;
  fileRemovalBusyRxId: number | null;
  confirmingFileRemoveRxId: number | null;
  confirmingRouteSwitch: 'clinic' | 'manual' | null;
  onChooseRoute: (mode: 'clinic' | 'manual') => void;
  onApplyRouteSwitch: (mode: 'clinic' | 'manual') => void;
  onCancelRouteSwitch: () => void;
  onAttachFile: (file: File) => void;
  onSyntheticScan: () => void;
  onRetryBarcode: () => void;
  onRequestRemoveFile: () => void;
  onConfirmRemoveFile: () => void;
  onCancelRemoveFile: () => void;
  onPrescriberChange: (value: string) => void;
  onMetadataChange: (field: string, value: string) => void;
  onAddItem: (item: LineItem) => void;
  onRemoveItem: (productId: string) => void;
  onUpdateQuantity: (productId: string, qty: number) => void;
  onUpdateUnits: (productId: string, unitsNeededCount: number) => void;
};

export default function Step2PrescriptionPanel({
  selectedRx,
  rxSubStep,
  routeChosen,
  isLocalPreview,
  workspaceMode,
  catalogue,
  scanError,
  uploadingRxId,
  readingRxId,
  fileRemovalBusyRxId,
  confirmingFileRemoveRxId,
  confirmingRouteSwitch,
  onChooseRoute,
  onApplyRouteSwitch,
  onCancelRouteSwitch,
  onAttachFile,
  onSyntheticScan,
  onRetryBarcode,
  onRequestRemoveFile,
  onConfirmRemoveFile,
  onCancelRemoveFile,
  onPrescriberChange,
  onMetadataChange,
  onAddItem,
  onRemoveItem,
  onUpdateQuantity,
  onUpdateUnits,
}: Step2PrescriptionPanelProps) {
  const uploaded = Boolean(selectedRx.copyFileName || selectedRx.clinicScanId);
  const showUpload = routeChosen;
  const showDetails = uploaded;

  return (
    <section id="rx-step-2" className="rx-surface card rx-create-step rx-step2-panel">
      <header className="rx-surface__header">
        <div className="section-heading" style={{ margin: 0 }}>
          <div>
            <p className="section-label">Step 2 · Prescription</p>
            <h3><FileText size={17} /> Authenticate the prescription</h3>
          </div>
        </div>
      </header>

      <div className="rx-step2-panel__body">
        <div className={`rx-step2-section${rxSubStep === 'route' ? ' is-current' : routeChosen ? ' is-complete' : ''}`}>
          {rxSubStep === 'route' ? <span className="rx-guided-active-indicator" aria-hidden="true" /> : null}
          <p className="section-label">Route</p>
          <p className="rx-guided__route-lead">Choose one route for this draft. Next you will upload the prescription copy.</p>
          <div className="rx-entry-mode rx-entry-mode--choose" role="group" aria-label="Prescription entry route">
            <button type="button" aria-pressed={routeChosen && selectedRx.entryMode === 'clinic'} onClick={() => onChooseRoute('clinic')}>
              <FileScan size={15} /><span><strong>Scan Curaleaf QR</strong><small>Then upload the prescription with a clear barcode</small></span>
            </button>
            <button type="button" aria-pressed={routeChosen && selectedRx.entryMode === 'manual'} onClick={() => onChooseRoute('manual')}>
              <Pencil size={15} /><span><strong>Enter details manually</strong><small>Then upload the signed copy and type the fields</small></span>
            </button>
          </div>
          {confirmingRouteSwitch ? (
            <div className="rx-prescription-cancel-confirm" role="alertdialog" aria-modal="true" aria-label="Switch prescription entry route">
              <AlertTriangle size={16} />
              <span>
                <strong>Switch to {confirmingRouteSwitch === 'clinic' ? 'Curaleaf QR' : 'manual entry'}?</strong>
                <small>This clears the current upload and prescription details. Medicines already chosen will also be removed.</small>
              </span>
              <div>
                <button type="button" className="btn btn-secondary btn-sm" onClick={onCancelRouteSwitch}>Keep current route</button>
                <button type="button" className="btn btn-danger btn-sm" onClick={() => onApplyRouteSwitch(confirmingRouteSwitch)}>Switch route</button>
              </div>
            </div>
          ) : null}
        </div>

        {showUpload ? (
          <div className={`rx-step2-section${rxSubStep === 'upload' ? ' is-current' : uploaded ? ' is-complete' : ''}`}>
            {rxSubStep === 'upload' ? <span className="rx-guided-active-indicator" aria-hidden="true" /> : null}
            <p className="section-label">Upload</p>
            <div className="rx-clinic-note">
              <Upload size={18} aria-hidden="true" />
              <span>
                <strong>{selectedRx.entryMode === 'clinic' ? 'Clear barcode required' : 'All other details must stay visible'}</strong>
                <span>{selectedRx.entryMode === 'clinic' ? 'Attach a redacted copy (redact patient details) of the prescription with a clear barcode. (TIP: Apply a blank dispensing label to cover confidential patient details).' : 'Attach a redacted copy (redact patient details) of the prescription with all other prescription details clearly visible. (TIP: Apply a blank dispensing label to cover confidential patient details).'}</span>
              </span>
            </div>
            {(isLocalPreview || workspaceMode === 'training') && selectedRx.entryMode === 'clinic' ? (
              <button type="button" className={`rx-document-control${selectedRx.clinicScanId ? ' uploaded' : ''}`} onClick={onSyntheticScan}>
                {selectedRx.clinicScanId ? <CheckCircle size={18} /> : <FileScan size={18} />}
                <span><strong>{selectedRx.clinicScanId ? 'Synthetic Clinic barcode verified' : 'Use synthetic Clinic barcode'}</strong><small>Isolated local training fixture · nothing is uploaded or sent</small></span>
              </button>
            ) : (
              <label className={`rx-document-control${selectedRx.copyFileName ? ' uploaded' : ''}${readingRxId === selectedRx.id ? ' scanning' : ''}`}>
                <input className="sr-only" type="file" accept={PRESCRIPTION_FILE_ACCEPT} disabled={uploadingRxId !== null} onChange={event => { const file = event.target.files?.[0]; event.currentTarget.value = ''; if (file) onAttachFile(file); }} />
                {selectedRx.clinicScanId ? <CheckCircle size={18} /> : readingRxId === selectedRx.id ? <RefreshCw size={18} className="spin" /> : <Upload size={18} />}
                <span><strong>{uploadingRxId === selectedRx.id ? 'Uploading securely…' : readingRxId === selectedRx.id ? 'Curaleaf is reading its barcode…' : selectedRx.copyFileName ?? (selectedRx.entryMode === 'manual' ? 'Attach signed prescription' : 'Attach barcode prescription')}</strong><small>{selectedRx.clinicScanId ? 'Barcode verified and linked to this prescription' : selectedRx.fileId ? 'Uploaded and server-verified' : 'PDF, JPG or PNG · maximum 16 MB'}</small></span>
              </label>
            )}
            {selectedRx.entryMode === 'clinic' && workspaceMode === 'live' && !isLocalPreview && selectedRx.fileId && !selectedRx.clinicScanId && readingRxId !== selectedRx.id ? (
              <button type="button" className="btn btn-sm rx-scan-retry" onClick={onRetryBarcode}><RefreshCw size={13} /> Check barcode again</button>
            ) : null}
            {selectedRx.copyFileName ? (
              <div className="rx-document-actions">
                <span>Choose the upload control above to replace this copy.</span>
                <button type="button" className="btn btn-sm btn-danger" disabled={fileRemovalBusyRxId === selectedRx.id} onClick={onRequestRemoveFile}><Trash2 size={13} /> Remove copy</button>
              </div>
            ) : null}
            {confirmingFileRemoveRxId === selectedRx.id ? (
              <div className="rx-prescription-cancel-confirm" role="alertdialog" aria-modal="true" aria-label={`Remove ${selectedRx.copyFileName}`}>
                <AlertTriangle size={16} />
                <span><strong>Remove {selectedRx.copyFileName}?</strong><small>The encrypted copy will be removed from this draft. You can then upload a replacement.</small></span>
                <div><button type="button" className="btn btn-secondary btn-sm" onClick={onCancelRemoveFile}>Keep copy</button><button type="button" className="btn btn-danger btn-sm" disabled={fileRemovalBusyRxId === selectedRx.id} onClick={onConfirmRemoveFile}>{fileRemovalBusyRxId === selectedRx.id ? 'Removing…' : 'Remove copy'}</button></div>
              </div>
            ) : null}
            {selectedRx.entryMode === 'clinic' && scanError ? (
              <ProviderStatusNotice title="Barcode not verified" detail={`${scanError} Check that the full Curaleaf Clinic barcode is sharp and visible. If it still fails, use the manual route or contact your HHH administrator.`} />
            ) : null}
          </div>
        ) : null}

        {showDetails ? (
          <div className={`rx-step2-section${rxSubStep === 'details' ? ' is-current' : ''}`}>
            {rxSubStep === 'details' ? <span className="rx-guided-active-indicator" aria-hidden="true" /> : null}
            <p className="section-label">{selectedRx.entryMode === 'manual' ? 'Manual details' : 'Scan result'}</p>
            {selectedRx.entryMode === 'manual' ? (
              <ManualPrescriptionEditor
                view="details"
                prescription={selectedRx}
                catalogue={catalogue}
                onPrescriberChange={onPrescriberChange}
                onMetadataChange={onMetadataChange}
                onAddItem={onAddItem}
                onRemoveItem={onRemoveItem}
                onUpdateQuantity={onUpdateQuantity}
                onUpdateUnits={onUpdateUnits}
              />
            ) : selectedRx.clinicScanId ? (
              <div className="rx-clinic-result" aria-label="Curaleaf verified prescription details">
                <div className="rx-clinic-result__status"><ShieldCheck size={18} /><span><strong>{isLocalPreview ? 'Synthetic Curaleaf response' : 'Verified by Curaleaf'}</strong><small>{isLocalPreview ? 'Read-only local training fixture' : 'Read-only supplier record'} · {selectedRx.curaleafPrescriptionState}</small></span></div>
                <dl>
                  <div><dt>Prescription serial</dt><dd>{selectedRx.serialNumber}</dd></div>
                  <div><dt>Prescriber</dt><dd>{selectedRx.prescriber}</dd></div>
                  <div><dt>Issued</dt><dd>{selectedRx.issueDate ? new Date(`${selectedRx.issueDate}T00:00:00`).toLocaleDateString('en-GB') : '—'}</dd></div>
                  <div><dt>Expires</dt><dd>{selectedRx.expiryDate ? new Date(`${selectedRx.expiryDate}T00:00:00`).toLocaleDateString('en-GB') : '—'}</dd></div>
                  <div><dt>Registration</dt><dd>{selectedRx.prescriberGmcNumber ? `GMC ${selectedRx.prescriberGmcNumber}` : selectedRx.prescriberGphcNumber ? `GPhC ${selectedRx.prescriberGphcNumber}` : 'Held by Curaleaf'}</dd></div>
                </dl>
              </div>
            ) : (
              <p className="rx-scan-waiting">No prescription fields need completing. They appear here after Curaleaf verifies the barcode.</p>
            )}
          </div>
        ) : null}
      </div>
    </section>
  );
}
