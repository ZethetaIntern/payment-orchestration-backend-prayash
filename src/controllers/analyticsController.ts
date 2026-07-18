/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import { Request, Response } from 'express';
import { TransactionRepository, CircuitBreakerRepository } from '../db/repositories';
import { dbInstance } from '../db/database';
import { logBuffer } from '../services/logger';
import { PaymentOrchestrator } from '../services/orchestrator';
import { WebhookProcessor } from '../services/webhooks';
import { ReconciliationEngine } from '../services/reconciliation';
import { TransactionStateMachine } from '../services/stateMachine';
import { GatewayName, PaymentMethod, TransactionState } from '../types/payment';

export class AnalyticsController {
  private static txnRepo = new TransactionRepository();
  private static cbRepo = new CircuitBreakerRepository();

  /**
   * GET /api/v1/analytics/success-rate
   * List live success rate metrics of gateways
   */
  public static async successRates(req: Request, res: Response): Promise<void> {
    try {
      res.status(200).json(dbInstance.gatewayHealthMetrics);
    } catch (err: any) {
      res.status(500).json({ error: 'ANALYTICS_ERROR', message: err.message });
    }
  }

  /**
   * GET /api/dev/transactions
   * Dump all transaction records sorted by created_at desc (Section A14.1 Audit Trail)
   */
  public static async dumpTransactions(req: Request, res: Response): Promise<void> {
    try {
      const txns = AnalyticsController.txnRepo.getAll();
      txns.sort((a, b) => b.created_at.getTime() - a.created_at.getTime());
      res.status(200).json(txns);
    } catch (err: any) {
      res.status(500).json({ error: 'DEV_DUMP_ERROR', message: err.message });
    }
  }

  /**
   * GET /api/dev/logs
   * Fetch in-memory console/audit log history for dashboard streaming (Section A7.3)
   */
  public static async dumpLogs(req: Request, res: Response): Promise<void> {
    try {
      const sorted = [...logBuffer].sort((a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime());
      res.status(200).json(sorted);
    } catch (err: any) {
      res.status(500).json({ error: 'DEV_LOGS_ERROR', message: err.message });
    }
  }

  /**
   * GET /api/dev/circuit-breakers
   * Fetch states of all active circuit breakers (Section A9.1)
   */
  public static async circuitBreakers(req: Request, res: Response): Promise<void> {
    try {
      const cbs = AnalyticsController.cbRepo.getAll();
      res.status(200).json(cbs);
    } catch (err: any) {
      res.status(500).json({ error: 'DEV_CB_ERROR', message: err.message });
    }
  }

  /**
   * POST /api/dev/scenarios/:id/trigger
   * Execute predefined transaction scenarios in our payment playground to show dynamic failover
   */
  public static async triggerScenario(req: Request, res: Response): Promise<void> {
    const { id } = req.params;
    const traceId = `trc_scen_${id}_${Date.now().toString(36)}`;
    const idempKey = `scen_idemp_${Date.now().toString(36)}`;

    try {
      let result: any = null;

      switch (id) {
        // Standard high-level scenario
        case 'routing_standard': {
          result = await PaymentOrchestrator.processCharge({
            merchantId: 'mer_scen_1',
            idempotencyKey: idempKey,
            merchantOrderId: `scen_order_std_${Math.floor(Math.random() * 10000)}`,
            amountPaise: 150000,
            currency: 'INR',
            paymentMethod: PaymentMethod.CARD,
            traceId
          });
          break;
        }

        // FS-01 Parity: Gateway Timeout During Authorisation
        case 'FS-01':
        case 'failover_timeout': {
          // Force Razorpay (highest CARD scorer if weights favor success rate) to time out
          result = await PaymentOrchestrator.processCharge({
            merchantId: 'mer_scen_fs01',
            idempotencyKey: idempKey,
            merchantOrderId: `ord_fs01_${Date.now()}`,
            amountPaise: 250000, // 2500 INR
            currency: 'INR',
            paymentMethod: PaymentMethod.CARD,
            traceId,
            mockHeaders: {
              responseType: 'timeout', // Forces primary to time out, triggering automatic failover
              delayMs: 300
            }
          });
          break;
        }

        // FS-02 Parity: Duplicate Webhook Delivery
        case 'FS-02': {
          const orderId = `ord_fs02_${Date.now()}`;
          const eventId = `evt_fs02_${Math.random().toString(36).substring(2, 10)}`;
          const webhookSigningSecret = 'webhook_signing_secret_key_123456';

          const webhookPayload = {
            event_id: eventId,
            event_type: 'payment.captured',
            transaction_id: orderId,
            gateway_reference: `pay_fs02_${Math.random().toString(36).substring(2, 10)}`,
            amount_paise: 150000,
            currency: 'INR',
            status: 'captured' as const
          };

          // Setup transaction record in database in state AUTH_INITIATED to represent a pending capture hook
          const txnId = `txn_scen_fs02_${Date.now()}`;
          AnalyticsController.txnRepo.save({
            id: txnId,
            merchant_id: 'mer_1234',
            merchant_order_id: orderId,
            amount_paise: 150000,
            currency: 'INR',
            payment_method: PaymentMethod.CARD,
            state: TransactionState.AUTH_INITIATED,
            selected_gateway: GatewayName.RAZORPAY,
            gateway_reference: webhookPayload.gateway_reference,
            trace_id: traceId,
            created_at: new Date(),
            updated_at: new Date()
          });

          // Ingest webhook 3 times simultaneously to show deduplication
          const r1 = await WebhookProcessor.ingest(GatewayName.RAZORPAY, webhookPayload, 'wh_sig_test_dummy', webhookSigningSecret, traceId);
          const r2 = await WebhookProcessor.ingest(GatewayName.RAZORPAY, webhookPayload, 'wh_sig_test_dummy', webhookSigningSecret, traceId);
          const r3 = await WebhookProcessor.ingest(GatewayName.RAZORPAY, webhookPayload, 'wh_sig_test_dummy', webhookSigningSecret, traceId);

          result = { scenario: 'FS-02', responses: [r1, r2, r3] };
          break;
        }

        // FS-03 Parity: Double Submit / Concurrency Race
        case 'FS-03': {
          const body = {
            amountPaise: 50000,
            currency: 'INR',
            paymentMethod: PaymentMethod.CARD,
            merchantId: 'mer_1234',
            merchantOrderId: `ord_fs03_${Date.now()}`
          };

          // Trigger two concurrent processCharge executions with identical idempotency keys
          const p1 = PaymentOrchestrator.processCharge({
            ...body,
            idempotencyKey: idempKey,
            traceId: `${traceId}_req1`
          });

          const p2 = PaymentOrchestrator.processCharge({
            ...body,
            idempotencyKey: idempKey,
            traceId: `${traceId}_req2`
          });

          const [r1, r2] = await Promise.allSettled([p1, p2]);

          result = {
            scenario: 'FS-03',
            results: [
              r1.status === 'fulfilled' ? { status: 201, data: r1.value } : { status: 409, error: r1.reason.message },
              r2.status === 'fulfilled' ? { status: 201, data: r2.value } : { status: 409, error: r2.reason.message }
            ]
          };
          break;
        }

        // FS-04 Parity: Gateway Returns 5xx on Capture
        case 'FS-04': {
          const orderId = `ord_fs04_${Date.now()}`;
          const txnId = `txn_fs04_${Date.now()}`;

          // Create authorized card transaction
          AnalyticsController.txnRepo.save({
            id: txnId,
            merchant_id: 'mer_1234',
            merchant_order_id: orderId,
            amount_paise: 200000,
            currency: 'INR',
            payment_method: PaymentMethod.CARD,
            state: TransactionState.AUTHORISED,
            selected_gateway: GatewayName.PAYU,
            gateway_reference: `pay_fs04_${Math.random().toString(36).substring(2, 10)}`,
            trace_id: traceId,
            created_at: new Date(),
            updated_at: new Date()
          });

          try {
            // Force capture failure
            const captureTxn = await PaymentOrchestrator.processCapture(txnId, 200000, traceId, {
              responseType: 'server-error'
            });
            result = { scenario: 'FS-04', status: 200, data: captureTxn };
          } catch (err: any) {
            result = { scenario: 'FS-04', status: 500, error: err.message };
          }
          break;
        }

        // FS-05 Parity: Partial Capture with Remaining Hold
        case 'FS-05': {
          const orderId = `ord_fs05_${Date.now()}`;
          const txnId = `txn_fs05_${Date.now()}`;

          // Create authorized card transaction
          AnalyticsController.txnRepo.save({
            id: txnId,
            merchant_id: 'mer_1234',
            merchant_order_id: orderId,
            amount_paise: 120000, // 1200 INR authorized
            currency: 'INR',
            payment_method: PaymentMethod.CARD,
            state: TransactionState.AUTHORISED,
            selected_gateway: GatewayName.STRIPE,
            gateway_reference: `pay_fs05_${Math.random().toString(36).substring(2, 10)}`,
            trace_id: traceId,
            created_at: new Date(),
            updated_at: new Date()
          });

          // Partially capture ₹800 (80000 paise) of ₹1200 hold
          const captureTxn = await PaymentOrchestrator.processCapture(txnId, 80000, traceId);
          result = { scenario: 'FS-05', status: 200, data: captureTxn };
          break;
        }

        // FS-11 Parity: Settlement Mismatch Anomaly Detection
        case 'FS-11':
        case 'anomaly_test': {
          const txnId = `txn_fs11_${Date.now()}`;
          AnalyticsController.txnRepo.save({
            id: txnId,
            merchant_id: 'mer_1234',
            merchant_order_id: `ord_fs11_anomaly_${Date.now()}`, // 'anomaly' inside order ID triggers critical alert
            amount_paise: 100000,
            currency: 'INR',
            payment_method: PaymentMethod.CARD,
            state: TransactionState.CAPTURED,
            selected_gateway: GatewayName.STRIPE,
            gateway_reference: `pay_fs11_${Math.random().toString(36).substring(2, 10)}`,
            trace_id: traceId,
            created_at: new Date(Date.now() - 5 * 60 * 1000), // make it look older
            updated_at: new Date()
          });

          // Run reconciliation
          const runId = `rec_run_fs11_${Date.now()}`;
          const reconRes = await ReconciliationEngine.run(runId, traceId);
          result = { scenario: 'FS-11', status: 200, data: reconRes };
          break;
        }

        // FS-15 Parity: State Machine Corruption Attempt
        case 'FS-15': {
          const txnId = `txn_fs15_${Date.now()}`;
          AnalyticsController.txnRepo.save({
            id: txnId,
            merchant_id: 'mer_1234',
            merchant_order_id: `ord_fs15_${Date.now()}`,
            amount_paise: 10000,
            currency: 'INR',
            payment_method: PaymentMethod.CARD,
            state: TransactionState.CREATED,
            trace_id: traceId,
            created_at: new Date(),
            updated_at: new Date()
          });

          try {
            // Direct transition from CREATED to REFUNDED is illegal
            await TransactionStateMachine.transition(txnId, TransactionState.REFUNDED, 'ILLEGAL_FORCE', 'malicious_agent');
            result = { scenario: 'FS-15', success: true };
          } catch (err: any) {
            result = {
              scenario: 'FS-15',
              success: false,
              error: err.message,
              fromState: err.fromState,
              toState: err.toState
            };
          }
          break;
        }

        case 'circuit_trip': {
          const runs: any[] = [];
          for (let i = 0; i < 3; i++) {
            const singleRun = await PaymentOrchestrator.processCharge({
              merchantId: 'mer_scen_trip',
              idempotencyKey: `${idempKey}_run_${i}`,
              merchantOrderId: `scen_order_trip_${i}_${Math.floor(Math.random() * 10000)}`,
              amountPaise: 50000,
              currency: 'INR',
              paymentMethod: PaymentMethod.CARD,
              traceId: `${traceId}_run_${i}`,
              mockHeaders: {
                responseType: 'server-error',
                delayMs: 100
              }
            });
            runs.push(singleRun);
          }
          result = { message: 'Consecutive failures executed. Stripe Card circuit breaker is now OPEN!', runs };
          break;
        }

        case 'rate_limit': {
          result = await PaymentOrchestrator.processCharge({
            merchantId: 'mer_scen_rl',
            idempotencyKey: idempKey,
            merchantOrderId: `scen_order_rl_${Math.floor(Math.random() * 10000)}`,
            amountPaise: 30000,
            currency: 'INR',
            paymentMethod: PaymentMethod.CARD,
            traceId,
            mockHeaders: {
              responseType: 'rate-limit'
            }
          });
          break;
        }

        case 'payment_decline': {
          result = await PaymentOrchestrator.processCharge({
            merchantId: 'mer_scen_dec',
            idempotencyKey: idempKey,
            merchantOrderId: `scen_order_dec_${Math.floor(Math.random() * 10000)}`,
            amountPaise: 12000,
            currency: 'INR',
            paymentMethod: PaymentMethod.CARD,
            traceId,
            mockHeaders: {
              responseType: 'decline'
            }
          });
          break;
        }

        default:
          res.status(400).json({ error: 'INVALID_SCENARIO', message: `Unknown sandbox scenario: ${id}` });
          return;
      }

      res.status(200).json(result);
    } catch (err: any) {
      res.status(500).json({ error: 'SCENARIO_EXCEPTION', message: err.message });
    }
  }
}
