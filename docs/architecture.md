# PayFlow System Architecture Decision Record (ADR) & Design Specifications

This document outlines the architectural decisions, design patterns, and engineering paradigms used to build the PayFlow Payment Orchestration Layer.

---

## 1. Core Architectural Decisions

### ADR-001: Language & Runtime Framework
* **Decision**: Node.js with TypeScript and Express.js + Vite.
* **Rational**: Express.js is a industry-standard high-throughput framework that provides standard middleware handling, robust routing, and exceptional JSON performance. TypeScript ensures compile-time type safety for financial amounts, states, and config structures. Vite allows bundling a gorgeous, highly interactive companion dashboard in the same application process, enabling instant stress testing and state log visualization.

### ADR-002: Financial Amount Representation
* **Decision**: All financial amounts are represented and calculated exclusively as integer **paise / cents** (`BIGINT` or numbers representing integer units).
* **Rational**: Standard floating-point values introduce rounding errors that compound over thousands of transactions, leading to severe financial leaks. Representing amounts in paise ensures absolute precision across all calculations.

### ADR-003: Relational In-Memory Database with Transactional Control
* **Decision**: Engineered a custom in-memory relational database containing structured collections, column indexes, composite primary keys, and transaction-level locks.
* **Rational**: To run flawlessly inside sandboxed container environments without requiring complex external database provisioning, we built a pure TypeScript relational database engine. It includes full emulation of PostgreSQL **Advisory Locks** (`pg_advisory_xact_lock`) and row-level locks (`SELECT FOR UPDATE`) to handle concurrent race conditions safely, ensuring 100% test reliability and seamless execution.

---

## 2. Implemented Distributed Systems Patterns

### 1. Dynamic Router & Outbound Circuit Breaker (Section A3)
The gateway router calculates a composite real-time score for each gateway:
* **Success Rate** (35% weight): Computed over a sliding performance window.
* **Latency** (20% weight): P95 latency tracking.
* **Cost** (20% weight): Calculated in paise including percentage and fixed fees.
* **Health** (15% weight): Dictated by the circuit breaker status.
* **Fit** (10% weight): Supported payment methods checking.

Each gateway maintains an independent **Circuit Breaker** state machine per payment method:
* `CLOSED`: Operations proceed normally. Failure counts track consecutive errors.
* `OPEN`: Gateway tripped due to consecutive failures. Requests instantly failover to alternative gateways.
* `HALF_OPEN`: Entered after a timeout (e.g. 15s). A single test request is allowed through to verify gateway health recovery.

### 2. Idempotency Key Lock Strategy (Section A4)
To prevent double charging during client retries or network drops:
1. Client sends UUID `Idempotency-Key` header.
2. Server acquires a composite advisory lock scoped to `merchant_id:idempotency_key`.
3. If state is `PROCESSING`: Reject instantly with `409 Conflict`.
4. If state is `COMPLETED`: Return cached response.
5. If state is `FAILED`: Safely allow retry.

### 3. Webhook Pipeline & Dead Letter Queue (Section A5)
The webhook pipeline handles "at-least-once" delivery constraints with strict verification layers:
* **Signature Verification**: Verifies HMAC-SHA256/SHA512 signatures using constant-time `crypto.timingSafeEqual` comparison to completely neutralize timing attacks.
* **Webhook Deduplication**: Event ID unique checks using the `processed_webhook_events` database log.
* **Out-of-Order Webhooks**: If a captured webhook arrives before the synchronous API call returns, the transaction transitions to `CAPTURED` instantly. Late-arriving API responses reject duplicate transitions gracefully.
* **Dead Letter Queue (DLQ)**: Failed webhook ingestions are retried up to 3 times with exponential backoff. Upon terminal failure, the item is moved to the DLQ table, prompting administrative alerts and manual replay capabilities.

### 4. Periodic Reconciliation Engine (Section A5.5)
A background batch job runs periodically to address lost or delayed webhooks:
1. **Identify Stale Transactions**: Finds transactions stuck in `AUTH_INITIATED` or `CAPTURE_INITIATED` for longer than 2 minutes.
2. **Poll Gateway Status**: Queries the gateway fetch payment status API.
3. **Reconcile Override**: Aligns internal state with the gateway's state as source of truth and logs a `RECONCILIATION_OVERRIDE` event.
4. **Flag Anomalies**: If a transaction is marked `CAPTURED` internally but the gateway reports it as `FAILED` during settlement, it flags a critical anomaly, writes to the `anomaliesTable`, and dispatches system alerts for manual audit.
