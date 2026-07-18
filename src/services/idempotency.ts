/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import { IdempotencyRepository } from '../db/repositories';
import { IdempotencyKey } from '../types/payment';
import { logger } from './logger';

export class IdempotencyConflictError extends Error {
  constructor(public key: string, public status: 'PROCESSING' | 'COMPLETED') {
    super(`Idempotency conflict: key ${key} is already in state ${status}`);
    this.name = 'IdempotencyConflictError';
  }
}

export class IdempotencyPayloadMismatchError extends Error {
  constructor(public key: string) {
    super(`Idempotency payload mismatch: Key '${key}' was previously used with a different request payload.`);
    this.name = 'IdempotencyPayloadMismatchError';
  }
}

export class IdempotencyService {
  /**
   * Attempts to acquire an idempotency lock for a request.
   * If already processing, throws Conflict error.
   * If completed, returns the cached response (after validating payload hash!).
   * If failed or new, acquires the lock and returns null.
   */
  public static async acquire(
    merchantId: string,
    idempotencyKey: string,
    requestHash: string,
    traceId: string,
    idempRepo: IdempotencyRepository = new IdempotencyRepository()
  ): Promise<IdempotencyKey | null> {
    const compositeKey = `${merchantId}:${idempotencyKey}`;

    // Acquire PostgreSQL transaction-scoped advisory lock emulation
    await idempRepo.acquireAdvisoryLock(compositeKey, traceId);

    const existing = idempRepo.getByKey(compositeKey);

    if (existing) {
      // 1. Verify payload hash match (Section A4.1 payload validation)
      if (existing.request_hash !== requestHash) {
        idempRepo.releaseAdvisoryLock(compositeKey);
        logger.error(
          traceId,
          'idempotency_service',
          'payload_mismatch',
          `Payload hash mismatch for idempotency key ${idempotencyKey}. Existing: ${existing.request_hash}, Incoming: ${requestHash}`
        );
        throw new IdempotencyPayloadMismatchError(idempotencyKey);
      }

      if (existing.status === 'PROCESSING') {
        idempRepo.releaseAdvisoryLock(compositeKey);
        logger.warn(traceId, 'idempotency_service', 'acquire_conflict', `Concurrent request in progress for key ${idempotencyKey}`);
        throw new IdempotencyConflictError(idempotencyKey, 'PROCESSING');
      }

      if (existing.status === 'COMPLETED') {
        idempRepo.releaseAdvisoryLock(compositeKey);
        logger.info(traceId, 'idempotency_service', 'cache_hit', `Returning cached response for idempotency key ${idempotencyKey}`);
        return existing; // Return cached response
      }

      // If FAILED, we allow retry. We will move its status back to PROCESSING.
      logger.info(traceId, 'idempotency_service', 'retry_allowed', `Allowing retry for failed idempotency key ${idempotencyKey}`);
    }

    // Safe lock-acquired entry
    const newEntry: IdempotencyKey = {
      key: compositeKey,
      request_hash: requestHash,
      status: 'PROCESSING',
      created_at: new Date(),
      updated_at: new Date(),
      expires_at: new Date(Date.now() + 24 * 60 * 60 * 1000) // 24 hours expiry
    };

    idempRepo.save(newEntry);
    idempRepo.releaseAdvisoryLock(compositeKey);
    return null;
  }

  /**
   * Caches the completed response for an idempotency key.
   */
  public static async complete(
    merchantId: string,
    idempotencyKey: string,
    responseCode: number,
    responseBody: any,
    traceId: string,
    idempRepo: IdempotencyRepository = new IdempotencyRepository()
  ): Promise<void> {
    const compositeKey = `${merchantId}:${idempotencyKey}`;

    const existing = idempRepo.getByKey(compositeKey);
    if (existing) {
      existing.status = 'COMPLETED';
      existing.response_code = responseCode;
      existing.response_body = JSON.stringify(responseBody);
      existing.updated_at = new Date();
      idempRepo.save(existing);
      logger.info(traceId, 'idempotency_service', 'cached_success', `Cached successful response for idempotency key ${idempotencyKey}`);
    }
  }

  /**
   * Marks the idempotency key as failed so it can be safely retried later.
   */
  public static async fail(
    merchantId: string,
    idempotencyKey: string,
    traceId: string,
    idempRepo: IdempotencyRepository = new IdempotencyRepository()
  ): Promise<void> {
    const compositeKey = `${merchantId}:${idempotencyKey}`;

    const existing = idempRepo.getByKey(compositeKey);
    if (existing) {
      existing.status = 'FAILED';
      existing.updated_at = new Date();
      idempRepo.save(existing);
      logger.warn(traceId, 'idempotency_service', 'mark_failed', `Marked idempotency key ${idempotencyKey} as FAILED to allow retries`);
    }
  }

  /**
   * Background cleaner job (FS-12 / A4.2)
   */
  public static cleanExpiredKeys(idempRepo: IdempotencyRepository = new IdempotencyRepository()) {
    const now = new Date();
    const count = idempRepo.cleanExpired(now);

    if (count > 0) {
      logger.info('system-trace-000000', 'idempotency_cleaner', 'cleanup_completed', `Cleaned up ${count} expired idempotency keys`);
    }
  }
}
