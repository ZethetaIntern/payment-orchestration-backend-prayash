# Deliberate Factual Errors Found in Project Material

As part of the senior architecture review, we have identified and analyzed the following embedded technical and factual errors in the training materials:

---

## 1. Razorpay Webhook Signature Verification Mistake
* **Reference**: Section A5.3, Page 13-14 Code Snippet
* **The Error**: The training material implements Razorpay webhook signature calculation by calling `crypto.createHmac('sha256', secret).update(JSON.stringify(body)).digest('hex')`.
* **The Correction & Explanation**: This is incorrect and will always fail signature validation in production. Razorpay webhooks do not verify the signature against the JSON-stringified request body directly. Instead, Razorpay requires verifying the signature by constructing a payload from the exact raw request string (`razorpay_payment_id` concatenated with a pipe `|` and `razorpay_order_id`) and verifying it against the signature headers. Furthermore, calling `JSON.stringify(body)` in Node.js does not guarantee property key order, which frequently causes signature failures if keys are sorted differently.

---

## 2. Division by Zero in Scoring Normalization Formulas
* **Reference**: Section A3.2, Page 9
* **The Error**: The formula for normalizing latency is defined as:
  `NormalizedLatency = (p95_latency - min_latency) / (max_latency - min_latency)`
  And similarly for cost:
  `NormalizedCost = (gateway_cost - min_cost) / (max_cost - min_cost)`
* **The Correction & Explanation**: This formula contains a severe mathematical vulnerability: **Division by Zero**. If all active gateways have the same latency or the same cost (for example, if only a single gateway is configured, or during initial boot before multiple performance logs exist), `max_latency` equals `min_latency` (and `max_cost` equals `min_cost`). In this situation, the denominator becomes zero, resulting in `NaN` or `Infinity`, which breaks the routing algorithm completely. The production-grade engine must guard this with a condition: if `max === min`, default the normalized coefficient gracefully to `0.5` or `1.0`.

---

## 3. Inaccurate Stripe Settlement Cycle Spec
* **Reference**: Section A1.3, Page 4 Gateway Behaviours Table
* **The Error**: The table claims that Stripe's settlement cycle is `T+2 calendar days`.
* **The Correction & Explanation**: Under RBI (Reserve Bank of India) guidelines, domestic settlement for payment aggregators and gateways operating within India **must** be conducted over **business days** (excluding bank holidays and weekends), making a calendar-day settlement impossible. Stripe's real-world settlement cycle in India is typically `T+3 business days` (and up to T+7 for new accounts or international transactions), not calendar days.

---

## 4. Inaccurate UPI Refund Support Spec
* **Reference**: Section A1.3, Page 4 Gateway Behaviours Table
* **The Error**: The table claims that UPI (NPCI) does not support partial refunds ("Partial Refund: Not supported").
* **The Correction & Explanation**: This is factually incorrect. UPI (Unified Payments Interface) specification via NPCI has fully supported partial refunds through UPI refund APIs since its early versions. A merchant can issue multiple partial refunds up to the original transaction value using the original UPI transaction reference number.

---

## 5. Synchronous Database Logging Inside Connection Timeout Handlers
* **Reference**: Section C5.2, Page 39 Case Study
* **The Error**: The case study notes that: "The error handler for connection timeouts logged the error and - critically - attempted to write the error to the database, requiring another connection that did not exist. This created a recursive failure loop."
* **The Correction & Explanation**: This is a classic architectural anti-pattern. Writing error logs synchronously to the primary database when the error itself is a database connection exhaustion error creates a recursive infinite loop that crashes the application server process entirely. Production systems must log asynchronously to standard output (`stdout`), files, or an independent in-memory/external buffer (like Redis/PgBouncer or log streams) to prevent cascading database starvation.
