/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import crypto from 'crypto';
import { TransactionRepository, IdempotencyRepository, RefundRepository, GatewayConfigRepository } from '../db/repositories';
import { TransactionState, PaymentMethod, GatewayName, Transaction, Refund } from '../types/payment';
import { IdempotencyService, IdempotencyPayloadMismatchError } from './idempotency';
import { GatewayRouter, CircuitBreakerManager } from './router';
import { TransactionStateMachine } from './stateMachine';
import { GatewayFactory, MockHeaders } from '../gateways/adapters';
import { logger } from './logger';

export interface ChargeRequest {
  merchantId: string;
  idempotencyKey: string;
  merchantOrderId: string;
  amountPaise: number;
  currency: string;
  paymentMethod: PaymentMethod;
  traceId: string;
  mockHeaders?: MockHeaders;
  clientIp?: string;
}

export interface ChargeResponse {
  transactionId: string;
  merchantOrderId: string;
  amountPaise: number;
  currency: string;
  state: TransactionState;
  gatewayUsed: GatewayName;
  gatewayReference?: string;
  isIdempotentResponse: boolean;
  errorCode?: string;
  errorMessage?: string;
  attemptsCount: number;
}

export class PaymentOrchestrator {
  private static txnRepo = new TransactionRepository();
  private static idempRepo = new IdempotencyRepository();
  private static refundRepo = new RefundRepository();
  private static gatewayRepo = new GatewayConfigRepository();

  /**
   * Generates a request hash for idempotency payload verification
   */
  public static calculateRequestHash(req: Partial<ChargeRequest>): string {
    const data = {
      merchant_order_id: req.merchantOrderId,
      amount_paise: req.amountPaise,
      currency: req.currency,
      payment_method: req.paymentMethod
    };
    return crypto.createHash('sha256').update(JSON.stringify(data)).digest('hex');
  }

  /**
   * Orchestrates the complete charge workflow with multi-gateway failovers (Section A8.2 / Section A8.4)
   */
  public static async processCharge(req: ChargeRequest): Promise<ChargeResponse> {
    const traceId = req.traceId;
    const requestHash = this.calculateRequestHash(req);

    logger.info(traceId, 'orchestrator', 'charge_started', `Processing charge request for Order: ${req.merchantOrderId}`, {
      merchant_id: req.merchantId,
      amount: req.amountPaise,
      currency: req.currency,
      payment_method: req.paymentMethod
    });

    // 1. Acquire Idempotency Lock & Validate (Section A4.1)
    const cachedIdemp = await IdempotencyService.acquire(
      req.merchantId,
      req.idempotencyKey,
      requestHash,
      traceId,
      this.idempRepo
    );

    if (cachedIdemp && cachedIdemp.status === 'COMPLETED') {
      const parsedBody = JSON.parse(cachedIdemp.response_body!);
      logger.info(traceId, 'orchestrator', 'idempotency_hit', `Idempotent request cache-hit resolved for order ${req.merchantOrderId}`);
      return {
        transactionId: parsedBody.transaction_id || parsedBody.id,
        merchantOrderId: req.merchantOrderId,
        amountPaise: req.amountPaise,
        currency: req.currency,
        state: parsedBody.state,
        gatewayUsed: parsedBody.gateway_used || parsedBody.selected_gateway,
        gatewayReference: parsedBody.gateway_reference,
        isIdempotentResponse: true,
        attemptsCount: 1
      };
    }

    // 2. Begin Concurrency Safe Database Transaction Simulation
    const txnId = `txn_${Date.now()}_${crypto.randomBytes(4).toString('hex')}`;
    let attemptsCount = 0;
    let selectedGateway: GatewayName | null = null;
    let finalState = TransactionState.CREATED;
    let finalGatewayRef = '';
    let orchestratorError: { code?: string; message?: string } | null = null;

    // Create Transaction Record in database (State: CREATED)
    const transaction: Transaction = {
      id: txnId,
      merchant_id: req.merchantId,
      merchant_order_id: req.merchantOrderId,
      amount_paise: req.amountPaise,
      currency: req.currency,
      payment_method: req.paymentMethod,
      state: TransactionState.CREATED,
      trace_id: traceId,
      created_at: new Date(),
      updated_at: new Date()
    };
    this.txnRepo.save(transaction);
    this.txnRepo.addStateLog({
      id: `log_${Date.now()}_${Math.floor(Math.random() * 100000)}`,
      transaction_id: txnId,
      from_state: null,
      to_state: TransactionState.CREATED,
      event: 'TRANSACTION_INITIALIZED',
      created_at: new Date(),
      created_by: 'payment_orchestrator'
    });

    // 3. Multi-Gateway Failover Engine Loop (Section A8.2 failover within < 2s)
    let processedSuccessfully = false;
    let blacklist: GatewayName[] = [];

    while (attemptsCount < 3 && !processedSuccessfully) {
      attemptsCount++;

      // Row-Level Advisory Locking for current transaction (emulated Section A8.1)
      const lockedTxn = await this.txnRepo.selectForUpdate(txnId, `orch_failover_loop_${attemptsCount}`);
      if (!lockedTxn) {
        throw new Error('Database advisory lock failure: could not secure lock on active transaction');
      }

      try {
        // Calculate optimal route dynamically
        const routeResult = GatewayRouter.route(req.amountPaise, req.paymentMethod, traceId);
        
        // Find highest scoring gateway that isn't blacklisted for this transaction retry
        let targetGateway = routeResult.selectedGateway;
        const alternativeScorers = routeResult.scoredGateways.filter((g) => !blacklist.includes(g.name));
        
        if (alternativeScorers.length > 0) {
          targetGateway = alternativeScorers[0].name;
        } else {
          // Exhausted all active gateways
          throw new Error('GATEWAY_EXHAUSTION: All active payment gateways have failed or timed out for this transaction');
        }

        selectedGateway = targetGateway;
        logger.info(traceId, 'orchestrator', 'attempt_initiated', `Payment attempt ${attemptsCount}/3 initiating on gateway: ${targetGateway}`);

        // Save selected route trace
        this.txnRepo.saveGatewayRoute({
          id: `gr_${Date.now()}_${Math.floor(Math.random() * 100000)}`,
          transaction_id: txnId,
          gateway: targetGateway,
          score: alternativeScorers.find((s) => s.name === targetGateway)?.score || 0.0,
          routing_weights: JSON.stringify(routeResult.scoredGateways),
          created_at: new Date()
        });

        // Transition: ROUTE_SELECTED
        await TransactionStateMachine.transition(txnId, TransactionState.ROUTE_SELECTED, 'ROUTE_SELECTED', 'payment_orchestrator', {
          metadata: { selected_gateway: targetGateway, attempt: attemptsCount }
        }, this.txnRepo);

        // Update selected gateway on transaction record
        const curTxn = this.txnRepo.getById(txnId)!;
        curTxn.selected_gateway = targetGateway;
        this.txnRepo.save(curTxn);

        // Transition: AUTH_INITIATED
        await TransactionStateMachine.transition(txnId, TransactionState.AUTH_INITIATED, 'AUTH_INITIATED', 'payment_orchestrator', {}, this.txnRepo);

        // Resolve Adapter and fire request
        const gatewayAdapter = GatewayFactory.getAdapter(targetGateway);
        const start = Date.now();
        const gatewayRes = await gatewayAdapter.authorize(req.amountPaise, req.paymentMethod, traceId, req.mockHeaders);
        const duration = Date.now() - start;

        // Log transaction latencies and statistics (FS-13)
        logger.info(traceId, 'orchestrator', 'gateway_response', `Gateway ${targetGateway} responded in ${duration}ms with status code ${gatewayRes.statusCode}`);

        if (gatewayRes.success) {
          // Success: Record health metric success
          CircuitBreakerManager.recordSuccess(targetGateway, req.paymentMethod, traceId);

          finalGatewayRef = gatewayRes.gatewayReference || '';

          // Transition to CAPTURED if UPI, or if Direct-Capture header is simulated
          const autoCapture = req.paymentMethod === PaymentMethod.UPI || req.mockHeaders?.responseType === 'success';
          const successState = autoCapture ? TransactionState.CAPTURED : TransactionState.AUTHORISED;
          
          await TransactionStateMachine.transition(txnId, successState, 'PAYMENT_AUTHORIZATION_SUCCESS', 'payment_orchestrator', {
            gatewayReference: finalGatewayRef,
            gatewayResponse: gatewayRes.rawResponse,
            metadata: { duration_ms: duration }
          }, this.txnRepo);

          finalState = successState;
          processedSuccessfully = true;
          logger.info(traceId, 'orchestrator', 'charge_success', `Payment processed successfully on gateway ${targetGateway} in ${attemptsCount} attempts`);
        } else {
          // Gateway declined or errored: record circuit failure
          CircuitBreakerManager.recordFailure(targetGateway, req.paymentMethod, traceId);
          blacklist.push(targetGateway); // Blacklist gateway for remaining loops of this charge

          logger.warn(traceId, 'orchestrator', 'gateway_attempt_failed', `Attempt ${attemptsCount} on ${targetGateway} failed: ${gatewayRes.errorMessage}`);

          // Transition to AUTH_FAILED
          await TransactionStateMachine.transition(txnId, TransactionState.AUTH_FAILED, 'PAYMENT_AUTHORIZATION_FAILED', 'payment_orchestrator', {
            gatewayResponse: gatewayRes.rawResponse,
            metadata: { error_code: gatewayRes.errorCode, error_message: gatewayRes.errorMessage }
          }, this.txnRepo);

          orchestratorError = { code: gatewayRes.errorCode, message: gatewayRes.errorMessage };
        }
      } catch (err: any) {
        // Log unexpected error
        logger.error(traceId, 'orchestrator', 'attempt_exception', `Exception in failover loop attempt ${attemptsCount} for gateway ${selectedGateway}: ${err.message}`);
        
        if (selectedGateway) {
          CircuitBreakerManager.recordFailure(selectedGateway, req.paymentMethod, traceId);
          blacklist.push(selectedGateway);
        }

        orchestratorError = { code: 'ORCHESTRATOR_EXCEPTION', message: err.message };
      } finally {
        // Release transactional row-level lock safely (FS-04 / A8.1)
        this.txnRepo.releaseRowLock(txnId);
      }
    }

    // 4. Handle Final State & Cache Response
    if (processedSuccessfully) {
      const responsePayload = {
        id: txnId,
        merchant_id: req.merchantId,
        merchant_order_id: req.merchantOrderId,
        amount_paise: req.amountPaise,
        currency: req.currency,
        payment_method: req.paymentMethod,
        state: finalState,
        selected_gateway: selectedGateway,
        gateway_reference: finalGatewayRef,
        created_at: transaction.created_at,
        updated_at: new Date()
      };

      await IdempotencyService.complete(req.merchantId, req.idempotencyKey, 201, responsePayload, traceId, this.idempRepo);

      return {
        transactionId: txnId,
        merchantOrderId: req.merchantOrderId,
        amountPaise: req.amountPaise,
        currency: req.currency,
        state: finalState,
        gatewayUsed: selectedGateway!,
        gatewayReference: finalGatewayRef,
        isIdempotentResponse: false,
        attemptsCount
      };
    } else {
      // Transition transaction to terminal FAILED state
      await TransactionStateMachine.transition(txnId, TransactionState.FAILED, 'FAILOVER_RETRIES_EXHAUSTED', 'payment_orchestrator', {
        metadata: { error: orchestratorError?.message || 'Unknown failover exhaustion' }
      }, this.txnRepo);

      await IdempotencyService.fail(req.merchantId, req.idempotencyKey, traceId, this.idempRepo);

      return {
        transactionId: txnId,
        merchantOrderId: req.merchantOrderId,
        amountPaise: req.amountPaise,
        currency: req.currency,
        state: TransactionState.FAILED,
        gatewayUsed: selectedGateway || GatewayName.RAZORPAY,
        isIdempotentResponse: false,
        errorCode: orchestratorError?.code || 'FAILOVER_EXHAUSTED',
        errorMessage: orchestratorError?.message || 'Payment failed after trying all gateway retry routes.',
        attemptsCount
      };
    }
  }

  /**
   * Orchestrates the CAPTURE of authorized transaction funds (Section A2.3)
   */
  public static async processCapture(
    txnId: string,
    amountPaise: number,
    traceId: string,
    mockHeaders?: MockHeaders
  ): Promise<Transaction> {
    logger.info(traceId, 'orchestrator', 'capture_started', `Orchestrating Capture for Transaction ${txnId}`);

    const lockedTxn = await this.txnRepo.selectForUpdate(txnId, `orch_capture_${Date.now()}`);
    if (!lockedTxn) {
      throw new Error(`Database row lock failure: could not secure lock on transaction ${txnId} for capture`);
    }

    try {
      if (lockedTxn.state !== TransactionState.AUTHORISED) {
        throw new Error(`Only transactions in state AUTHORISED can be captured. Current state is: ${lockedTxn.state}`);
      }

      // Transition to CAPTURE_INITIATED
      await TransactionStateMachine.transition(txnId, TransactionState.CAPTURE_INITIATED, 'CAPTURE_STARTED', 'payment_orchestrator', {}, this.txnRepo);

      const gatewayAdapter = GatewayFactory.getAdapter(lockedTxn.selected_gateway!);
      const gatewayRes = await gatewayAdapter.capture(lockedTxn.gateway_reference!, amountPaise, traceId, mockHeaders);

      if (gatewayRes.success) {
        await TransactionStateMachine.transition(txnId, TransactionState.CAPTURED, 'CAPTURE_SUCCESS', 'payment_orchestrator', {
          gatewayResponse: gatewayRes.rawResponse
        }, this.txnRepo);

        const updated = this.txnRepo.getById(txnId)!;
        logger.info(traceId, 'orchestrator', 'capture_success', `Capture transaction ${txnId} completed successfully`);
        return updated;
      } else {
        await TransactionStateMachine.transition(txnId, TransactionState.CAPTURE_FAILED, 'CAPTURE_FAILED', 'payment_orchestrator', {
          gatewayResponse: gatewayRes.rawResponse,
          metadata: { error_code: gatewayRes.errorCode, error_message: gatewayRes.errorMessage }
        }, this.txnRepo);

        throw new Error(`Capture failed: ${gatewayRes.errorMessage}`);
      }
    } finally {
      this.txnRepo.releaseRowLock(txnId);
    }
  }

  /**
   * Orchestrates the VOID of authorized transaction funds (releases card hold) (Section A2.3)
   */
  public static async processVoid(
    txnId: string,
    traceId: string,
    mockHeaders?: MockHeaders
  ): Promise<Transaction> {
    logger.info(traceId, 'orchestrator', 'void_started', `Orchestrating Void for Transaction ${txnId}`);

    const lockedTxn = await this.txnRepo.selectForUpdate(txnId, `orch_void_${Date.now()}`);
    if (!lockedTxn) {
      throw new Error(`Database row lock failure: could not secure lock on transaction ${txnId} for void`);
    }

    try {
      if (lockedTxn.state !== TransactionState.AUTHORISED) {
        throw new Error(`Only transactions in state AUTHORISED can be voided. Current state is: ${lockedTxn.state}`);
      }

      // Transition to VOID_INITIATED
      await TransactionStateMachine.transition(txnId, TransactionState.VOID_INITIATED, 'VOID_STARTED', 'payment_orchestrator', {}, this.txnRepo);

      const gatewayAdapter = GatewayFactory.getAdapter(lockedTxn.selected_gateway!);
      const gatewayRes = await gatewayAdapter.void(lockedTxn.gateway_reference!, traceId, mockHeaders);

      if (gatewayRes.success) {
        await TransactionStateMachine.transition(txnId, TransactionState.VOIDED, 'VOID_SUCCESS', 'payment_orchestrator', {
          gatewayResponse: gatewayRes.rawResponse
        }, this.txnRepo);

        const updated = this.txnRepo.getById(txnId)!;
        logger.info(traceId, 'orchestrator', 'void_success', `Void transaction ${txnId} completed successfully`);
        return updated;
      } else {
        // Revert back to authorized state or fail
        await TransactionStateMachine.transition(txnId, TransactionState.FAILED, 'VOID_FAILED', 'payment_orchestrator', {
          gatewayResponse: gatewayRes.rawResponse,
          metadata: { error_code: gatewayRes.errorCode, error_message: gatewayRes.errorMessage }
        }, this.txnRepo);

        throw new Error(`Void failed: ${gatewayRes.errorMessage}`);
      }
    } finally {
      this.txnRepo.releaseRowLock(txnId);
    }
  }

  /**
   * Orchestrates full or partial REFUND on captured transaction funds (Section A2.3)
   */
  public static async processRefund(
    txnId: string,
    amountPaise: number,
    traceId: string,
    mockHeaders?: MockHeaders
  ): Promise<Refund> {
    logger.info(traceId, 'orchestrator', 'refund_started', `Orchestrating Refund of ${amountPaise} paise for Transaction ${txnId}`);

    const lockedTxn = await this.txnRepo.selectForUpdate(txnId, `orch_refund_${Date.now()}`);
    if (!lockedTxn) {
      throw new Error(`Database row lock failure: could not secure lock on transaction ${txnId} for refund`);
    }

    try {
      const eligibleForRefund = lockedTxn.state === TransactionState.CAPTURED || lockedTxn.state === TransactionState.SETTLED || lockedTxn.state === TransactionState.PARTIALLY_REFUNDED;
      if (!eligibleForRefund) {
        throw new Error(`Only captured or settled transactions can be refunded. Current state is: ${lockedTxn.state}`);
      }

      // Calculate total previous refunds
      const existingRefunds = this.refundRepo.getByTransactionId(txnId);
      const totalRefundedAlready = existingRefunds.reduce((sum, r) => sum + Number(r.amount_paise), 0);

      if (totalRefundedAlready + amountPaise > Number(lockedTxn.amount_paise)) {
        throw new Error(`REFUND_EXCEEDS_CAPTURE_LIMIT: Total refunded amount would exceed original capture limit. Eligible remainder: ${Number(lockedTxn.amount_paise) - totalRefundedAlready} paise`);
      }

      // Transition to REFUND_INITIATED
      await TransactionStateMachine.transition(txnId, TransactionState.REFUND_INITIATED, 'REFUND_STARTED', 'payment_orchestrator', {}, this.txnRepo);

      // Create unique refund record
      const refundId = `ref_${Date.now()}_${crypto.randomBytes(4).toString('hex')}`;
      const refundRecord: Refund = {
        id: refundId,
        transaction_id: txnId,
        amount_paise: amountPaise,
        gateway_refund_id: '',
        state: 'PENDING',
        created_at: new Date(),
        updated_at: new Date()
      };
      this.refundRepo.save(refundRecord);

      const gatewayAdapter = GatewayFactory.getAdapter(lockedTxn.selected_gateway!);
      const gatewayRes = await gatewayAdapter.refund(lockedTxn.gateway_reference!, amountPaise, traceId, mockHeaders);

      if (gatewayRes.success) {
        refundRecord.state = 'COMPLETED';
        refundRecord.gateway_refund_id = gatewayRes.gatewayReference || '';
        refundRecord.updated_at = new Date();
        this.refundRepo.save(refundRecord);

        // Transition transaction state based on whether partial or complete refund occurred
        const finalState = totalRefundedAlready + amountPaise === Number(lockedTxn.amount_paise) ? TransactionState.REFUNDED : TransactionState.PARTIALLY_REFUNDED;
        
        await TransactionStateMachine.transition(txnId, finalState, 'REFUND_SUCCESS', 'payment_orchestrator', {
          gatewayReference: gatewayRes.gatewayReference,
          gatewayResponse: gatewayRes.rawResponse
        }, this.txnRepo);

        logger.info(traceId, 'orchestrator', 'refund_success', `Refund completed successfully for refund_id: ${refundId}`);
        return refundRecord;
      } else {
        refundRecord.state = 'FAILED';
        refundRecord.updated_at = new Date();
        this.refundRepo.save(refundRecord);

        await TransactionStateMachine.transition(txnId, TransactionState.REFUND_FAILED, 'REFUND_FAILED', 'payment_orchestrator', {
          gatewayResponse: gatewayRes.rawResponse,
          metadata: { error_code: gatewayRes.errorCode, error_message: gatewayRes.errorMessage }
        }, this.txnRepo);

        throw new Error(`Refund failed: ${gatewayRes.errorMessage}`);
      }
    } finally {
      this.txnRepo.releaseRowLock(txnId);
    }
  }
}
