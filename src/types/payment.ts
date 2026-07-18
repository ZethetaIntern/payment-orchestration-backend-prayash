/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

export enum TransactionState {
  CREATED = 'CREATED',
  ROUTE_SELECTED = 'ROUTE_SELECTED',
  AUTH_INITIATED = 'AUTH_INITIATED',
  AUTHORISED = 'AUTHORISED',
  AUTH_FAILED = 'AUTH_FAILED',
  AUTH_EXPIRED = 'AUTH_EXPIRED',
  CAPTURE_INITIATED = 'CAPTURE_INITIATED',
  CAPTURED = 'CAPTURED',
  PARTIALLY_CAPTURED = 'PARTIALLY_CAPTURED',
  CAPTURE_FAILED = 'CAPTURE_FAILED',
  REFUND_INITIATED = 'REFUND_INITIATED',
  PARTIALLY_REFUNDED = 'PARTIALLY_REFUNDED',
  REFUNDED = 'REFUNDED',
  REFUND_FAILED = 'REFUND_FAILED',
  VOID_INITIATED = 'VOID_INITIATED',
  VOIDED = 'VOIDED',
  SETTLED = 'SETTLED',
  FAILED = 'FAILED',
  DISPUTE_OPENED = 'DISPUTE_OPENED',
  DISPUTE_RESOLVED = 'DISPUTE_RESOLVED'
}

export enum PaymentMethod {
  CARD = 'CARD',
  UPI = 'UPI',
  NET_BANKING = 'NET_BANKING',
  WALLET = 'WALLET'
}

export enum GatewayName {
  RAZORPAY = 'razorpay',
  STRIPE = 'stripe',
  PAYU = 'payu',
  UPI = 'upi'
}

export enum CircuitBreakerState {
  CLOSED = 'CLOSED',
  OPEN = 'OPEN',
  HALF_OPEN = 'HALF_OPEN'
}

export interface Transaction {
  id: string; // UUID
  merchant_id: string;
  merchant_order_id: string;
  amount_paise: bigint | number; // Stored in paise (BIGINT)
  currency: string;
  payment_method: PaymentMethod;
  state: TransactionState;
  gateway_reference?: string;
  selected_gateway?: GatewayName;
  trace_id: string;
  created_at: Date;
  updated_at: Date;
  expires_at?: Date;
}

export interface TransactionStateLog {
  id: string;
  transaction_id: string;
  from_state: TransactionState | null;
  to_state: TransactionState;
  event: string;
  gateway_reference?: string;
  gateway_response?: string; // JSON string
  metadata?: string; // JSON string
  created_at: Date;
  created_by: string;
}

export interface GatewayRoute {
  id: string;
  transaction_id: string;
  gateway: GatewayName;
  score: number;
  routing_weights: string; // JSON string of weights used
  created_at: Date;
}

export interface IdempotencyKey {
  key: string; // Composite key: merchant_id:idempotency_key
  request_hash: string; // SHA-256
  status: 'PROCESSING' | 'COMPLETED' | 'FAILED';
  response_code?: number;
  response_body?: string; // JSON string
  created_at: Date;
  updated_at: Date;
  expires_at: Date;
}

export interface ProcessedWebhookEvent {
  gateway: GatewayName;
  event_id: string;
  event_type: string;
  payload_hash: string;
  transaction_id?: string;
  processed_at: Date;
}

export interface GatewayHealthMetric {
  id: string;
  gateway: GatewayName;
  payment_method: PaymentMethod;
  recorded_at: Date;
  success_rate: number; // 0.0 to 1.0
  p95_latency_ms: number;
  total_transactions: number;
  status: 'healthy' | 'degraded' | 'down';
}

export interface CircuitBreakerConfig {
  gateway: GatewayName;
  payment_method: PaymentMethod;
  state: CircuitBreakerState;
  failure_count: number;
  last_state_change: Date;
  failure_threshold: number; // e.g. 5
  timeout_seconds: number; // e.g. 30
}

export interface ReconciliationLog {
  id: string;
  run_id: string;
  transaction_id: string;
  discrepancy_type: 'MISSING_SETTLEMENT' | 'STATUS_MISMATCH' | 'AMOUNT_MISMATCH' | 'CURRENCY_MISMATCH';
  gateway_status: string;
  internal_status: TransactionState;
  resolution_action: string;
  created_at: Date;
}

export interface Refund {
  id: string;
  transaction_id: string;
  gateway_refund_id?: string;
  amount_paise: bigint | number;
  state: 'PENDING' | 'COMPLETED' | 'FAILED';
  reason?: string;
  created_at: Date;
  updated_at: Date;
}

export interface GatewayConfig {
  gateway: GatewayName;
  is_active: boolean;
  base_percentage_fee: number; // e.g. 2.0% as 0.02
  fixed_fee_paise: number; // e.g. 2 rupees as 200
  rate_limit_per_second: number;
}

export interface RoutingConfig {
  config_key: string;
  weight_success_rate: number; // default 0.35
  weight_latency: number; // default 0.20
  weight_cost: number; // default 0.20
  weight_health: number; // default 0.15
  weight_fit: number; // default 0.10
}
