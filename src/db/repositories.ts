/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import { dbInstance, RelationalDatabase } from './database';
import {
  Transaction,
  TransactionStateLog,
  IdempotencyKey,
  CircuitBreakerConfig,
  ProcessedWebhookEvent,
  ReconciliationLog,
  Refund,
  GatewayConfig,
  RoutingConfig,
  GatewayName,
  PaymentMethod,
  GatewayRoute
} from '../types/payment';

export class TransactionRepository {
  constructor(private db: RelationalDatabase = dbInstance) {}

  public getById(id: string): Transaction | null {
    const txn = this.db.transactions.get(id);
    return txn ? { ...txn } : null;
  }

  public getByMerchantOrderId(merchantOrderId: string): Transaction | null {
    const txn = Array.from(this.db.transactions.values()).find(
      (t) => t.merchant_order_id === merchantOrderId
    );
    return txn ? { ...txn } : null;
  }

  public getAll(): Transaction[] {
    return Array.from(this.db.transactions.values()).map((t) => ({ ...t }));
  }

  public save(transaction: Transaction): void {
    this.db.transactions.set(transaction.id, { ...transaction });
  }

  public async selectForUpdate(id: string, lockOwnerTxnId: string): Promise<Transaction | null> {
    return this.db.selectTransactionForUpdate(id, lockOwnerTxnId);
  }

  public releaseRowLock(id: string): void {
    this.db.releaseRowLock(id);
  }

  public getTimeline(transactionId: string): TransactionStateLog[] {
    return this.db.transactionStateLogs
      .filter((log) => log.transaction_id === transactionId)
      .sort((a, b) => a.created_at.getTime() - b.created_at.getTime());
  }

  public addStateLog(log: TransactionStateLog): void {
    this.db.transactionStateLogs.push({ ...log });
  }

  public saveGatewayRoute(route: GatewayRoute): void {
    this.db.gatewayRoutes.push({ ...route });
  }
}

export class IdempotencyRepository {
  constructor(private db: RelationalDatabase = dbInstance) {}

  public getByKey(key: string): IdempotencyKey | null {
    const entry = this.db.idempotencyKeys.get(key);
    return entry ? { ...entry } : null;
  }

  public save(entry: IdempotencyKey): void {
    this.db.idempotencyKeys.set(entry.key, { ...entry });
  }

  public delete(key: string): void {
    this.db.idempotencyKeys.delete(key);
  }

  public async acquireAdvisoryLock(key: string, traceId: string): Promise<void> {
    await this.db.pgAdvisoryXactLock(key, traceId);
  }

  public releaseAdvisoryLock(key: string): void {
    this.db.releaseAdvisoryLock(key);
  }

  public cleanExpired(now: Date): number {
    let count = 0;
    for (const [key, entry] of this.db.idempotencyKeys.entries()) {
      if (entry.expires_at < now) {
        this.db.idempotencyKeys.delete(key);
        count++;
      }
    }
    return count;
  }
}

export class CircuitBreakerRepository {
  constructor(private db: RelationalDatabase = dbInstance) {}

  public getByKey(gateway: GatewayName, method: PaymentMethod): CircuitBreakerConfig | null {
    const key = `${gateway}:${method}`;
    const cb = this.db.circuitBreakers.get(key);
    return cb ? cb : null; // Reference is fine as we modify it in memory
  }

  public save(config: CircuitBreakerConfig): void {
    const key = `${config.gateway}:${config.payment_method}`;
    this.db.circuitBreakers.set(key, config);
  }

  public getAll(): CircuitBreakerConfig[] {
    return Array.from(this.db.circuitBreakers.values());
  }
}

export class WebhookRepository {
  constructor(private db: RelationalDatabase = dbInstance) {}

  public getProcessedEvent(gateway: GatewayName, eventId: string): ProcessedWebhookEvent | null {
    const key = `${gateway}:${eventId}`;
    const ev = this.db.processedWebhookEvents.get(key);
    return ev ? { ...ev } : null;
  }

  public saveProcessedEvent(event: ProcessedWebhookEvent): void {
    const key = `${event.gateway}:${event.event_id}`;
    this.db.processedWebhookEvents.set(key, { ...event });
  }
}

export class ReconciliationRepository {
  constructor(private db: RelationalDatabase = dbInstance) {}

  public addLog(log: ReconciliationLog): void {
    this.db.reconciliationLogs.push({ ...log });
  }

  public getLogsByRunId(runId: string): ReconciliationLog[] {
    return this.db.reconciliationLogs.filter((l) => l.run_id === runId);
  }

  public getAllLogs(): ReconciliationLog[] {
    return [...this.db.reconciliationLogs];
  }
}

export class RefundRepository {
  constructor(private db: RelationalDatabase = dbInstance) {}

  public getById(id: string): Refund | null {
    const refund = this.db.refunds.get(id);
    return refund ? { ...refund } : null;
  }

  public getByTransactionId(transactionId: string): Refund[] {
    return Array.from(this.db.refunds.values())
      .filter((r) => r.transaction_id === transactionId)
      .map((r) => ({ ...r }));
  }

  public save(refund: Refund): void {
    this.db.refunds.set(refund.id, { ...refund });
  }
}

export class GatewayConfigRepository {
  constructor(private db: RelationalDatabase = dbInstance) {}

  public getAll(): GatewayConfig[] {
    return Array.from(this.db.gatewayConfigs.values()).map((g) => ({ ...g }));
  }

  public getByName(name: GatewayName): GatewayConfig | null {
    const config = this.db.gatewayConfigs.get(name);
    return config ? { ...config } : null;
  }

  public save(config: GatewayConfig): void {
    this.db.gatewayConfigs.set(config.gateway, { ...config });
  }

  public getRoutingConfig(): RoutingConfig {
    return { ...this.db.routingConfig };
  }

  public saveRoutingConfig(config: RoutingConfig): void {
    this.db.routingConfig = { ...config };
  }
}
