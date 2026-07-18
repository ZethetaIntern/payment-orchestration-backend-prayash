/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import express from 'express';
import path from 'path';
import { createServer as createViteServer } from 'vite';
import { apiRouter } from './src/routes/api';
import { WebhookProcessor } from './src/services/webhooks';
import { InvalidStateTransitionException } from './src/services/stateMachine';
import { runTests } from './src/__tests__/payment.test';
import { logger } from './src/services/logger';

const app = express();
const PORT = 3000;

// Enable JSON body parsing
app.use(express.json());

// Mount central API router under /api
app.use('/api', apiRouter);

// Standard Express Global Error Handler (Translating database exceptions etc.)
app.use((err: any, req: express.Request, res: express.Response, next: express.NextFunction) => {
  const traceId = (req.header('X-Trace-ID') || 'system-trace-000000') as string;
  logger.error(traceId, 'api_server', 'unhandled_exception', `Unhandled exception: ${err.message}`, { metadata: { stack: err.stack } });

  if (err instanceof InvalidStateTransitionException) {
    res.status(409).json({
      error: {
        code: 'INVALID_STATE_TRANSITION',
        message: err.message,
        details: { fromState: err.fromState, toState: err.toState },
        request_id: traceId,
        timestamp: new Date().toISOString()
      }
    });
    return;
  }

  res.status(500).json({
    error: {
      code: 'INTERNAL_SERVER_ERROR',
      message: 'A system-level unhandled exception occurred in the payment orchestration gateway.',
      details: { error_message: err.message },
      request_id: traceId,
      timestamp: new Date().toISOString()
    }
  });
});

// =============================================================================
// VITE CLIENT & SERVER INITIALIZATION
// =============================================================================
async function startServer() {
  // Vite middleware setup for development/production serving
  if (process.env.NODE_ENV !== 'production') {
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: 'spa'
    });
    app.use(vite.middlewares);
  } else {
    const distPath = path.join(process.cwd(), 'dist');
    app.use(express.static(distPath));
    app.get('*', (req, res) => {
      res.sendFile(path.join(distPath, 'index.html'));
    });
  }

  app.listen(PORT, '0.0.0.0', () => {
    console.log('===================================================');
    console.log(` SERVER STARTED SUCCESSFULLY ON http://localhost:${PORT}`);
    console.log('===================================================');

    // Start background webhook retry worker queue (Section A8.3)
    WebhookProcessor.startRetryWorker();

    // Run unit test suite automatically on server startup
    runTests();
  });
}

startServer();

export default app;
