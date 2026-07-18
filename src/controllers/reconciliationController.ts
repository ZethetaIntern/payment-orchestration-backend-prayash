/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import { Request, Response } from 'express';
import { ReconciliationEngine } from '../services/reconciliation';
import { ReconciliationRepository } from '../db/repositories';
import { logger } from '../services/logger';

export class ReconciliationController {
  private static repo = new ReconciliationRepository();

  /**
   * POST /api/v1/reconciliation/trigger
   * Trigger a periodic manual batch reconciliation over stale records
   */
  public static async trigger(req: Request, res: Response): Promise<void> {
    const traceId = `trc_rec_${Date.now()}_${Math.floor(Math.random() * 10000)}`;
    const runId = `rec_run_${Date.now()}`;

    try {
      const result = await ReconciliationEngine.run(runId, traceId);
      logger.info(traceId, 'reconciliation_controller', 'manual_run_completed', `Reconciliation completed successfully. Run: ${runId}`);
      res.status(200).json({
        run_id: runId,
        processed_count: result.processedCount,
        discrepancy_count: result.discrepancyCount,
        anomaly_count: result.anomalyCount,
        logs: result.logs
      });
    } catch (err: any) {
      logger.error(traceId, 'reconciliation_controller', 'manual_run_failed', `Failed executing reconciliation batch run: ${err.message}`);
      res.status(500).json({ error: 'RECONCILIATION_FAILED', message: err.message });
    }
  }

  /**
   * GET /api/v1/reconciliation/logs
   * List all reconciliation records
   */
  public static async listLogs(req: Request, res: Response): Promise<void> {
    try {
      const logs = ReconciliationController.repo.getAllLogs();
      res.status(200).json(logs);
    } catch (err: any) {
      res.status(500).json({ error: 'RECONCILIATION_LOGS_ERROR', message: err.message });
    }
  }
}
