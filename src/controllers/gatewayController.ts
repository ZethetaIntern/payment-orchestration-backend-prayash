/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import { Request, Response } from 'express';
import { GatewayConfigRepository } from '../db/repositories';
import { logger } from '../services/logger';

export class GatewayController {
  private static repo = new GatewayConfigRepository();

  /**
   * GET /api/v1/gateways
   * List all configured payment gateways and their states
   */
  public static async list(req: Request, res: Response): Promise<void> {
    try {
      const gateways = GatewayController.repo.getAll();
      res.status(200).json(gateways);
    } catch (err: any) {
      res.status(500).json({ error: 'GATEWAY_LIST_ERROR', message: err.message });
    }
  }

  /**
   * GET /api/v1/routing/config
   * Fetch scoring algorithm weights
   */
  public static async getWeights(req: Request, res: Response): Promise<void> {
    try {
      const config = GatewayController.repo.getRoutingConfig();
      res.status(200).json(config);
    } catch (err: any) {
      res.status(500).json({ error: 'CONFIG_FETCH_ERROR', message: err.message });
    }
  }

  /**
   * POST /api/v1/routing/config
   * Update scoring weights dynamically (with validation)
   */
  public static async updateWeights(req: Request, res: Response): Promise<void> {
    const { weight_success_rate, weight_latency, weight_cost, weight_health, weight_fit } = req.body;

    // 1. Validation checks
    const w1 = Number(weight_success_rate || 0);
    const w2 = Number(weight_latency || 0);
    const w3 = Number(weight_cost || 0);
    const w4 = Number(weight_health || 0);
    const w5 = Number(weight_fit || 0);

    const sum = w1 + w2 + w3 + w4 + w5;

    // We allow slight floating point inaccuracies, say ±0.01 tolerance around 1.0 (100%)
    if (Math.abs(sum - 1.0) > 0.01) {
      res.status(400).json({
        error: 'VALIDATION_ERROR',
        message: `Scoring algorithm weights must sum to exactly 1.0 (100%). Current sum: ${sum.toFixed(3)}`
      });
      return;
    }

    try {
      const updated = {
        config_key: 'default',
        weight_success_rate: w1,
        weight_latency: w2,
        weight_cost: w3,
        weight_health: w4,
        weight_fit: w5
      };

      GatewayController.repo.saveRoutingConfig(updated);
      logger.info('system-trace-000000', 'gateway_controller', 'weights_updated', 'Routing config weights updated dynamically', updated);
      res.status(200).json(updated);
    } catch (err: any) {
      res.status(500).json({ error: 'CONFIG_UPDATE_ERROR', message: err.message });
    }
  }
}
