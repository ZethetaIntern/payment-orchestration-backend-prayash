/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import { TransactionState, TransactionStateLog } from '../types/payment';
import { TransactionRepository } from '../db/repositories';
import { logger } from './logger';

export class InvalidStateTransitionException extends Error {
  constructor(public fromState: TransactionState | null, public toState: TransactionState) {
    super(`Invalid state transition from ${fromState || 'NULL'} to ${toState}`);
    this.name = 'InvalidStateTransitionException';
  }
}

export class TransactionStateMachine {
  // Defined valid state transitions mapping from -> array of valid destination states
  private static readonly transitions: Record<TransactionState, TransactionState[]> = {
    [TransactionState.CREATED]: [
      TransactionState.ROUTE_SELECTED,
      TransactionState.FAILED, // If abandoned or failed early
    ],
    [TransactionState.ROUTE_SELECTED]: [
      TransactionState.AUTH_INITIATED,
      TransactionState.FAILED,
    ],
    [TransactionState.AUTH_INITIATED]: [
      TransactionState.AUTHORISED,
      TransactionState.AUTH_FAILED,
      TransactionState.AUTH_EXPIRED,
      TransactionState.CAPTURED, // Direct capture flow support
    ],
    [TransactionState.AUTHORISED]: [
      TransactionState.CAPTURE_INITIATED,
      TransactionState.VOID_INITIATED,
      TransactionState.AUTH_EXPIRED,
    ],
    [TransactionState.AUTH_FAILED]: [
      TransactionState.ROUTE_SELECTED, // retry with alternative gateway
      TransactionState.FAILED,
    ],
    [TransactionState.CAPTURE_INITIATED]: [
      TransactionState.CAPTURED,
      TransactionState.PARTIALLY_CAPTURED,
      TransactionState.CAPTURE_FAILED,
    ],
    [TransactionState.CAPTURED]: [
      TransactionState.REFUND_INITIATED,
      TransactionState.SETTLED,
      TransactionState.DISPUTE_OPENED,
    ],
    [TransactionState.PARTIALLY_CAPTURED]: [
      TransactionState.CAPTURE_INITIATED, // capture remaining hold amount
      TransactionState.REFUND_INITIATED,
      TransactionState.SETTLED,
    ],
    [TransactionState.CAPTURE_FAILED]: [
      TransactionState.CAPTURE_INITIATED, // retry capture
      TransactionState.VOID_INITIATED,
      TransactionState.FAILED,
    ],
    [TransactionState.REFUND_INITIATED]: [
      TransactionState.REFUNDED,
      TransactionState.PARTIALLY_REFUNDED,
      TransactionState.REFUND_FAILED,
    ],
    [TransactionState.PARTIALLY_REFUNDED]: [
      TransactionState.REFUND_INITIATED, // refund remainder
    ],
    [TransactionState.REFUNDED]: [], // Terminal state
    [TransactionState.FAILED]: [], // Terminal state
    [TransactionState.VOID_INITIATED]: [
      TransactionState.VOIDED,
      TransactionState.FAILED,
    ],
    [TransactionState.VOIDED]: [], // Terminal state
    [TransactionState.SETTLED]: [
      TransactionState.REFUND_INITIATED,
      TransactionState.DISPUTE_OPENED,
    ],
    [TransactionState.AUTH_EXPIRED]: [
      TransactionState.FAILED, // or void
    ],
    [TransactionState.REFUND_FAILED]: [
      TransactionState.REFUND_INITIATED, // re-trigger refund
    ],
    [TransactionState.DISPUTE_OPENED]: [
      TransactionState.DISPUTE_RESOLVED,
    ],
    [TransactionState.DISPUTE_RESOLVED]: [
      TransactionState.REFUND_INITIATED, // if dispute settled in customer favor
    ],
  };

  /**
   * Validates if a state transition is allowed
   */
  public static isValidTransition(from: TransactionState | null, to: TransactionState): boolean {
    if (from === null) {
      return to === TransactionState.CREATED;
    }
    const allowed = this.transitions[from];
    return allowed ? allowed.includes(to) : false;
  }

  /**
   * Performs state transition atomically, logging to audit trail and verifying rules
   */
  public static async transition(
    txnId: string,
    toState: TransactionState,
    event: string,
    createdBy: string,
    params: {
      gatewayReference?: string;
      gatewayResponse?: any;
      metadata?: any;
    } = {},
    txnRepo: TransactionRepository = new TransactionRepository()
  ): Promise<void> {
    // Fetch transaction row
    const txn = txnRepo.getById(txnId);
    if (!txn) {
      throw new Error(`Transaction ${txnId} not found`);
    }

    const fromState = txn.state;

    // Validate transition
    if (!this.isValidTransition(fromState, toState)) {
      // Create a REJECTED_TRANSITION audit log entry for compliance tracking
      const rejectLog: TransactionStateLog = {
        id: `err_${Date.now()}_${Math.floor(Math.random() * 100000)}`,
        transaction_id: txnId,
        from_state: fromState,
        to_state: toState,
        event: 'REJECTED_TRANSITION',
        gateway_reference: params.gatewayReference || txn.gateway_reference,
        gateway_response: params.gatewayResponse ? JSON.stringify(params.gatewayResponse) : undefined,
        metadata: JSON.stringify({
          error: 'Invalid state transition',
          attempted_event: event,
          ip: params.metadata?.ip || '127.0.0.1'
        }),
        created_at: new Date(),
        created_by: createdBy
      };
      txnRepo.addStateLog(rejectLog);

      logger.error(
        txn.trace_id,
        'state_machine',
        'transition_rejected',
        `REJECTED transition from ${fromState} to ${toState} for transaction ${txnId}`,
        { transaction_id: txnId, metadata: { fromState, toState, event } }
      );

      throw new InvalidStateTransitionException(fromState, toState);
    }

    // Apply change
    txn.state = toState;
    if (params.gatewayReference) {
      txn.gateway_reference = params.gatewayReference;
    }
    txn.updated_at = new Date();
    txnRepo.save(txn);

    // Save transition audit log
    const auditLog: TransactionStateLog = {
      id: `log_${Date.now()}_${Math.floor(Math.random() * 100000)}`,
      transaction_id: txnId,
      from_state: fromState,
      to_state: toState,
      event,
      gateway_reference: params.gatewayReference || txn.gateway_reference,
      gateway_response: params.gatewayResponse ? JSON.stringify(params.gatewayResponse) : undefined,
      metadata: params.metadata ? JSON.stringify(params.metadata) : undefined,
      created_at: new Date(),
      created_by: createdBy
    };
    txnRepo.addStateLog(auditLog);

    logger.info(
      txn.trace_id,
      'state_machine',
      'transition_success',
      `Transitioned ${txnId} from ${fromState} to ${toState} via event ${event}`,
      { transaction_id: txnId, gateway: txn.selected_gateway, metadata: { fromState, toState, event } }
    );
  }
}
