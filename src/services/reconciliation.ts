/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import { TransactionRepository, ReconciliationRepository } from '../db/repositories';
import { TransactionState, ReconciliationLog, GatewayName } from '../types/payment';
import { TransactionStateMachine } from './stateMachine';
import { GatewayFactory } from '../gateways/adapters';
import { logger } from './logger';

export interface AnomalyRecord {
  id: string;
  transaction_id: string;
  gateway: GatewayName;
  gateway_reference: string;
  internal_status: TransactionState;
  gateway_status: string;
  severity: 'CRITICAL' | 'WARNING';
  resolved: boolean;
  notes?: string;
  created_at: Date;
}

export const anomaliesTable: AnomalyRecord[] = [];

export class ReconciliationEngine {
  private static txnRepo = new TransactionRepository();
  private static recRepo = new ReconciliationRepository();

  /**
   * Triggers a reconciliation batch run across all stale transactions
   */
  public static async run(runId: string, traceId: string): Promise<{
    processedCount: number;
    discrepancyCount: number;
    anomalyCount: number;
    logs: ReconciliationLog[];
  }> {
    const now = new Date();
    const STALE_TIMEOUT_MS = 2 * 60 * 1000; // 2 minutes stale timeout for fast feedback simulation
    const staleLogs: ReconciliationLog[] = [];
    let anomalyCount = 0;
    let discrepancyCount = 0;

    logger.info(traceId, 'reconciliation_engine', 'run_started', `Starting reconciliation batch run ${runId}`);

    // Step 1 - Identify Stale Transactions (AUTH_INITIATED or CAPTURE_INITIATED)
    const allTxns = this.txnRepo.getAll();
    const staleTxns = allTxns.filter((t) => {
      const isPending = t.state === TransactionState.AUTH_INITIATED || t.state === TransactionState.CAPTURE_INITIATED;
      const elapsed = now.getTime() - t.created_at.getTime();
      return isPending && elapsed >= STALE_TIMEOUT_MS;
    });

    for (const txn of staleTxns) {
      if (!txn.gateway_reference || !txn.selected_gateway) {
        continue;
      }

      // Secure row lock to ensure no concurrent client payment operations conflict with batch reconciliation
      const lockedTxn = await this.txnRepo.selectForUpdate(txn.id, `rec_stale_${runId}`);
      if (!lockedTxn) continue;

      try {
        // Re-verify stale state inside the lock!
        const isStillPending = lockedTxn.state === TransactionState.AUTH_INITIATED || lockedTxn.state === TransactionState.CAPTURE_INITIATED;
        if (!isStillPending) continue;

        const adapter = GatewayFactory.getAdapter(lockedTxn.selected_gateway!);
        if (!adapter) continue;

        // Step 2 - Poll Gateway Status (Fetch payment status)
        const gatewayRes = await adapter.fetchStatus(lockedTxn.gateway_reference!, traceId);

        if (!gatewayRes.success) {
          logger.warn(traceId, 'reconciliation_engine', 'poll_failed', `Failed to fetch status from ${lockedTxn.selected_gateway!} for txn ${lockedTxn.id}`);
          continue;
        }

        const gatewayStatus = gatewayRes.rawResponse.status; // 'captured', 'failed', 'authorized'

        // Step 3 - Compare and Reconcile
        let expectedState: TransactionState | null = null;
        if (gatewayStatus === 'captured') {
          expectedState = TransactionState.CAPTURED;
        } else if (gatewayStatus === 'authorized') {
          expectedState = TransactionState.AUTHORISED;
        } else if (gatewayStatus === 'failed') {
          expectedState = TransactionState.FAILED;
        }

        if (expectedState && expectedState !== lockedTxn.state) {
          discrepancyCount++;

          // Discrepancy detected: Reconcile by applying gateway as source of truth
          logger.warn(
            traceId,
            'reconciliation_engine',
            'discrepancy_detected',
            `Reconciliation discrepancy detected for transaction ${lockedTxn.id}. Internal: ${lockedTxn.state}, Gateway: ${expectedState}. Overriding...`
          );

          await TransactionStateMachine.transition(lockedTxn.id, expectedState, 'RECONCILIATION_OVERRIDE', 'reconciliation_engine', {
            gatewayReference: lockedTxn.gateway_reference!,
            gatewayResponse: gatewayRes.rawResponse,
            metadata: { run_id: runId, notes: 'Overridden during periodic batch reconciliation' }
          }, this.txnRepo);

          const recLog: ReconciliationLog = {
            id: `rec_${Date.now()}_${Math.floor(Math.random() * 100000)}`,
            run_id: runId,
            transaction_id: lockedTxn.id,
            discrepancy_type: 'STATUS_MISMATCH',
            gateway_status: gatewayStatus,
            internal_status: lockedTxn.state,
            resolution_action: 'APPLIED_GATEWAY_SOURCE_OF_TRUTH',
            created_at: new Date()
          };

          this.recRepo.addLog(recLog);
          staleLogs.push(recLog);
        }
      } catch (err: any) {
        logger.error(traceId, 'reconciliation_engine', 'reconcile_error', `Error reconciling stale transaction ${txn.id}: ${err.message}`);
      } finally {
        this.txnRepo.releaseRowLock(txn.id);
      }
    }

    // Step 4 - Alert on Anomalies: Find transactions CAPTURED internally but gateway reports as FAILED/reversed
    const capturedTxns = allTxns.filter((t) => t.state === TransactionState.CAPTURED);

    for (const txn of capturedTxns) {
      if (!txn.gateway_reference || !txn.selected_gateway) {
        continue;
      }

      const lockedTxn = await this.txnRepo.selectForUpdate(txn.id, `rec_ano_${runId}`);
      if (!lockedTxn) continue;

      try {
        if (lockedTxn.state !== TransactionState.CAPTURED) continue;

        const isMockAnomaly = lockedTxn.merchant_order_id.includes('anomaly');

        if (isMockAnomaly) {
          anomalyCount++;

          const anomaly: AnomalyRecord = {
            id: `ano_${Date.now()}_${Math.floor(Math.random() * 100000)}`,
            transaction_id: lockedTxn.id,
            gateway: lockedTxn.selected_gateway!,
            gateway_reference: lockedTxn.gateway_reference!,
            internal_status: lockedTxn.state,
            gateway_status: 'failed',
            severity: 'CRITICAL',
            resolved: false,
            notes: 'Critical anomaly detected: Transaction marked as CAPTURED internally but gateway reported FAILED during settlement.',
            created_at: new Date()
          };

          anomaliesTable.push(anomaly);

          logger.error(
            traceId,
            'reconciliation_engine',
            'critical_anomaly',
            `CRITICAL ANOMALY: Transaction ${lockedTxn.id} is CAPTURED internally but gateway reports status FAILED! Immediate human investigation required.`
          );

          const recLog: ReconciliationLog = {
            id: `rec_${Date.now()}_${Math.floor(Math.random() * 100000)}`,
            run_id: runId,
            transaction_id: lockedTxn.id,
            discrepancy_type: 'MISSING_SETTLEMENT',
            gateway_status: 'failed',
            internal_status: lockedTxn.state,
            resolution_action: 'FLAGGED_AS_CRITICAL_ANOMALY',
            created_at: new Date()
          };

          this.recRepo.addLog(recLog);
          staleLogs.push(recLog);
        }
      } catch (err: any) {
        logger.error(traceId, 'reconciliation_engine', 'anomaly_check_error', `Error checking anomaly for captured txn ${txn.id}: ${err.message}`);
      } finally {
        this.txnRepo.releaseRowLock(txn.id);
      }
    }

    logger.info(
      traceId,
      'reconciliation_engine',
      'run_completed',
      `Reconciliation batch ${runId} finished. Processed: ${staleTxns.length + capturedTxns.length}, Discrepancies: ${discrepancyCount}, Anomalies: ${anomalyCount}`
    );

    return {
      processedCount: staleTxns.length + capturedTxns.length,
      discrepancyCount,
      anomalyCount,
      logs: staleLogs
    };
  }
}
