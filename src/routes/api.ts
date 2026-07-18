/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import { Router } from 'express';
import { PaymentController } from '../controllers/paymentController';
import { GatewayController } from '../controllers/gatewayController';
import { WebhookController } from '../controllers/webhookController';
import { ReconciliationController } from '../controllers/reconciliationController';
import { AnalyticsController } from '../controllers/analyticsController';

const apiRouter = Router();

// ==========================================
// 1. Payment Processing Endpoints (v1)
// ==========================================
apiRouter.post('/v1/payments/charge', PaymentController.charge);
apiRouter.post('/v1/payments/:id/capture', PaymentController.capture);
apiRouter.post('/v1/payments/:id/void', PaymentController.void);
apiRouter.post('/v1/payments/:id/refund', PaymentController.refund);
apiRouter.get('/v1/payments/:id/timeline', PaymentController.timeline);

// ==========================================
// 2. Gateway and Routing Configuration (v1)
// ==========================================
apiRouter.get('/v1/gateways', GatewayController.list);
apiRouter.get('/v1/routing/config', GatewayController.getWeights);
apiRouter.post('/v1/routing/config', GatewayController.updateWeights);

// ==========================================
// 3. Webhook Ingest Callback (v1)
// ==========================================
apiRouter.post('/v1/webhooks/:gateway', WebhookController.receive);

// ==========================================
// 4. Batch Reconciliation Endpoints (v1)
// ==========================================
apiRouter.post('/v1/reconciliation/trigger', ReconciliationController.trigger);
apiRouter.get('/v1/reconciliation/logs', ReconciliationController.listLogs);

// ==========================================
// 5. Success Analytics Metrics (v1)
// ==========================================
apiRouter.get('/v1/analytics/success-rate', AnalyticsController.successRates);

// ==========================================
// 6. Developer & Scenario Sandbox Tools (dev)
// ==========================================
apiRouter.get('/dev/transactions', AnalyticsController.dumpTransactions);
apiRouter.get('/dev/logs', AnalyticsController.dumpLogs);
apiRouter.get('/dev/circuit-breakers', AnalyticsController.circuitBreakers);
apiRouter.post('/dev/scenarios/:id/trigger', AnalyticsController.triggerScenario);
apiRouter.get('/dev/dlq', WebhookController.listQueue);
apiRouter.post('/dev/dlq/replay', WebhookController.replay);

export { apiRouter };
