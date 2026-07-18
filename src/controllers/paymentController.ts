/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import { Request, Response } from 'express';
import { PaymentOrchestrator } from '../services/orchestrator';
import { TransactionRepository, RefundRepository } from '../db/repositories';
import { PaymentMethod } from '../types/payment';
import { IdempotencyConflictError, IdempotencyPayloadMismatchError } from '../services/idempotency';
import { logger } from '../services/logger';

export class PaymentController {
  private static txnRepo = new TransactionRepository();
  private static refundRepo = new RefundRepository();

  /**
   * Helper to parse mock headers from Request
   */
  private static parseMockHeaders(req: Request) {
    const responseType = req.header('X-Mock-Response') as any;
    const delayMs = req.header('X-Mock-Delay-Ms') ? parseInt(req.header('X-Mock-Delay-Ms')!, 10) : undefined;
    const gatewayDown = req.header('X-Mock-Gateway-Down') === 'true';

    return { responseType, delayMs, gatewayDown };
  }

  /**
   * POST /api/v1/payments/charge
   * Process a payment authorization or direct sale
   */
  public static async charge(req: Request, res: Response): Promise<void> {
    const traceId = (req.header('X-Trace-ID') || `trc_${Date.now()}_${Math.floor(Math.random() * 100000)}`) as string;
    const merchantId = req.header('X-Merchant-ID') as string;
    const idempotencyKey = req.header('X-Idempotency-Key') as string;

    const { merchant_order_id, amount_paise, currency, payment_method } = req.body;

    // 1. Fail-Fast Input Validation
    if (!merchantId) {
      res.status(400).json({ error: 'MISSING_HEADER', message: "Header 'X-Merchant-ID' is required." });
      return;
    }
    if (!idempotencyKey) {
      res.status(400).json({ error: 'MISSING_HEADER', message: "Header 'X-Idempotency-Key' is required." });
      return;
    }
    if (!merchant_order_id) {
      res.status(400).json({ error: 'VALIDATION_ERROR', message: "Field 'merchant_order_id' is required." });
      return;
    }
    if (!amount_paise || typeof amount_paise !== 'number' || amount_paise <= 0) {
      res.status(400).json({ error: 'VALIDATION_ERROR', message: "Field 'amount_paise' must be a positive integer." });
      return;
    }
    if (!currency || typeof currency !== 'string' || !['INR', 'USD'].includes(currency.toUpperCase())) {
      res.status(400).json({ error: 'VALIDATION_ERROR', message: "Field 'currency' must be 'INR' or 'USD'." });
      return;
    }
    if (!payment_method || !Object.values(PaymentMethod).includes(payment_method as any)) {
      res.status(400).json({ error: 'VALIDATION_ERROR', message: `Field 'payment_method' must be one of: ${Object.values(PaymentMethod).join(', ')}` });
      return;
    }

    try {
      const mockHeaders = PaymentController.parseMockHeaders(req);

      const result = await PaymentOrchestrator.processCharge({
        merchantId,
        idempotencyKey,
        merchantOrderId: merchant_order_id,
        amountPaise: amount_paise,
        currency: currency.toUpperCase(),
        paymentMethod: payment_method as PaymentMethod,
        traceId,
        mockHeaders,
        clientIp: req.ip || req.socket.remoteAddress
      });

      res.status(201).json({
        id: result.transactionId,
        merchant_id: merchantId,
        merchant_order_id: result.merchantOrderId,
        amount_paise: result.amountPaise,
        currency: result.currency,
        state: result.state,
        selected_gateway: result.gatewayUsed,
        gateway_reference: result.gatewayReference,
        is_idempotent: result.isIdempotentResponse,
        attempts: result.attemptsCount
      });
    } catch (err: any) {
      if (err instanceof IdempotencyPayloadMismatchError) {
        res.status(422).json({
          error: 'IDEMPOTENCY_PAYLOAD_MISMATCH',
          message: err.message
        });
        return;
      }

      if (err instanceof IdempotencyConflictError) {
        res.status(409).json({
          error: 'IDEMPOTENCY_LOCK_CONFLICT',
          message: err.message,
          retry_after_seconds: 2
        });
        return;
      }

      logger.error(traceId, 'payment_controller', 'charge_failed', `Failed processing charge: ${err.message}`);
      res.status(500).json({
        error: 'INTERNAL_SERVER_ERROR',
        message: 'An unexpected error occurred during payment orchestration.',
        details: err.message
      });
    }
  }

  /**
   * POST /api/v1/payments/:id/capture
   * Capture a previously authorized payment
   */
  public static async capture(req: Request, res: Response): Promise<void> {
    const traceId = (req.header('X-Trace-ID') || `trc_${Date.now()}_${Math.floor(Math.random() * 100000)}`) as string;
    const { id } = req.params;
    const { amount_paise } = req.body;

    if (!amount_paise || typeof amount_paise !== 'number' || amount_paise <= 0) {
      res.status(400).json({ error: 'VALIDATION_ERROR', message: "Field 'amount_paise' must be a positive integer." });
      return;
    }

    try {
      const mockHeaders = PaymentController.parseMockHeaders(req);
      const transaction = await PaymentOrchestrator.processCapture(id, amount_paise, traceId, mockHeaders);

      res.status(200).json({
        id: transaction.id,
        state: transaction.state,
        amount_paise: Number(transaction.amount_paise),
        selected_gateway: transaction.selected_gateway,
        gateway_reference: transaction.gateway_reference,
        updated_at: transaction.updated_at
      });
    } catch (err: any) {
      logger.error(traceId, 'payment_controller', 'capture_failed', `Capture failed for txn ${id}: ${err.message}`);
      res.status(500).json({ error: 'CAPTURE_FAILED', message: err.message });
    }
  }

  /**
   * POST /api/v1/payments/:id/void
   * Void a previously authorized payment
   */
  public static async void(req: Request, res: Response): Promise<void> {
    const traceId = (req.header('X-Trace-ID') || `trc_${Date.now()}_${Math.floor(Math.random() * 100000)}`) as string;
    const { id } = req.params;

    try {
      const mockHeaders = PaymentController.parseMockHeaders(req);
      const transaction = await PaymentOrchestrator.processVoid(id, traceId, mockHeaders);

      res.status(200).json({
        id: transaction.id,
        state: transaction.state,
        selected_gateway: transaction.selected_gateway,
        gateway_reference: transaction.gateway_reference,
        updated_at: transaction.updated_at
      });
    } catch (err: any) {
      logger.error(traceId, 'payment_controller', 'void_failed', `Void failed for txn ${id}: ${err.message}`);
      res.status(500).json({ error: 'VOID_FAILED', message: err.message });
    }
  }

  /**
   * POST /api/v1/payments/:id/refund
   * Refund captured transaction funds
   */
  public static async refund(req: Request, res: Response): Promise<void> {
    const traceId = (req.header('X-Trace-ID') || `trc_${Date.now()}_${Math.floor(Math.random() * 100000)}`) as string;
    const { id } = req.params;
    const { amount_paise } = req.body;

    if (!amount_paise || typeof amount_paise !== 'number' || amount_paise <= 0) {
      res.status(400).json({ error: 'VALIDATION_ERROR', message: "Field 'amount_paise' must be a positive integer." });
      return;
    }

    try {
      const mockHeaders = PaymentController.parseMockHeaders(req);
      const refund = await PaymentOrchestrator.processRefund(id, amount_paise, traceId, mockHeaders);

      res.status(200).json({
        id: refund.id,
        transaction_id: refund.transaction_id,
        amount_paise: Number(refund.amount_paise),
        status: refund.state,
        gateway_reference: refund.gateway_refund_id,
        created_at: refund.created_at
      });
    } catch (err: any) {
      logger.error(traceId, 'payment_controller', 'refund_failed', `Refund failed for txn ${id}: ${err.message}`);
      res.status(500).json({ error: 'REFUND_FAILED', message: err.message });
    }
  }

  /**
   * GET /api/v1/payments/:id/timeline
   * Returns audit logs for a transaction
   */
  public static async timeline(req: Request, res: Response): Promise<void> {
    const { id } = req.params;
    try {
      const txn = PaymentController.txnRepo.getById(id);
      if (!txn) {
        res.status(404).json({ error: 'TRANSACTION_NOT_FOUND', message: `Transaction with ID '${id}' not found.` });
        return;
      }
      const timelineLogs = PaymentController.txnRepo.getTimeline(id);
      res.status(200).json(timelineLogs);
    } catch (err: any) {
      res.status(500).json({ error: 'TIMELINE_ERROR', message: err.message });
    }
  }
}
