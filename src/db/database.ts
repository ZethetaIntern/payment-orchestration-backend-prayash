/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  Transaction,
  TransactionStateLog,
  GatewayRoute,
  IdempotencyKey,
  ProcessedWebhookEvent,
  GatewayHealthMetric,
  CircuitBreakerConfig,
  ReconciliationLog,
  Refund,
  GatewayConfig,
  RoutingConfig,
  GatewayName,
  PaymentMethod,
  CircuitBreakerState
} from '../types/payment';

// Simple implementation of transaction-level advisory locks and row-locks in TypeScript
class DatabaseLockManager {
  private activeAdvisoryLocks = new Set<string>();
  private activeRowLocks = new Set<string>();
  private waitingAdvisoryLocks = new Map<string, Array<() => void>>();
  private waitingRowLocks = new Map<string, Array<() => void>>();

  // Emulate pg_advisory_xact_lock
  async acquireAdvisoryLock(key: string, txnId: string): Promise<boolean> {
    const lockKey = `adv_${key}`;
    if (this.activeAdvisoryLocks.has(lockKey)) {
      return new Promise<boolean>((resolve) => {
        if (!this.waitingAdvisoryLocks.has(lockKey)) {
          this.waitingAdvisoryLocks.set(lockKey, []);
        }
        this.waitingAdvisoryLocks.get(lockKey)!.push(() => {
          this.activeAdvisoryLocks.add(lockKey);
          resolve(true);
        });
      });
    } else {
      this.activeAdvisoryLocks.add(lockKey);
      return true;
    }
  }

  releaseAdvisoryLock(key: string) {
    const lockKey = `adv_${key}`;
    const waiters = this.waitingAdvisoryLocks.get(lockKey);
    if (waiters && waiters.length > 0) {
      const next = waiters.shift()!;
      if (waiters.length === 0) {
        this.waitingAdvisoryLocks.delete(lockKey);
      }
      setTimeout(next, 0);
    } else {
      this.activeAdvisoryLocks.delete(lockKey);
    }
  }

  // Emulate SELECT FOR UPDATE row-level lock
  async acquireRowLock(rowId: string, txnId: string): Promise<boolean> {
    const lockKey = `row_${rowId}`;
    if (this.activeRowLocks.has(lockKey)) {
      return new Promise<boolean>((resolve) => {
        if (!this.waitingRowLocks.has(lockKey)) {
          this.waitingRowLocks.set(lockKey, []);
        }
        this.waitingRowLocks.get(lockKey)!.push(() => {
          this.activeRowLocks.add(lockKey);
          resolve(true);
        });
      });
    } else {
      this.activeRowLocks.add(lockKey);
      return true;
    }
  }

  releaseRowLock(rowId: string) {
    const lockKey = `row_${rowId}`;
    const waiters = this.waitingRowLocks.get(lockKey);
    if (waiters && waiters.length > 0) {
      const next = waiters.shift()!;
      if (waiters.length === 0) {
        this.waitingRowLocks.delete(lockKey);
      }
      setTimeout(next, 0);
    } else {
      this.activeRowLocks.delete(lockKey);
    }
  }
}

export class RelationalDatabase {
  // In-Memory Collections
  transactions: Map<string, Transaction> = new Map();
  transactionStateLogs: TransactionStateLog[] = [];
  gatewayRoutes: GatewayRoute[] = [];
  idempotencyKeys: Map<string, IdempotencyKey> = new Map();
  processedWebhookEvents: Map<string, ProcessedWebhookEvent> = new Map(); // Key: gateway:event_id
  gatewayHealthMetrics: GatewayHealthMetric[] = [];
  circuitBreakers: Map<string, CircuitBreakerConfig> = new Map(); // Key: gateway:payment_method
  reconciliationLogs: ReconciliationLog[] = [];
  refunds: Map<string, Refund> = new Map();
  gatewayConfigs: Map<GatewayName, GatewayConfig> = new Map();
  routingConfig: RoutingConfig = {
    config_key: 'active_weights',
    weight_success_rate: 0.35,
    weight_latency: 0.20,
    weight_cost: 0.20,
    weight_health: 0.15,
    weight_fit: 0.10
  };

  private lockManager = new DatabaseLockManager();
  private txnCounter = 0;

  constructor() {
    this.seedDatabase();
  }

  // Start an advisory transaction-scoped lock
  async pgAdvisoryXactLock(idempotencyKey: string, lockOwnerTxnId: string): Promise<void> {
    await this.lockManager.acquireAdvisoryLock(idempotencyKey, lockOwnerTxnId);
  }

  releaseAdvisoryLock(idempotencyKey: string) {
    this.lockManager.releaseAdvisoryLock(idempotencyKey);
  }

  // Row locking emulating SELECT ... FOR UPDATE
  async selectTransactionForUpdate(id: string, lockOwnerTxnId: string): Promise<Transaction | null> {
    const exists = this.transactions.get(id);
    if (!exists) return null;
    await this.lockManager.acquireRowLock(id, lockOwnerTxnId);
    return { ...exists }; // return copy
  }

  releaseRowLock(id: string) {
    this.lockManager.releaseRowLock(id);
  }

  // Generate unique transaction reference ID
  generateTxnId(): string {
    this.txnCounter++;
    return `txn_${Date.now()}_${Math.floor(Math.random() * 1000000)}`;
  }

  private seedDatabase() {
    // Seed Gateway Configs with realistic pricing structures from A3.4
    const configs: GatewayConfig[] = [
      {
        gateway: GatewayName.RAZORPAY,
        is_active: true,
        base_percentage_fee: 0.02, // 2%
        fixed_fee_paise: 200, // 2 INR
        rate_limit_per_second: 200
      },
      {
        gateway: GatewayName.STRIPE,
        is_active: true,
        base_percentage_fee: 0.025, // 2.5%
        fixed_fee_paise: 300, // 3 INR
        rate_limit_per_second: 100
      },
      {
        gateway: GatewayName.PAYU,
        is_active: true,
        base_percentage_fee: 0.018, // 1.8%
        fixed_fee_paise: 150, // 1.5 INR
        rate_limit_per_second: 150
      },
      {
        gateway: GatewayName.UPI,
        is_active: true,
        base_percentage_fee: 0.00, // 0%
        fixed_fee_paise: 0, // 0 INR
        rate_limit_per_second: 100
      }
    ];

    for (const c of configs) {
      this.gatewayConfigs.set(c.gateway, c);
    }

    // Seed Circuit Breakers for all gateways and payment methods
    const gateways = [GatewayName.RAZORPAY, GatewayName.STRIPE, GatewayName.PAYU, GatewayName.UPI];
    const methods = [PaymentMethod.CARD, PaymentMethod.UPI, PaymentMethod.NET_BANKING, PaymentMethod.WALLET];

    for (const gateway of gateways) {
      for (const method of methods) {
        // UPI gateway only supports UPI method, etc.
        if (gateway === GatewayName.UPI && method !== PaymentMethod.UPI) {
          continue;
        }
        const key = `${gateway}:${method}`;
        this.circuitBreakers.set(key, {
          gateway,
          payment_method: method,
          state: CircuitBreakerState.CLOSED,
          failure_count: 0,
          last_state_change: new Date(),
          failure_threshold: 3, // Trip after 3 consecutive failures
          timeout_seconds: 15 // Re-test after 15 seconds
        });
      }
    }

    // Seed the Historical Performance Dataset from Section A3.4
    // We will seed dynamic health metrics to let our router compute scores correctly
    const historicalData = [
      // Razorpay
      { gateway: GatewayName.RAZORPAY, method: PaymentMethod.CARD, success: 0.968, p95: 520, txs: 25300 },
      { gateway: GatewayName.RAZORPAY, method: PaymentMethod.UPI, success: 0.950, p95: 450, txs: 18500 },
      { gateway: GatewayName.RAZORPAY, method: PaymentMethod.NET_BANKING, success: 0.941, p95: 780, txs: 32000 },
      // Stripe
      { gateway: GatewayName.STRIPE, method: PaymentMethod.CARD, success: 0.982, p95: 350, txs: 22100 },
      { gateway: GatewayName.STRIPE, method: PaymentMethod.UPI, success: 0.988, p95: 310, txs: 15200 },
      // PayU
      { gateway: GatewayName.PAYU, method: PaymentMethod.CARD, success: 0.918, p95: 750, txs: 12200 },
      { gateway: GatewayName.PAYU, method: PaymentMethod.UPI, success: 0.935, p95: 620, txs: 9800 },
      { gateway: GatewayName.PAYU, method: PaymentMethod.NET_BANKING, success: 0.892, p95: 950, txs: 15500 },
      // UPI (NPCI)
      { gateway: GatewayName.UPI, method: PaymentMethod.UPI, success: 0.988, p95: 250, txs: 30500 }
    ];

    historicalData.forEach((h, index) => {
      this.gatewayHealthMetrics.push({
        id: `seed_${index}`,
        gateway: h.gateway,
        payment_method: h.method,
        recorded_at: new Date(),
        success_rate: h.success,
        p95_latency_ms: h.p95,
        total_transactions: h.txs,
        status: h.success >= 0.95 ? 'healthy' : (h.success >= 0.90 ? 'degraded' : 'down')
      });
    });
  }
}

export const dbInstance = new RelationalDatabase();
