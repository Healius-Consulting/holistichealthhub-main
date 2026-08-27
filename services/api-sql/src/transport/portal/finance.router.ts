import { Router, type NextFunction, type Request, type Response } from 'express';
import { z } from 'zod';
import { dataConnect } from '../../bootstrap/firebase.js';
import { HttpError } from '../../domain/common/errors.js';
import { assertPlatformScope, assertTenantScope } from '../../security/request-context.js';
import { requireStaff } from '../../security/require-staff.js';
import { buildPharmacyLedgerRows, isAwaitingPaymentRow } from '../../application/finance/pharmacy-ledger.js';
import { SqlCuraleafQuoteBankRepository } from '../../repositories/sql/curaleaf-quote-bank.sql.js';
import { SqlIntegrationRepository } from '../../repositories/sql/integration.sql.js';
import { SqlOrderRepository } from '../../repositories/sql/order.sql.js';
import { SqlPatientRepository } from '../../repositories/sql/patient.sql.js';
import { SqlPaymentRepository } from '../../repositories/sql/payment.sql.js';
import { isTrainingDirectoryOrganisation } from '../../domain/organisation/training-directory.js';

const organisationIdSchema = z.string().regex(/^(?:[a-f\d]{32}|[a-f\d]{8}(?:-[a-f\d]{4}){3}-[a-f\d]{12})$/i);

const financeDateRangeSchema = z.object({
  from: z.iso.date().optional(),
  to: z.iso.date().optional(),
}).strict();

const adminFinanceQuerySchema = z.object({
  from: z.iso.date().optional(),
  to: z.iso.date().optional(),
  organisationId: organisationIdSchema.optional(),
}).strict();

const LIST_REFERRAL_FEES_GQL = `
  query ListReferralFeeEvents {
    referralFeeEvents(limit: 20001, orderBy: { createdAt: DESC }) {
      id organisationId patientId kind amountPence dueDate status createdAt settledAt
      organisation { name tradingName classification }
      patient { firstName surname email }
    }
  }
`;

type FeeRow = {
  id: string; organisationId: string; patientId: string; kind: 'NEW_REFERRAL' | 'ANNUAL_PATIENT';
  amountPence: number | string; dueDate: string; status: string; createdAt: string; settledAt: string | null;
  organisation: { name?: string | null; tradingName: string; classification?: string | null } | null;
  patient: { firstName: string; surname: string; email: string } | null;
};

function inDateRange(dateStr: string | null | undefined, from?: string, to?: string) {
  if (!dateStr) return false;
  const d = dateStr.slice(0, 10);
  if (from && d < from) return false;
  if (to && d > to) return false;
  return true;
}

function financePeriodCounts(rows: Array<{ realised: boolean; financialEventAt: string }>, now = Date.now()) {
  const realised = rows.filter(r => r.realised && r.financialEventAt);
  const countSince = (days: number) => {
    const threshold = new Date(now - days * 86_400_000).toISOString().slice(0, 10);
    return realised.filter(r => r.financialEventAt.slice(0, 10) >= threshold).length;
  };
  return {
    '30': countSince(30),
    '90': countSince(90),
    '365': countSince(365),
    all: realised.length,
  };
}

/** Platform-only referral accrual ledger. It is deliberately separate from
 * payment settlement: a fee event is auditable commercial attribution, not an invoice. */
export function createPortalFinanceRouter(): Router {
  const router = Router();
  const orderRepo = new SqlOrderRepository();
  const patientRepo = new SqlPatientRepository();
  const paymentRepo = new SqlPaymentRepository();
  const integrationRepo = new SqlIntegrationRepository();
  const quoteBankRepo = new SqlCuraleafQuoteBankRepository();

  /**
   * Wholesale pack prices from the shared Curaleaf quote bank, used only to estimate
   * orders that never had a paid quote frozen. Never fatal: a bank outage just means
   * those rows stay honestly "awaiting quote".
   */
  const quoteBankWholesaleByPack = async (organisationId: string) => {
    try {
      const connection = await integrationRepo.findConnection(organisationId, 'CURALEAF');
      if (!connection) return new Map<string, number>();
      const entries = await quoteBankRepo.listEntries(connection.environment);
      return new Map(entries.map(entry => [entry.packId, entry.wholesalePackPricePence]));
    } catch (error) {
      console.warn('[Finance] Curaleaf quote bank unavailable for cost estimates:', error);
      return new Map<string, number>();
    }
  };

  router.get('/portal/finance/prescriptions', requireStaff('pharmacy'), async (req: Request, res: Response, next: NextFunction) => {
    try {
      const scope = assertTenantScope(req.context!);
      const organisationId = scope.organisationId;

      const filters = financeDateRangeSchema.parse({
        from: req.query.from,
        to: req.query.to,
      });

      const [rawOrders, rawPatients, rawAllocations, bankWholesalePenceByPackId] = await Promise.all([
        orderRepo.listTenantOrders(organisationId, 2000),
        patientRepo.listTenantPatients(organisationId, 2000),
        paymentRepo.listTenantPaymentAllocations(organisationId, 4000),
        quoteBankWholesaleByPack(organisationId),
      ]);

      const patientMap = new Map(rawPatients.map(p => [p.id, `${p.firstName} ${p.surname}`.trim() || p.email]));
      const activeAllocationByOrder = new Map<string, number>();
      for (const allocation of rawAllocations) {
        if (allocation.status !== 'ACTIVE') continue;
        activeAllocationByOrder.set(allocation.orderId, (activeAllocationByOrder.get(allocation.orderId) ?? 0) + Number(allocation.amountPence));
      }

      const datedRows = buildPharmacyLedgerRows({
        orders: rawOrders,
        patientNameById: patientMap,
        activeAllocationByOrder,
        bankWholesalePenceByPackId,
      });

      const rangedRows = datedRows
        .filter(row => inDateRange(row.financialEventAt, filters.from, filters.to))
        .sort((left, right) => right.financialEventAt.localeCompare(left.financialEventAt));

      const realisedRows = rangedRows.filter(r => r.realised);
      const pendingCollectionRows = rangedRows.filter(r => r.pendingCollection);
      const refundedRows = rangedRows.filter(r => r.refunded || r.partialRefund);
      const refundPendingRows = rangedRows.filter(r => r.refundPending);
      const pendingPaymentRows = rangedRows.filter(isAwaitingPaymentRow);
      const costedRows = realisedRows.filter(r => r.wholesaleComplete);

      const totals = {
        prescriptionCount: rangedRows.length,
        paidPrescriptionCount: realisedRows.length,
        pendingCollectionCount: pendingCollectionRows.length,
        pendingPatientRevenuePence: pendingCollectionRows.reduce((sum, r) => sum + r.patientRevenuePence, 0),
        pendingPrescriptionCount: pendingPaymentRows.length,
        refundedPrescriptionCount: refundedRows.length,
        refundedPatientPence: refundedRows.reduce((sum, r) => sum + r.refundAmountPence, 0),
        refundPendingCount: refundPendingRows.length,
        refundPendingPatientPence: refundPendingRows.reduce((sum, r) => sum + r.patientRevenuePence, 0),
        patientRevenuePence: realisedRows.reduce((sum, r) => sum + r.patientRevenuePence, 0),
        productRevenuePence: realisedRows.reduce((sum, r) => sum + r.productRevenuePence, 0),
        dispensingFeesPence: realisedRows.reduce((sum, r) => sum + r.dispensingFeePence, 0),
        wholesaleKnownForCount: costedRows.length,
        wholesalePendingForCount: realisedRows.length - costedRows.length,
        wholesaleEstimatedForCount: costedRows.filter(r => r.wholesaleEstimated).length,
        wholesaleProductPence: costedRows.reduce((sum, r) => sum + (r.wholesaleProductPence ?? 0), 0),
        shippingPence: costedRows.reduce((sum, r) => sum + (r.shippingKnown ? r.shippingPence ?? 0 : 0), 0),
        wholesalePence: costedRows.reduce((sum, r) => sum + (r.wholesalePence ?? 0), 0),
        productMarginPence: costedRows.reduce((sum, r) => sum + (r.productMarginPence ?? 0), 0),
        totalContributionPence: costedRows.reduce((sum, r) => sum + (r.totalContributionPence ?? 0), 0),
      };

      res.setHeader('Cache-Control', 'no-store');
      res.status(200).json({
        organisationId,
        currency: 'GBP',
        range: { from: filters.from ?? null, to: filters.to ?? null },
        periodCounts: financePeriodCounts(datedRows),
        totals,
        rows: rangedRows,
      });
    } catch (error) { next(error); }
  });

  router.get('/portal/admin/finance/referrals', requireStaff('admin'), async (req: Request, res: Response, next: NextFunction) => {
    try {
      assertPlatformScope(req.context!);
      const filters = adminFinanceQuerySchema.parse({
        from: req.query.from,
        to: req.query.to,
        organisationId: req.query.organisationId,
      });
      if (filters.from && filters.to && filters.from > filters.to) {
        throw new HttpError(400, 'The reporting start date must be before the end date.', 'INVALID_DATE_RANGE');
      }
      const result = await dataConnect.executeGraphql<{ referralFeeEvents: FeeRow[] }, Record<string, never>>(
        LIST_REFERRAL_FEES_GQL,
        { variables: {} },
      );
      const all = result.data.referralFeeEvents ?? [];
      if (all.length > 20_000) {
        throw new HttpError(413, 'The fee ledger is too large for one report. Select a narrower date range.', 'REPORT_SCOPE_TOO_LARGE');
      }
      const rows = all
        .filter(event => !isTrainingDirectoryOrganisation({
          id: event.organisationId,
          name: event.organisation?.name,
          tradingName: event.organisation?.tradingName,
          classification: event.organisation?.classification,
        }))
        .filter(event => !filters.organisationId || event.organisationId === filters.organisationId)
        .filter(event => !filters.from || event.dueDate >= filters.from!)
        .filter(event => !filters.to || event.dueDate <= filters.to!)
        .map(event => ({
          id: event.id,
          organisationId: event.organisationId,
          pharmacyName: event.organisation?.tradingName ?? 'Unknown pharmacy',
          patientId: event.patientId,
          patientName: event.patient ? `${event.patient.firstName} ${event.patient.surname}`.trim() : 'Patient record',
          patientEmail: event.patient?.email ?? '',
          referralSubmissionId: null,
          kind: event.kind === 'ANNUAL_PATIENT' ? 'annual_patient' as const : 'new_referral' as const,
          amountPence: Number(event.amountPence),
          currency: 'GBP' as const,
          dueDate: event.dueDate,
          occurredAt: event.createdAt,
        }));
      const byPharmacy = new Map<string, { organisationId: string; pharmacyName: string; newReferralCount: number; annualPatientCount: number; amountPence: number }>();
      for (const row of rows) {
        const current = byPharmacy.get(row.organisationId) ?? { organisationId: row.organisationId, pharmacyName: row.pharmacyName, newReferralCount: 0, annualPatientCount: 0, amountPence: 0 };
        current.amountPence += row.amountPence;
        if (row.kind === 'new_referral') current.newReferralCount += 1;
        else current.annualPatientCount += 1;
        byPharmacy.set(row.organisationId, current);
      }
      res.setHeader('Cache-Control', 'no-store');
      res.status(200).json({
        currency: 'GBP',
        range: { from: filters.from ?? null, to: filters.to ?? null },
        organisationId: filters.organisationId ?? null,
        totals: {
          eventCount: rows.length,
          newReferralCount: rows.filter(row => row.kind === 'new_referral').length,
          annualPatientCount: rows.filter(row => row.kind === 'annual_patient').length,
          amountPence: rows.reduce((total, row) => total + row.amountPence, 0),
        },
        byPharmacy: [...byPharmacy.values()].sort((left, right) => right.amountPence - left.amountPence),
        rows,
      });
    } catch (error) { next(error); }
  });

  return router;
}
