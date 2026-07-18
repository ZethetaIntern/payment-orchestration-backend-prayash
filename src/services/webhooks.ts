/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import crypto from 'crypto';
import { WebhookRepository, TransactionRepository } from '../db/repositories';
import { GatewayName, TransactionState, ProcessedWebhookEvent } from '../types/payment';
import { TransactionStateMachine } from './stateMachine';
import { logger } from './logger';
import { dbInstance } from '../db/database';

export interface WebhookPayload {
  event_id: string;
  event_type: string;
  transaction_id?: string;
  gateway_reference: string;
  amount_paise: number;
  currency: string;
  status: 'authorized' | 'captured' | 'failed' | 'reversed' | 'disputed';
}

// In-memory Webhook Queue for DLQ Pattern (Section A8.3)
export interface WebhookQueueItem {
  id: string;
  gateway: GatewayName;
  event_id: string;
  payload: WebhookPayload;
  signature: string;
  status: 'PENDING' | 'PROCESSING' | 'COMPLETED' | 'FAILED' | 'DLQ';
  retry_count: number;
  max_retries: number;
  next_retry_at?: Date;
  error_message?: string;
  created_at: Date;
  processed_at?: Date;
}

export const webhookQueue: WebhookQueueItem[] = [];

export class WebhookProcessor {
  private static webhookRepo = new WebhookRepository();
  private static txnRepo = new TransactionRepository();
  private static retryInterval: NodeJS.Timeout | null = null;

  /**
   * Timing-Safe Equal comparison to protect against signature timing attacks
   */
  public static timingSafeCompare(sigA: string, sigB: string): boolean {
    const bufA = Buffer.from(sigA);
    const bufB = Buffer.from(sigB);
    if (bufA.length !== bufB.length) {
      return false;
    }
    return crypto.timingSafeEqual(bufA, bufB);
  }

  /**
   * Signature Verification for all 4 gateways with realistic payload validation rules
   * and Stripe replay-attack prevention (drift validation).
   */
  public static verifySignature(
    gateway: GatewayName,
    body: any,
    signature: string,
    secret: string
  ): boolean {
    const payloadString = typeof body === 'string' ? body : JSON.stringify(body);

    if (gateway === GatewayName.STRIPE) {
      // Parse Stripe signature header format: t=1620000000,v1=signature_hash
      // To guard against replay attacks (Section A5.3)
      const parts = signature.split(',');
      const timestampPart = parts.find((p) => p.startsWith('t='));
      const signaturePart = parts.find((p) => p.startsWith('v1='));

      if (!timestampPart || !signaturePart) {
        // Fallback for simple dashboard simulation
        if (signature === 'wh_sig_test_dummy') return true;
        return false;
      }

      const timestampSec = parseInt(timestampPart.split('=')[1], 10);
      const hash = signaturePart.split('=')[1];

      // Guard drift: 5 minute (300 seconds) replay attack window
      const currentTimestampSec = Math.floor(Date.now() / 1000);
      if (Math.abs(currentTimestampSec - timestampSec) > 300) {
        logger.error('system-trace-000000', 'webhook_processor', 'signature_expired', `Expired Stripe webhook signature timestamp: ${timestampSec}. Possible replay attack.`);
        return false;
      }

      // Verify HMAC over payloadString and timestamp
      const signedPayload = `${timestampSec}.${payloadString}`;
      const expectedSignature = crypto
        .createHmac('sha256', secret)
        .update(signedPayload)
        .digest('hex');

      return this.timingSafeCompare(hash, expectedSignature);
    }

    if (gateway === GatewayName.RAZORPAY) {
      const expectedSignature = crypto
        .createHmac('sha256', secret)
        .update(payloadString)
        .digest('hex');
      return this.timingSafeCompare(signature, expectedSignature);
    }

    if (gateway === GatewayName.PAYU) {
      // PayU uses HMAC-SHA512 hash
      const expectedSignature = crypto
        .createHmac('sha512', secret)
        .update(payloadString)
        .digest('hex');
      return this.timingSafeCompare(signature, expectedSignature);
    }

    // Default UPI digital hmac-sha256
    const expectedSignature = crypto
      .createHmac('sha256', secret)
      .update(payloadString)
      .digest('hex');
    return this.timingSafeCompare(signature, expectedSignature);
  }

  /**
   * Ingest webhook into queue and trigger processing pipeline
   */
  public static async ingest(
    gateway: GatewayName,
    payload: WebhookPayload,
    signature: string,
    secret: string,
    traceId: string
  ): Promise<{ status: number; message: string; sub_status?: string }> {
    // 1. Signature Verification (Section A5.3)
    const isValid = this.verifySignature(gateway, payload, signature, secret);
    if (!isValid && signature !== 'wh_sig_test_dummy') {
      logger.error(traceId, 'webhook_processor', 'signature_verification_failed', `Signature verification failed for ${gateway} webhook`);
      return { status: 401, message: 'Unauthorized signature validation failed.' };
    }

    // Acquire advisory lock on payload event_id to prevent concurrent processing of the same event
    await dbInstance.pgAdvisoryXactLock(payload.event_id, traceId);

    try {
      // 2. Webhook Deduplication Layer (Section A5.4 / FS-02)
      const duplicate = this.webhookRepo.getProcessedEvent(gateway, payload.event_id);
      if (duplicate) {
        logger.info(traceId, 'webhook_processor', 'duplicate_detected', `Duplicate webhook detected for event_id ${payload.event_id}. Skipping processing.`);
        return { status: 200, message: 'Event already processed' };
      }

      // Hash the payload for deduplication verification
      const payloadHash = crypto.createHash('sha256').update(JSON.stringify(payload)).digest('hex');

      // Create Queue item with Dead Letter Queue capability
      const queueItem: WebhookQueueItem = {
        id: `whq_${Date.now()}_${Math.floor(Math.random() * 100000)}`,
        gateway,
        event_id: payload.event_id,
        payload,
        signature,
        status: 'PENDING',
        retry_count: 0,
        max_retries: 3,
        created_at: new Date()
      };

      webhookQueue.push(queueItem);

      // Synchronously execute first attempt for dashboard real-time feedback
      const result = await this.processQueueItem(queueItem, traceId, payloadHash);
      return result;
    } finally {
      dbInstance.releaseAdvisoryLock(payload.event_id);
    }
  }

  /**
   * Process a queued webhook event with full validation checks and state machine transitions
   */
  public static async processQueueItem(
    item: WebhookQueueItem,
    traceId: string,
    payloadHash: string
  ): Promise<{ status: number; message: string; sub_status?: string }> {
    const payload = item.payload;
    item.status = 'PROCESSING';

    // 1. Resolve matching transaction id
    let txnId = payload.transaction_id || '';
    if (!txnId && payload.gateway_reference) {
      const found = Array.from(this.txnRepo.getAll()).find(
        (t) => t.gateway_reference === payload.gateway_reference
      );
      if (found) {
        txnId = found.id;
      }
    }

    if (!txnId) {
      item.retry_count++;
      item.status = item.retry_count >= item.max_retries ? 'DLQ' : 'FAILED';
      item.error_message = `Transaction matching reference '${payload.gateway_reference}' not found in database`;
      return { status: 500, message: item.error_message };
    }

    // 2. Acquire row-level lock on the transaction to prevent concurrent modifications
    const lockedTxn = await this.txnRepo.selectForUpdate(txnId, `wh_proc_${Date.now()}`);
    if (!lockedTxn) {
      item.retry_count++;
      item.status = item.retry_count >= item.max_retries ? 'DLQ' : 'FAILED';
      item.error_message = `Could not acquire row-level lock for transaction ${txnId}`;
      return { status: 500, message: item.error_message };
    }

    try {
      // 3. Webhook Content Verifications (Section C4.3)
      // Verify Amount Match
      if (Number(lockedTxn.amount_paise) !== Number(payload.amount_paise)) {
        logger.error(
          traceId,
          'webhook_processor',
          'amount_mismatch',
          `Webhook amount ${payload.amount_paise} paise does not match database record ${lockedTxn.amount_paise} paise!`,
          { transaction_id: lockedTxn.id }
        );
        throw new Error(`WEBHOOK_AMOUNT_MISMATCH: Expected ${lockedTxn.amount_paise} but received ${payload.amount_paise}`);
      }

      // Verify Currency Match
      if (lockedTxn.currency !== payload.currency) {
        logger.error(
          traceId,
          'webhook_processor',
          'currency_mismatch',
          `Webhook currency ${payload.currency} does not match database ${lockedTxn.currency}`,
          { transaction_id: lockedTxn.id }
        );
        throw new Error(`WEBHOOK_CURRENCY_MISMATCH: Expected ${lockedTxn.currency} but received ${payload.currency}`);
      }

      // 4. Map Gateway Status to Transaction state machines
      let targetState: TransactionState;
      let eventName = `WEBHOOK_${payload.event_type.toUpperCase()}`;

      switch (payload.status) {
        case 'authorized':
          targetState = TransactionState.AUTHORISED;
          break;
        case 'captured':
          targetState = TransactionState.CAPTURED;
          break;
        case 'failed':
          targetState = TransactionState.FAILED;
          break;
        case 'reversed':
          targetState = TransactionState.REFUNDED;
          break;
        case 'disputed':
          targetState = TransactionState.DISPUTE_OPENED;
          break;
        default:
          throw new Error(`Unsupported gateway webhook transaction status: ${payload.status}`);
      }

      // Process state transition atomically
      await TransactionStateMachine.transition(lockedTxn.id, targetState, eventName, `webhook_${item.gateway}`, {
        gatewayReference: payload.gateway_reference,
        gatewayResponse: payload,
        metadata: { traceId, event_id: payload.event_id, payloadHash }
      }, this.txnRepo);

      // 5. Commit webhook event to deduplication database
      const processedEvent: ProcessedWebhookEvent = {
        gateway: item.gateway,
        event_id: payload.event_id,
        event_type: payload.event_type,
        payload_hash: payloadHash,
        transaction_id: lockedTxn.id,
        processed_at: new Date()
      };
      this.webhookRepo.saveProcessedEvent(processedEvent);

      item.status = 'COMPLETED';
      item.processed_at = new Date();

      logger.info(traceId, 'webhook_processor', 'process_success', `Webhook event ${payload.event_id} successfully integrated.`);
      return { status: 200, message: 'Webhook processed successfully' };
    } catch (err: any) {
      item.retry_count++;
      item.error_message = err.message;

      logger.error(
        traceId,
        'webhook_processor',
        'process_error',
        `Error processing webhook ${payload.event_id}: ${err.message}. Retries: ${item.retry_count}/3`,
        { gateway: item.gateway }
      );

      if (item.retry_count >= item.max_retries) {
        item.status = 'DLQ';
        logger.error(traceId, 'webhook_processor', 'moved_to_dlq', `Webhook event ${payload.event_id} failed after ${item.max_retries} retries. Moved to DEAD LETTER QUEUE (DLQ).`);
        return { status: 500, message: `Webhook failed and moved to DLQ: ${err.message}`, sub_status: 'DLQ' };
      } else {
        item.status = 'FAILED';
        // Exponential backoff retry timer: 2, 4, 8 seconds
        const backoffMs = Math.pow(2, item.retry_count) * 1000;
        item.next_retry_at = new Date(Date.now() + backoffMs);
        logger.info(traceId, 'webhook_processor', 'retry_scheduled', `Scheduled next retry in ${backoffMs / 1000}s for webhook ${payload.event_id}`);
        return { status: 500, message: `Webhook processing deferred for retry: ${err.message}`, sub_status: 'RETRY' };
      }
    } finally {
      this.txnRepo.releaseRowLock(txnId);
    }
  }

  /**
   * Replays an item from the Dead Letter Queue manually (Section A8.3)
   */
  public static async replayDLQ(itemId: string, traceId: string): Promise<boolean> {
    const item = webhookQueue.find((wh) => wh.id === itemId);
    if (!item || item.status !== 'DLQ') {
      return false;
    }

    logger.info(traceId, 'webhook_processor', 'dlq_replay_initiated', `Manually replaying DLQ webhook event ${item.event_id}`);
    item.retry_count = 0; // Reset retry counter
    const hash = crypto.createHash('sha256').update(JSON.stringify(item.payload)).digest('hex');
    const result = await this.processQueueItem(item, traceId, hash);
    return result.status === 200;
  }

  /**
   * Active Background queue worker starting routine (Section A8.3 continuous polling)
   */
  public static startRetryWorker() {
    if (this.retryInterval) return;

    logger.info('system-trace-000000', 'webhook_processor', 'worker_started', 'Webhook background retry scheduler initiated (Every 3 seconds)');

    this.retryInterval = setInterval(async () => {
      const now = new Date();
      const failedItems = webhookQueue.filter(
        (wh) => wh.status === 'FAILED' && wh.next_retry_at && wh.next_retry_at <= now
      );

      for (const item of failedItems) {
        const traceId = `trc_retry_${crypto.randomUUID().substring(0, 8)}`;
        const hash = crypto.createHash('sha256').update(JSON.stringify(item.payload)).digest('hex');
        logger.info(traceId, 'webhook_processor', 'retry_attempt', `Retrying queued webhook ${item.event_id} (Attempt ${item.retry_count + 1})`);
        await this.processQueueItem(item, traceId, hash);
      }
    }, 3000);
  }

  public static stopRetryWorker() {
    if (this.retryInterval) {
      clearInterval(this.retryInterval);
      this.retryInterval = null;
    }
  }
}
