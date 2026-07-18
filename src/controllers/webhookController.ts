/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import { Request, Response } from 'express';
import { WebhookProcessor, webhookQueue } from '../services/webhooks';
import { GatewayName } from '../types/payment';
import { logger } from '../services/logger';

export class WebhookController {
  /**
   * POST /api/v1/webhooks/:gateway
   * Ingest a webhook callback from Razorpay, Stripe, PayU, or UPI
   */
  public static async receive(req: Request, res: Response): Promise<void> {
    const gatewayParam = req.params.gateway as string;
    const signature = req.header('X-Webhook-Signature') || req.header('stripe-signature') || 'wh_sig_test_dummy';
    const traceId = (req.header('X-Trace-ID') || `trc_wh_${Date.now()}_${Math.floor(Math.random() * 100000)}`) as string;

    const gateway = Object.values(GatewayName).find(
      (g) => g.toLowerCase() === gatewayParam.toLowerCase()
    );

    if (!gateway) {
      res.status(400).json({ error: 'INVALID_GATEWAY', message: `Unknown payment gateway parameter: ${gatewayParam}` });
      return;
    }

    try {
      const secret = 'webhook_signing_secret_key_123456'; // Shared mock key for testing
      const payload = req.body;

      const result = await WebhookProcessor.ingest(
        gateway,
        payload,
        signature,
        secret,
        traceId
      );

      res.status(result.status).json({
        message: result.message,
        sub_status: result.sub_status
      });
    } catch (err: any) {
      logger.error(traceId, 'webhook_controller', 'ingest_exception', `Exception during webhook ingestion: ${err.message}`);
      res.status(500).json({ error: 'WEBHOOK_INGESTION_ERROR', message: err.message });
    }
  }

  /**
   * GET /api/dev/dlq
   * Retrieve all webhook queue items (including DLQ and Pending) for dashboard representation
   */
  public static async listQueue(req: Request, res: Response): Promise<void> {
    try {
      res.status(200).json(webhookQueue);
    } catch (err: any) {
      res.status(500).json({ error: 'QUEUE_FETCH_ERROR', message: err.message });
    }
  }

  /**
   * POST /api/dev/dlq/replay
   * Manually replay a failed webhook from DLQ back into the transaction state machine
   */
  public static async replay(req: Request, res: Response): Promise<void> {
    const { itemId } = req.body;
    const traceId = `trc_replay_${Date.now()}_${Math.floor(Math.random() * 10000)}`;

    if (!itemId) {
      res.status(400).json({ error: 'VALIDATION_ERROR', message: "Field 'itemId' is required." });
      return;
    }

    try {
      const success = await WebhookProcessor.replayDLQ(itemId, traceId);
      if (success) {
        res.status(200).json({ success: true, message: `Successfully replayed DLQ item: ${itemId}` });
      } else {
        res.status(422).json({ success: false, error: 'REPLAY_FAILED', message: 'Item was either not in DLQ or processing failed again.' });
      }
    } catch (err: any) {
      logger.error(traceId, 'webhook_controller', 'dlq_replay_failed', `Failed manual DLQ replay: ${err.message}`);
      res.status(500).json({ error: 'DLQ_REPLAY_EXCEPTION', message: err.message });
    }
  }
}
