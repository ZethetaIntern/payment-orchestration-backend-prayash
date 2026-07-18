/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

export interface StructuredLog {
  timestamp: string;
  level: 'INFO' | 'WARN' | 'ERROR' | 'DEBUG';
  trace_id: string;
  transaction_id?: string;
  component: string;
  action: string;
  gateway?: string;
  score?: number;
  duration_ms?: number;
  message: string;
  metadata?: Record<string, any>;
}

// In-memory log buffer for visual display on dashboard
export const logBuffer: StructuredLog[] = [];
const MAX_BUFFER_SIZE = 500;

export function writeLog(
  level: 'INFO' | 'WARN' | 'ERROR' | 'DEBUG',
  traceId: string,
  component: string,
  action: string,
  message: string,
  params?: {
    transaction_id?: string;
    gateway?: string;
    score?: number;
    duration_ms?: number;
    metadata?: Record<string, any>;
  }
) {
  const log: StructuredLog = {
    timestamp: new Date().toISOString(),
    level,
    trace_id: traceId || 'system-trace-000000',
    component,
    action,
    message,
    ...params
  };

  // Log to standard console
  console.log(JSON.stringify(log));

  // Prepend to our in-memory buffer for visual terminal rendering on the dashboard
  logBuffer.unshift(log);
  if (logBuffer.length > MAX_BUFFER_SIZE) {
    logBuffer.pop();
  }
}

export const logger = {
  info: (traceId: string, component: string, action: string, message: string, params?: any) =>
    writeLog('INFO', traceId, component, action, message, params),
  warn: (traceId: string, component: string, action: string, message: string, params?: any) =>
    writeLog('WARN', traceId, component, action, message, params),
  error: (traceId: string, component: string, action: string, message: string, params?: any) =>
    writeLog('ERROR', traceId, component, action, message, params),
  debug: (traceId: string, component: string, action: string, message: string, params?: any) =>
    writeLog('DEBUG', traceId, component, action, message, params)
};
