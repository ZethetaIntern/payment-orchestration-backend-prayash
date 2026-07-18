/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import { GatewayName, PaymentMethod, CircuitBreakerState, CircuitBreakerConfig, GatewayHealthMetric } from '../types/payment';
import { CircuitBreakerRepository, GatewayConfigRepository } from '../db/repositories';
import { dbInstance } from '../db/database'; // We still need the raw metrics collection for score computing
import { logger } from './logger';

export class CircuitBreakerError extends Error {
  constructor(public gateway: GatewayName, public method: PaymentMethod) {
    super(`Gateway ${gateway} circuit breaker is OPEN for payment method ${method}`);
    this.name = 'CircuitBreakerError';
  }
}

export class RateLimitError extends Error {
  constructor(public gateway: GatewayName) {
    super(`Gateway ${gateway} outbound rate limit exceeded`);
    this.name = 'RateLimitError';
  }
}

// Token Bucket algorithm for Outbound Rate Limiting
export class OutboundRateLimiter {
  private static instance: OutboundRateLimiter;
  private buckets = new Map<string, { tokens: number; lastRefill: number }>();

  private constructor() {}

  public static getInstance(): OutboundRateLimiter {
    if (!this.instance) {
      this.instance = new OutboundRateLimiter();
    }
    return this.instance;
  }

  /**
   * Checks rate limit for a gateway. Returns true if allowed, false if rate-limited.
   */
  public checkLimit(gateway: GatewayName, limitPerSec: number): boolean {
    const now = Date.now();
    let bucket = this.buckets.get(gateway);

    if (!bucket) {
      bucket = { tokens: limitPerSec, lastRefill: now };
      this.buckets.set(gateway, bucket);
    }

    // Refill tokens: (time elapsed in seconds) * limit
    const elapsedSec = (now - bucket.lastRefill) / 1000;
    if (elapsedSec > 0) {
      bucket.tokens = Math.min(limitPerSec, bucket.tokens + elapsedSec * limitPerSec);
      bucket.lastRefill = now;
    }

    if (bucket.tokens >= 1) {
      bucket.tokens -= 1;
      return true;
    }

    return false;
  }
}

export class CircuitBreakerManager {
  private static repo = new CircuitBreakerRepository();

  /**
   * Record a successful operation on a gateway for a method
   */
  public static recordSuccess(gateway: GatewayName, method: PaymentMethod, traceId: string) {
    const cb = this.repo.getByKey(gateway, method);
    if (!cb) return;

    if (cb.state === CircuitBreakerState.HALF_OPEN) {
      cb.state = CircuitBreakerState.CLOSED;
      cb.failure_count = 0;
      cb.last_state_change = new Date();
      this.repo.save(cb);

      logger.info(
        traceId,
        'circuit_breaker',
        'state_changed',
        `Circuit breaker for ${gateway}:${method} closed successfully (healthy response received in HALF_OPEN)`
      );
    } else if (cb.failure_count > 0) {
      cb.failure_count = 0;
      this.repo.save(cb);
    }
  }

  /**
   * Record a failure operation on a gateway for a method
   */
  public static recordFailure(gateway: GatewayName, method: PaymentMethod, traceId: string) {
    const cb = this.repo.getByKey(gateway, method);
    if (!cb) return;

    cb.failure_count++;
    cb.last_state_change = new Date();

    if (cb.state === CircuitBreakerState.CLOSED && cb.failure_count >= cb.failure_threshold) {
      cb.state = CircuitBreakerState.OPEN;
      logger.error(
        traceId,
        'circuit_breaker',
        'state_changed',
        `Circuit breaker for ${gateway}:${method} TRIPPED to OPEN due to ${cb.failure_count} consecutive failures`
      );
    } else if (cb.state === CircuitBreakerState.HALF_OPEN) {
      cb.state = CircuitBreakerState.OPEN;
      logger.error(
        traceId,
        'circuit_breaker',
        'state_changed',
        `Circuit breaker for ${gateway}:${method} reverted to OPEN after failure in HALF_OPEN`
      );
    }

    this.repo.save(cb);
  }

  /**
   * Update Circuit Breaker States based on elapsed timeouts (OPEN -> HALF_OPEN)
   */
  public static updateCircuitBreakerStates() {
    const now = new Date();
    const cbs = this.repo.getAll();

    for (const cb of cbs) {
      if (cb.state === CircuitBreakerState.OPEN) {
        const elapsedSeconds = (now.getTime() - cb.last_state_change.getTime()) / 1000;
        if (elapsedSeconds >= cb.timeout_seconds) {
          cb.state = CircuitBreakerState.HALF_OPEN;
          cb.last_state_change = now;
          this.repo.save(cb);

          logger.info(
            'system-trace-000000',
            'circuit_breaker',
            'state_changed',
            `Circuit breaker for ${cb.gateway}:${cb.payment_method} entered HALF_OPEN (timeout elapsed)`
          );
        }
      }
    }
  }

  /**
   * Get Health Score for Gateway
   */
  public static getHealthScore(gateway: GatewayName, method: PaymentMethod): number {
    const cb = this.repo.getByKey(gateway, method);
    if (!cb) return 0.0; // Unsupported combination

    this.updateCircuitBreakerStates(); // dynamically shift OPEN -> HALF_OPEN if timeout elapsed

    if (cb.state === CircuitBreakerState.OPEN) return 0.0;
    if (cb.state === CircuitBreakerState.HALF_OPEN) return 0.5;
    return 1.0; // CLOSED (healthy)
  }
}

export class GatewayRouter {
  private static rateLimiter = OutboundRateLimiter.getInstance();
  private static cbRepo = new CircuitBreakerRepository();
  private static configRepo = new GatewayConfigRepository();

  /**
   * Core routing algorithm: calculates score for each active gateway
   * and routes to the optimal one, handling circuit breaker checks and rate limiting.
   */
  public static route(
    amountPaise: number,
    paymentMethod: PaymentMethod,
    traceId: string
  ): { selectedGateway: GatewayName; scoredGateways: Array<{ name: GatewayName; score: number }> } {
    const weights = this.configRepo.getRoutingConfig();
    const activeGateways = this.configRepo.getAll().filter((g) => g.is_active);

    if (activeGateways.length === 0) {
      throw new Error('No active payment gateways available in system configuration');
    }

    // 1. Gather all health metrics to identify max/min latencies and costs for normalization
    const metricsMap = new Map<GatewayName, GatewayHealthMetric>();
    dbInstance.gatewayHealthMetrics.forEach((m) => {
      if (m.payment_method === paymentMethod) {
        metricsMap.set(m.gateway, m);
      }
    });

    const activeMetrics = activeGateways.map((g) => metricsMap.get(g.gateway)).filter(Boolean) as GatewayHealthMetric[];

    const latencies = activeMetrics.map((m) => m.p95_latency_ms);
    const minLatency = latencies.length > 0 ? Math.min(...latencies) : 200;
    const maxLatency = latencies.length > 0 ? Math.max(...latencies) : 1000;

    // Calculate actual costs for each gateway based on transaction size
    const costMap = new Map<GatewayName, number>();
    activeGateways.forEach((g) => {
      // Cost = Percentage fee * amount + fixed fee
      const percentageFee = g.base_percentage_fee * amountPaise;
      const totalCost = percentageFee + g.fixed_fee_paise;
      costMap.set(g.gateway, totalCost);
    });

    const costs = Array.from(costMap.values());
    const minCost = costs.length > 0 ? Math.min(...costs) : 0;
    const maxCost = costs.length > 0 ? Math.max(...costs) : 1000;

    // 2. Score each gateway
    const scoredGateways = activeGateways.map((g) => {
      const metric = metricsMap.get(g.gateway);
      const successRate = metric ? metric.success_rate : 0.95; // Default success rate

      // Normalization functions guarding against division-by-zero (Error #2)
      const normalizedSuccess = successRate; // Already 0.0 - 1.0

      const currentLatency = metric ? metric.p95_latency_ms : 400;
      const normalizedLatency = maxLatency === minLatency ? 0.5 : (currentLatency - minLatency) / (maxLatency - minLatency);

      const currentCost = costMap.get(g.gateway) || 0;
      const normalizedCost = maxCost === minCost ? 0.5 : (currentCost - minCost) / (maxCost - minCost);

      const healthScore = CircuitBreakerManager.getHealthScore(g.gateway, paymentMethod);

      // Support check
      let fitScore = 1.0;
      if (g.gateway === GatewayName.UPI && paymentMethod !== PaymentMethod.UPI) {
        fitScore = 0.0;
      }

      // Formula (A3.2):
      const score =
        weights.weight_success_rate * normalizedSuccess +
        weights.weight_latency * (1 - normalizedLatency) +
        weights.weight_cost * (1 - normalizedCost) +
        weights.weight_health * healthScore +
        weights.weight_fit * fitScore;

      return {
        name: g.gateway,
        score: Math.max(0, Math.min(1.0, score)),
        isHealthy: healthScore > 0 // False if CB is OPEN
      };
    });

    // Sort descending by score
    scoredGateways.sort((a, b) => b.score - a.score);

    // 3. Select Gateway with High-Score & degraded logic from Section A3.2
    // If selected gateway is degraded (HealthScore = 0.5), prefer the 2nd highest unless the score difference is > 20%
    let selected: GatewayName | null = null;

    if (scoredGateways.length > 0) {
      const primary = scoredGateways[0];
      const primaryCB = this.cbRepo.getByKey(primary.name, paymentMethod);

      if (primary.isHealthy) {
        if (primaryCB && primaryCB.state === CircuitBreakerState.HALF_OPEN && scoredGateways.length > 1) {
          const secondary = scoredGateways[1];
          if (secondary.isHealthy) {
            const scoreDifference = primary.score - secondary.score;
            if (scoreDifference <= 0.20) {
              selected = secondary.name;
              logger.info(
                traceId,
                'gateway_router',
                'route_selected',
                `Preferring secondary gateway ${secondary.name} because primary ${primary.name} is HALF-OPEN and score diff is <= 20% (${Math.round(scoreDifference * 100)}%)`
              );
            }
          }
        }
      }

      if (!selected) {
        // Fallback to highest healthy scorer
        const healthyScorer = scoredGateways.find((sg) => sg.isHealthy);
        if (healthyScorer) {
          selected = healthyScorer.name;
        } else {
          // All gateways OPEN, route to primary as fail-fast fallback
          selected = primary.name;
        }
      }
    }

    if (!selected) {
      selected = GatewayName.RAZORPAY; // Absolute fallback
    }

    // 4. Rate-limit validation (Section A8.4)
    const config = this.configRepo.getByName(selected)!;
    if (!this.rateLimiter.checkLimit(selected, config.rate_limit_per_second)) {
      logger.warn(traceId, 'gateway_router', 'rate_limit_tripped', `Gateway ${selected} outbound rate-limited (Max: ${config.rate_limit_per_second}/s)`);
      // Failover attempt: find next highest scoring healthy gateway that isn't rate limited
      const alternative = scoredGateways.find((sg) => sg.name !== selected && sg.isHealthy);
      if (alternative) {
        const altConfig = this.configRepo.getByName(alternative.name)!;
        if (this.rateLimiter.checkLimit(alternative.name, altConfig.rate_limit_per_second)) {
          logger.info(
            traceId,
            'gateway_router',
            'failover_success',
            `Failed over to ${alternative.name} due to rate-limiting on primary ${selected}`
          );
          selected = alternative.name;
        }
      }
    }

    logger.info(
      traceId,
      'gateway_router',
      'route_selected',
      `Selected ${selected} with score ${scoredGateways.find((sg) => sg.name === selected)?.score.toFixed(3) || 0.0} for payment method ${paymentMethod}`
    );

    return {
      selectedGateway: selected,
      scoredGateways: scoredGateways.map((sg) => ({ name: sg.name, score: sg.score }))
    };
  }
}
