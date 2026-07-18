/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import { GatewayName, PaymentMethod } from '../types/payment';
import { logger } from '../services/logger';

export interface MockHeaders {
  responseType?: 'success' | 'timeout' | 'server-error' | 'decline' | 'rate-limit';
  delayMs?: number;
  gatewayDown?: boolean;
}

export interface GatewayResponse {
  success: boolean;
  gatewayReference?: string;
  errorCode?: string;
  errorMessage?: string;
  statusCode: number;
  rawResponse: any;
  delayMs: number;
}

export interface PaymentGateway {
  name: GatewayName;
  authorize(
    amountPaise: number,
    paymentMethod: PaymentMethod,
    traceId: string,
    mockHeaders?: MockHeaders
  ): Promise<GatewayResponse>;

  capture(
    gatewayReference: string,
    amountPaise: number,
    traceId: string,
    mockHeaders?: MockHeaders
  ): Promise<GatewayResponse>;

  void(
    gatewayReference: string,
    traceId: string,
    mockHeaders?: MockHeaders
  ): Promise<GatewayResponse>;

  refund(
    gatewayReference: string,
    amountPaise: number,
    traceId: string,
    mockHeaders?: MockHeaders
  ): Promise<GatewayResponse>;

  fetchStatus(
    gatewayReference: string,
    traceId: string,
    mockHeaders?: MockHeaders
  ): Promise<GatewayResponse>;
}

// Base helper class for simulating payment gateway responses and latencies
export abstract class BasePaymentGateway implements PaymentGateway {
  abstract readonly name: GatewayName;
  protected abstract readonly defaultDelay: number;

  /**
   * Simulates network latency and handles standard mock failure responses common to all gateways.
   * Returns a GatewayResponse if a mock scenario was triggered, or null if the flow should proceed to success simulation.
   */
  protected async handleMockScenarios(
    actionName: string,
    traceId: string,
    mockHeaders: MockHeaders = {}
  ): Promise<GatewayResponse | null> {
    const delay = mockHeaders.delayMs !== undefined ? mockHeaders.delayMs : this.defaultDelay;

    // Simulate Network Latency
    if (delay > 0) {
      await new Promise((resolve) => setTimeout(resolve, delay));
    }

    // 1. Simulate Gateway Down (X-Mock-Gateway-Down = true)
    if (mockHeaders.gatewayDown === true) {
      logger.warn(traceId, `gateway_${this.name}`, actionName, `Gateway completely down (X-Mock-Gateway-Down = true)`);
      return {
        success: false,
        statusCode: 504,
        errorCode: 'GATEWAY_DOWN',
        errorMessage: `The payment gateway ${this.name.toUpperCase()} is completely unreachable.`,
        rawResponse: { error: 'Network error, DNS failure or gateway timeout' },
        delayMs: delay
      };
    }

    const responseType = mockHeaders.responseType;
    if (!responseType || responseType === 'success') {
      return null; // Proceed to normal success simulation
    }

    // 2. Simulate Error Response Scenarios
    switch (responseType) {
      case 'timeout':
        logger.warn(traceId, `gateway_${this.name}`, actionName, `Simulating request timeout (30s)`);
        return {
          success: false,
          statusCode: 504,
          errorCode: 'GATEWAY_TIMEOUT',
          errorMessage: 'Request to payment gateway timed out.',
          rawResponse: { error: 'Gateway gateway-timeout' },
          delayMs: delay
        };

      case 'server-error':
        logger.error(traceId, `gateway_${this.name}`, actionName, `Simulating gateway 502 Bad Gateway`);
        return {
          success: false,
          statusCode: 502,
          errorCode: 'GATEWAY_INTERNAL_ERROR',
          errorMessage: 'Bad gateway or internal remote server error.',
          rawResponse: { error: '502 Bad Gateway' },
          delayMs: delay
        };

      case 'rate-limit':
        logger.warn(traceId, `gateway_${this.name}`, actionName, `Simulating 429 Too Many Requests rate-limiting`);
        return {
          success: false,
          statusCode: 429,
          errorCode: 'RATE_LIMIT_EXCEEDED',
          errorMessage: 'Outbound rate limit exceeded on payment gateway.',
          rawResponse: { error: '429 Too Many Requests', retry_after: 5 },
          delayMs: delay
        };

      case 'decline':
        logger.info(traceId, `gateway_${this.name}`, actionName, `Payment declined: Insufficient funds or fraud block`);
        return {
          success: false,
          statusCode: 400,
          errorCode: 'PAYMENT_DECLINED',
          errorMessage: 'The card issuer or banking network declined this transaction.',
          rawResponse: this.getDeclinePayload(),
          delayMs: delay
        };

      default:
        return null;
    }
  }

  // Hook for customized decline payload
  protected getDeclinePayload(): any {
    return { status: 'failed', decline_code: 'insufficient_funds', message: 'The transaction was declined.' };
  }

  // Generate gateway reference
  protected generateRefId(actionName: string): string {
    return `${this.name.substring(0, 3)}_${actionName.substring(0, 3)}_${Math.random().toString(36).substring(2, 10)}`;
  }

  public abstract authorize(
    amountPaise: number,
    paymentMethod: PaymentMethod,
    traceId: string,
    mockHeaders?: MockHeaders
  ): Promise<GatewayResponse>;

  public async capture(
    gatewayReference: string,
    amountPaise: number,
    traceId: string,
    mockHeaders?: MockHeaders
  ): Promise<GatewayResponse> {
    logger.info(traceId, `gateway_${this.name}`, 'capture_initiated', `Initiating capture for ref: ${gatewayReference}`);
    const mockResult = await this.handleMockScenarios('capture', traceId, mockHeaders);
    if (mockResult) return mockResult;

    const delay = mockHeaders?.delayMs !== undefined ? mockHeaders.delayMs : 150;
    return {
      success: true,
      gatewayReference,
      statusCode: 200,
      rawResponse: { status: 'captured', transaction_id: gatewayReference, amount: amountPaise, captured: true },
      delayMs: delay
    };
  }

  public async void(
    gatewayReference: string,
    traceId: string,
    mockHeaders?: MockHeaders
  ): Promise<GatewayResponse> {
    logger.info(traceId, `gateway_${this.name}`, 'void_initiated', `Initiating void for ref: ${gatewayReference}`);
    const mockResult = await this.handleMockScenarios('void', traceId, mockHeaders);
    if (mockResult) return mockResult;

    const delay = mockHeaders?.delayMs !== undefined ? mockHeaders.delayMs : 200;
    return {
      success: true,
      gatewayReference,
      statusCode: 200,
      rawResponse: { status: 'voided', transaction_id: gatewayReference, voided: true },
      delayMs: delay
    };
  }

  public async refund(
    gatewayReference: string,
    amountPaise: number,
    traceId: string,
    mockHeaders?: MockHeaders
  ): Promise<GatewayResponse> {
    logger.info(traceId, `gateway_${this.name}`, 'refund_initiated', `Initiating refund for ref: ${gatewayReference}`);
    const mockResult = await this.handleMockScenarios('refund', traceId, mockHeaders);
    if (mockResult) return mockResult;

    const delay = mockHeaders?.delayMs !== undefined ? mockHeaders.delayMs : 250;
    const refId = this.generateRefId('refund');
    return {
      success: true,
      gatewayReference: refId,
      statusCode: 200,
      rawResponse: { status: 'refunded', refund_id: refId, original_transaction_id: gatewayReference, amount: amountPaise },
      delayMs: delay
    };
  }

  public async fetchStatus(
    gatewayReference: string,
    traceId: string,
    mockHeaders?: MockHeaders
  ): Promise<GatewayResponse> {
    logger.info(traceId, `gateway_${this.name}`, 'fetch_status_initiated', `Fetching status for ref: ${gatewayReference}`);
    const mockResult = await this.handleMockScenarios('fetchStatus', traceId, mockHeaders);
    if (mockResult) return mockResult;

    const delay = mockHeaders?.delayMs !== undefined ? mockHeaders.delayMs : 120;
    return {
      success: true,
      gatewayReference,
      statusCode: 200,
      rawResponse: { status: 'captured', transaction_id: gatewayReference, verified: true },
      delayMs: delay
    };
  }
}

export class RazorpayAdapter extends BasePaymentGateway {
  readonly name = GatewayName.RAZORPAY;
  protected readonly defaultDelay = 450; // Taken from historical performance requirements

  public async authorize(
    amountPaise: number,
    paymentMethod: PaymentMethod,
    traceId: string,
    mockHeaders?: MockHeaders
  ): Promise<GatewayResponse> {
    logger.info(traceId, 'gateway_razorpay', 'authorize_initiated', `Razorpay initiating authorization for amount: ${amountPaise}`);
    const mockResult = await this.handleMockScenarios('authorize', traceId, mockHeaders);
    if (mockResult) return mockResult;

    const refId = this.generateRefId('auth');
    return {
      success: true,
      gatewayReference: refId,
      statusCode: 200,
      rawResponse: {
        entity: 'payment',
        id: refId,
        amount: amountPaise,
        currency: 'INR',
        status: 'authorized',
        method: paymentMethod.toLowerCase(),
        order_id: `rzp_order_${Math.random().toString(36).substring(2, 9)}`,
        captured: false
      },
      delayMs: mockHeaders?.delayMs !== undefined ? mockHeaders.delayMs : this.defaultDelay
    };
  }
}

export class StripeAdapter extends BasePaymentGateway {
  readonly name = GatewayName.STRIPE;
  protected readonly defaultDelay = 350;

  protected getDeclinePayload() {
    return {
      error: {
        type: 'card_error',
        code: 'card_declined',
        decline_code: 'insufficient_funds',
        message: 'Your card has insufficient funds.'
      }
    };
  }

  public async authorize(
    amountPaise: number,
    paymentMethod: PaymentMethod,
    traceId: string,
    mockHeaders?: MockHeaders
  ): Promise<GatewayResponse> {
    logger.info(traceId, 'gateway_stripe', 'payment_intent_create', `Stripe creating PaymentIntent for amount: ${amountPaise}`);
    const mockResult = await this.handleMockScenarios('authorize', traceId, mockHeaders);
    if (mockResult) return mockResult;

    const refId = this.generateRefId('intent');
    return {
      success: true,
      gatewayReference: refId,
      statusCode: 200,
      rawResponse: {
        id: refId,
        object: 'payment_intent',
        amount: amountPaise,
        currency: 'inr',
        status: 'requires_capture',
        payment_method_types: [paymentMethod.toLowerCase()],
        charges: {
          data: [{ id: `ch_${Math.random().toString(36).substring(2, 9)}`, paid: true }]
        }
      },
      delayMs: mockHeaders?.delayMs !== undefined ? mockHeaders.delayMs : this.defaultDelay
    };
  }
}

export class PayUAdapter extends BasePaymentGateway {
  readonly name = GatewayName.PAYU;
  protected readonly defaultDelay = 650;

  public async authorize(
    amountPaise: number,
    paymentMethod: PaymentMethod,
    traceId: string,
    mockHeaders?: MockHeaders
  ): Promise<GatewayResponse> {
    logger.info(traceId, 'gateway_payu', 'transaction_init', `PayU initiating transaction for amount: ${amountPaise}`);
    const mockResult = await this.handleMockScenarios('authorize', traceId, mockHeaders);
    if (mockResult) return mockResult;

    const refId = this.generateRefId('payu');
    return {
      success: true,
      gatewayReference: refId,
      statusCode: 200,
      rawResponse: {
        status: 'success',
        txnid: refId,
        amount: amountPaise.toString(),
        mode: paymentMethod.toLowerCase(),
        unmappedstatus: 'auth',
        field9: 'authorized_successfully'
      },
      delayMs: mockHeaders?.delayMs !== undefined ? mockHeaders.delayMs : this.defaultDelay
    };
  }
}

export class UPIAdapter extends BasePaymentGateway {
  readonly name = GatewayName.UPI;
  protected readonly defaultDelay = 210;

  public async authorize(
    amountPaise: number,
    paymentMethod: PaymentMethod,
    traceId: string,
    mockHeaders?: MockHeaders
  ): Promise<GatewayResponse> {
    logger.info(traceId, 'gateway_upi', 'upi_collect_mandate', `NPCI generating UPI collect mandate for: ${amountPaise} paise`);
    const mockResult = await this.handleMockScenarios('authorize', traceId, mockHeaders);
    if (mockResult) return mockResult;

    const refId = this.generateRefId('upi');
    return {
      success: true,
      gatewayReference: refId,
      statusCode: 200,
      rawResponse: {
        status: 'SUCCESS',
        txnRef: refId,
        responseCode: '00',
        approvalRefNo: `apv_${Math.random().toString(36).substring(2, 9)}`,
        upi_id: 'customer@okaxis'
      },
      delayMs: mockHeaders?.delayMs !== undefined ? mockHeaders.delayMs : this.defaultDelay
    };
  }
}

export const gatewaysMap: Record<GatewayName, PaymentGateway> = {
  [GatewayName.RAZORPAY]: new RazorpayAdapter(),
  [GatewayName.STRIPE]: new StripeAdapter(),
  [GatewayName.PAYU]: new PayUAdapter(),
  [GatewayName.UPI]: new UPIAdapter()
};

export class GatewayFactory {
  public static getAdapter(name: GatewayName): PaymentGateway {
    const adapter = gatewaysMap[name];
    if (!adapter) {
      throw new Error(`Unsupported payment gateway adapter: ${name}`);
    }
    return adapter;
  }
}
