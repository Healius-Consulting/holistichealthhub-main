import express, { type Express, type Request, type Response, type NextFunction } from 'express';
import helmet from 'helmet';
import cors from 'cors';
import { z } from 'zod';
import { HttpError } from '../domain/common/errors.js';
import { isPermittedWebOrigin } from '../security/origins.js';
import { requireAppCheck } from '../security/app-check.js';
import { createAuthRouter } from '../transport/public/auth.router.js';
import { createDirectoryRouter } from '../transport/public/directory.router.js';
import { createPortalSetupRouter } from '../transport/portal/setup.router.js';
import { createPublicEligibilityRouter } from '../transport/public/eligibility.router.js';
import { createPortalPrescriptionRouter } from '../transport/portal/prescription.router.js';
import { createPortalOrderRouter } from '../transport/portal/order.router.js';
import { createPublicPaymentRouter } from '../transport/public/payment.router.js';
import { createPortalPaymentRouter } from '../transport/portal/payment.router.js';
import { createPortalFulfilmentRouter } from '../transport/portal/fulfilment.router.js';
import { createPortalPharmacyRouter } from '../transport/portal/pharmacy.router.js';
import { createPublicPostcodeSearchRouter } from '../transport/public/postcode-search.router.js';
import { createPublicIntakeV2Router } from '../transport/public/intake-v2.router.js';
import { createPortalIntakeV2Router } from '../transport/portal/intake-v2.router.js';
import { createAdminStaffRouter } from '../transport/portal/admin-staff.router.js';
import { createAdminPatientRouter } from '../transport/portal/admin-patient.router.js';
import { createPortalIntegrationRouter } from '../transport/portal/integration.router.js';
import { createPortalFinanceRouter } from '../transport/portal/finance.router.js';

export function isOriginPermitted(origin: string | undefined): boolean {
  return isPermittedWebOrigin(origin);
}

export function createApp(): Express {
  const app = express();

  app.set('trust proxy', 1);

  app.use(helmet({
    contentSecurityPolicy: false,
    crossOriginEmbedderPolicy: false,
  }));

  app.use(cors({
    origin: (origin, callback) => {
      if (isOriginPermitted(origin)) {
        callback(null, true);
      } else {
        callback(new HttpError(403, 'CORS origin denied.', 'CORS_DENIED'));
      }
    },
    credentials: true,
    allowedHeaders: [
      'Content-Type',
      'Authorization',
      'X-CSRF-Token',
      'x-csrf-token',
      'X-Request-ID',
      'x-request-id',
      'X-Surface',
      'x-surface',
      'Accept',
      'Origin',
      'Cookie',
      'X-Requested-With',
      'X-Firebase-AppCheck',
      'x-firebase-appcheck',
    ],
    exposedHeaders: ['X-Request-ID', 'x-request-id', 'X-CSRF-Token', 'x-csrf-token'],
  }));

  app.use((req: Request, res: Response, next: NextFunction) => {
    const supplied = req.get('x-request-id');
    req.requestId = supplied && /^[A-Za-z0-9._:-]{8,128}$/.test(supplied)
      ? supplied
      : crypto.randomUUID();
    res.setHeader('X-Request-ID', req.requestId);
    next();
  });

  app.use(express.json({ limit: '2mb' }));
  app.use(express.urlencoded({ extended: true }));
  app.use(requireAppCheck);

  // Mount v1 routers
  app.use('/v1', createAuthRouter());
  app.use('/v1', createDirectoryRouter());
  app.use('/v1', createPortalSetupRouter());
  app.use('/v1', createPublicEligibilityRouter());
  app.use('/v1', createPortalPrescriptionRouter());
  app.use('/v1', createPortalOrderRouter());
  app.use('/v1', createPublicPaymentRouter());
  app.use('/v1', createPortalPaymentRouter());
  app.use('/v1', createPortalFulfilmentRouter());
  app.use('/v1', createPortalPharmacyRouter());
  app.use('/v1', createAdminPatientRouter());
  app.use('/v1', createAdminStaffRouter());
  app.use('/v1', createPortalIntegrationRouter());
  app.use('/v1', createPortalFinanceRouter());
  app.use('/v2', createPublicIntakeV2Router());
  app.use('/v2', createPublicPostcodeSearchRouter());
  app.use('/v2', createPortalIntakeV2Router());

  // Health check endpoint (storage neutral)
  app.get('/health', (_req: Request, res: Response) => {
    res.status(200).json({ status: 'ok', runtime: 'sql-connect', timestamp: new Date().toISOString() });
  });

  function jsonNotFound(req: Request, res: Response) {
    res.status(404).json({
      code: 'NOT_FOUND',
      message: 'Not found.',
      requestId: req.requestId || 'unknown',
    });
  }

  app.use('/v1', jsonNotFound);
  app.use('/v2', jsonNotFound);

  // Global error handler (prevents information leakage)
  app.use((error: unknown, req: Request, res: Response, _next: NextFunction) => {
    const requestId = req.requestId || (req.headers['x-request-id'] as string) || 'unknown';

    if (error instanceof z.ZodError) {
      res.status(400).json({
        code: 'INVALID_INPUT',
        message: 'The request contains invalid or missing fields.',
        details: error.issues.map(issue => ({ path: issue.path.join('.'), message: issue.message })),
        requestId,
      });
      return;
    }

    if (error instanceof HttpError) {
      res.status(error.statusCode).json({
        code: error.code,
        message: error.message,
        details: error.details,
        requestId,
      });
      return;
    }

    // Generic fallback for unhandled exceptions
    console.error('Unhandled server error:', { error, requestId });
    res.status(500).json({
      code: 'INTERNAL_SERVER_ERROR',
      message: 'An unexpected error occurred.',
      requestId,
    });
  });

  return app;
}
