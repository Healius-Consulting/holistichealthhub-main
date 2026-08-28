import { ShieldCheck } from 'lucide-react';
import { orderReference, type PatientOrder } from '../../context/AppContext';
import { replacementBannerState } from '../../utils/replacementPrescriptionCopy';

type ReplacementBannerProps = {
  activeOrder: PatientOrder;
  activeOrderRef: string;
  redoSourceOrder: PatientOrder | null;
  medicineCount: number;
};

export default function ReplacementBanner({
  activeOrder,
  activeOrderRef,
  redoSourceOrder,
  medicineCount,
}: ReplacementBannerProps) {
  const banner = replacementBannerState(activeOrder.prescriptions[0]);
  return (
    <section className="rx-replacement-context card" aria-label={`Replacement order ${activeOrderRef}`}>
      <span className="rx-replacement-context__mark">{activeOrderRef.replace(/^#\d+/, '')}</span>
      <span className="rx-replacement-context__identity">
        <p className="section-label">Replacement prescription</p>
        <strong>Order {activeOrderRef}</strong>
        <small>
          Replaces order {redoSourceOrder ? orderReference(redoSourceOrder) : `#${activeOrder.redoContext!.originalOrderId}`}
          {' · '}{activeOrder.redoContext!.reason === 'rejected' ? 'Curaleaf rejected' : 'Prescription expired'}
        </small>
      </span>
      <span className="rx-replacement-context__carry">
        <strong>{medicineCount} medicine{medicineCount === 1 ? '' : 's'} carried forward</strong>
        <small>{banner.serialDetail}</small>
      </span>
      <span className="rx-replacement-context__next">
        <ShieldCheck size={15} />
        <span>
          <strong>{banner.serialCarried ? banner.scanTitle : banner.serialTitle}</strong>
          <small>{banner.serialCarried ? banner.scanDetail : banner.serialDetail}</small>
        </span>
      </span>
    </section>
  );
}
