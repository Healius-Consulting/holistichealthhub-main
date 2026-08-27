import { SqlIntegrationRepository } from '../../repositories/sql/integration.sql.js';
import { SqlFulfilmentRepository } from '../../repositories/sql/fulfilment.sql.js';
import { SqlIdentityRepository } from '../../repositories/sql/identity.sql.js';
import { SqlNotificationRepository } from '../../repositories/sql/notification.sql.js';
import { SqlOrganisationRepository } from '../../repositories/sql/organisation.sql.js';
import { SqlOrderRepository } from '../../repositories/sql/order.sql.js';
import { SqlPatientFinanceRepository } from '../../repositories/sql/patient-finance.sql.js';
import { SqlPatientRepository } from '../../repositories/sql/patient.sql.js';
import { SqlPaymentRepository } from '../../repositories/sql/payment.sql.js';
import { SqlPrescriptionRepository } from '../../repositories/sql/prescription.sql.js';

export function sqlWorkerDeps() {
  const paymentRepo = new SqlPaymentRepository();
  const orderRepo = new SqlOrderRepository();
  const integrationRepo = new SqlIntegrationRepository();
  const identityRepo = new SqlIdentityRepository();
  const fulfilmentRepo = new SqlFulfilmentRepository();
  const patientRepo = new SqlPatientRepository();
  const patientFinanceRepo = new SqlPatientFinanceRepository();
  const notificationRepo = new SqlNotificationRepository();
  const organisationRepo = new SqlOrganisationRepository();
  const prescriptionRepo = new SqlPrescriptionRepository();
  return {
    paymentRepo,
    orderRepo,
    integrationRepo,
    identityRepo,
    fulfilmentRepo,
    patientRepo,
    patientFinanceRepo,
    patientFinanceDeps: { patientRepo, patientFinanceRepo },
    notificationRepo,
    organisationRepo,
    prescriptionRepo,
  };
}
