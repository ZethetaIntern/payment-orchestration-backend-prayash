# PayFlow Payment Orchestration & Failover Engine

PayFlow is a production-grade, highly resilient **Payment Orchestration Layer** designed for high-throughput enterprise platforms. It intelligently routes transactions across multiple gateways (Razorpay, Stripe, PayU, and UPI), manages outages with rapid &lt;2s failover handlers, blocks double-charges with distributed advisory locks, and maintains 100% financial audit compliance with immutable state logs.

---

## 🚀 Key Architectural Highlights

* **Multi-Criteria Intelligent Router (A3)**: Dynamically scores and routes transactions based on dynamic success rates (35%), latencies (20%), pricing cost in paise (20%), gateway circuit health (15%), and payment method compatibility (10%).
* **Per-Gateway Outbound Circuit Breaker (A3.3)**: Real-time per-method health tracking featuring standard `CLOSED`, `OPEN`, and `HALF_OPEN` states. Outages trip the breaker instantly, shielding transactions from degrading networks.
* **Double-Charge Mitigation (A4)**: Fully transactional idempotency layer utilizing inter-tenant composite keys `merchant_id:idempotency_key` and relational advisory locks.
* **Robust Webhook Pipeline with DLQ (A5)**: timing-safe webhook signature verification (`crypto.timingSafeEqual`), duplicate-event filters, and a resilient Dead Letter Queue (DLQ) with backoff retries.
* **Automated Batch Reconciliation (A5.5)**: Periodic polling of stale transactions, automatic state override logs using gateway status as the source of truth, and critical anomaly alarms to notify developers of missing settlement balances.
* **Aesthetic Companion Playground Dashboard**: Beautiful single-page console built in React + Tailwind CSS that lets you trigger simulated stress tests (such as Gateway Timeout, Webhook Replays, Concurrency Race, Partial Captures, and State Corruptions) and inspect the live database updates, circuit breakers, and trace logs in real-time.

---

## 📊 System Architecture Block Diagram

```mermaid
flowchart TD
    Client[D2C Client Checkout] -->|1. Dispatches Payment| GatewayAPI[PayFlow Express API Gate]
    
    subgraph Core Orchestration Middleware
        GatewayAPI -->|2. Scopes Key| Idemp[Idempotency Key & Advisory Lock Engine]
        Idemp -->|3. Fetches Health| Router[Dynamic Router & Scoring Engine]
        Router -->|4. Checks Outages| CB[Outbound Circuit Breakers CLOSED/OPEN/HALF_OPEN]
        Router -->|5. Token/Leaky Buckets| RateLimiter[Outbound Rate Limit Handlers]
    end
    
    subgraph Relational Database State (ACID)
        Idemp <--->|SELECT FOR UPDATE| DB[(Relational In-Memory Store)]
        StateMachine <--->|Atomic States| DB
    end

    CB -->|6. Unified Adapters| Adapters[Gateway Adapters Razorpay/Stripe/PayU/UPI]
    Adapters -->|7. Calls Gateway API| ExternalGateways{{External Gateway Processors}}
    
    ExternalGateways -->|8. Push Webhook| WebhookReceiver[Webhook Ingestion Receiver]
    
    subgraph Webhook Pipeline & DLQ
        WebhookReceiver -->|9. Constant-Time Signatures| SigVerify[timingSafeEqual HMAC Matcher]
        SigVerify -->|10. Check processed_events| Deduplicator[Event Deduplication Layer]
        Deduplicator -->|11. In-flight support| StateMachine[State Machine Validator]
        Deduplicator -->|Failure backoff| DLQ[Dead Letter Queue Queue Table]
    end
    
    subgraph Batch Tasks
        Reconciler[Reconciliation Engine] -->|12. Poll Stale Status| Adapters
        Reconciler -->|13. Log Override| StateMachine
        Reconciler -->|14. Flag Anomalies| Alerts[Critical Settlement Anomalies Alert]
    end
```

---

## 🛠️ Tech Stack & Directory Structure

* **Frameworks**: Node.js (v20+), Express.js (v4.21), Vite, React 19, Tailwind CSS.
* **Libraries**: Esbuild (Bundler), TSX (TypeScript Executable), Recharts (Analytical Charts), Lucide-React (Icons).

```
/
├── docs/                           # High-level architecture and API specifications
│   ├── api-specification.yaml      # Complete Swagger OpenAPI 3.0 schema mapping
│   ├── state-machine.md            # Deterministic state hierarchy and Mermaid flows
│   ├── architecture.md             # Architectural Decision Record (ADR-001/002)
│   └── errors-found.md             # Factual correction log of deliberated training errors
├── src/
│   ├── __tests__/                  # Unified assert test suite running on server startup
│   │   └── payment.test.ts
│   ├── components/                 # Extracted UI component files
│   ├── db/
│   │   └── database.ts             # Relational Database in-memory store with pg advisory emulation
│   ├── gateways/
│   │   └── adapters.ts             # Uniform PaymentGateway interface and Razorpay/Stripe adapters
│   ├── services/
│   │   ├── stateMachine.ts         # Transition validator and transition logs controller
│   │   ├── router.ts               # Dynamic router weights scorer and rate limiters
│   │   ├── idempotency.ts          # Idempotency Composite Key lock tracker
│   │   ├── webhooks.ts             # HMAC-verifier, out-of-order handler, and DLQ
│   │   ├── reconciliation.ts       # Stale transaction poller and anomaly logger
│   │   └── logger.ts               # JSON format structured tracing logging
│   ├── App.tsx                     # Breathtaking interactive playground dashboard
│   ├── index.css
│   └── main.tsx
├── server.ts                       # Express server exposing all 20+ required endpoints
├── package.json
└── vite.config.ts
```

---

## 🚀 Setup & Execution Instructions

Follow these instructions to spin up the entire application locally:

### 1. Pre-requisites
Ensure you have **Node.js (version 20 or higher)** and npm installed on your system.

### 2. Install dependencies
Run the following command in the root folder of your project to install all base dependencies:
```bash
npm install
```

### 3. Start the application in development mode
Run the development command. This will spin up the Full-Stack Express server on port `3000` with the Vite frontend middleware active:
```bash
npm run dev
```

### 4. Open the interactive playground
Open your browser and navigate to:
```
http://localhost:3000
```
Here you can explore the gorgeous analytical metrics, trigger the 15 failure scenarios, watch the live circuit breaker states adapt, adjust routing coefficients dynamically, and view chronologically ordered audit logs and trace IDs!

### 5. Running the build pipeline
To compile the project to production-ready static assets and bundle the Express server into a standalone CommonJS file:
```bash
npm run build
```
This produces the bundled server inside `dist/server.cjs` and static files in `dist/`.

### 6. Starting in production mode
Run the start command to launch the self-contained production bundle:
```bash
npm run start
```

---

## 🔍 REST API Mapping

The engine exposes 23 highly compliant REST API endpoints (Section A7.1):

| # | Method | Endpoint | Description |
|---|:---|:---|:---|
| 1 | `POST` | `/api/v1/payments` | Initiate a new payment (Handles routing and failovers) |
| 2 | `GET` | `/api/v1/payments/{id}` | Retrieve payment details by ID |
| 3 | `GET` | `/api/v1/payments?merchant_order_id={id}` | Retrieve payment by merchant order ID |
| 4 | `POST` | `/api/v1/payments/{id}/capture` | Capture an authorised payment (Supports partials) |
| 5 | `POST` | `/api/v1/payments/{id}/void` | Void an authorised hold |
| 6 | `POST` | `/api/v1/payments/{id}/refund` | Initiate a refund |
| 7 | `GET` | `/api/v1/payments/{id}/refunds` | List refunds for a payment |
| 8 | `GET` | `/api/v1/payments/{id}/timeline` | Get state transition history logs (Audit trail) |
| 9 | `POST` | `/api/v1/webhooks/razorpay` | Razorpay webhook receiver |
| 10 | `POST` | `/api/v1/webhooks/stripe` | Stripe webhook receiver |
| 11 | `POST` | `/api/v1/webhooks/payu` | PayU webhook receiver |
| 12 | `POST` | `/api/v1/webhooks/upi` | UPI callback receiver |
| 13 | `GET` | `/api/v1/gateways` | List all configured gateways |
| 14 | `GET` | `/api/v1/gateways/{name}/health` | Get gateway health & active circuit breakers |
| 15 | `GET` | `/api/v1/gateways/{name}/metrics` | Get gateway performance metrics |
| 16 | `POST` | `/api/v1/gateways/{name}/config` | Update gateway parameters |
| 17 | `GET` | `/api/v1/routing/config` | Get current routing weights |
| 18 | `POST` | `/api/v1/routing/config` | Update routing weights coefficients |
| 19 | `POST` | `/api/v1/reconciliation/trigger` | Manually trigger periodic reconciliation run |
| 20 | `GET` | `/api/v1/reconciliation/reports/{run_id}` | Get reconciliation logs and unresolved anomalies |
| 21 | `GET` | `/api/v1/analytics/success-rate` | Success rate analytical percentages |
| 22 | `GET` | `/api/v1/analytics/volume` | Transaction count and total volumes per gateway |
| 23 | `GET` | `/api/v1/health` | Service health status check |
