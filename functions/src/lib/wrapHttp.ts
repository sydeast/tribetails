import type { Request } from 'firebase-functions/v2/https';
import type { Response } from 'express';
import { captureFunctionError, initSentry } from './sentry';
import { logEvent } from './logger';
import { randomUUID } from 'node:crypto';

export type HttpHandler = (req: Request, res: Response) => Promise<void> | void;

/**
 * Wraps an `onRequest` HTTPS handler so unhandled faults route to Sentry and
 * a 500 is returned instead of leaking a stack trace to the caller.
 *
 * NOTE: The wrapped handler is responsible for sending its own response on
 * the success path. This wrapper only writes to `res` if the handler throws
 * AND the response has not yet been sent.
 */
export function wrapHttp(name: string, handler: HttpHandler): HttpHandler {
  return async (req: Request, res: Response): Promise<void> => {
    initSentry();
    const start = Date.now();
    const requestId = randomUUID();
    try {
      await handler(req, res);
      logEvent({
        severity: 'info',
        function: name,
        event: `${name}.success`,
        requestId,
        durationMs: Date.now() - start,
        extra: { method: req.method, path: req.path },
      });
    } catch (err) {
      const sentryId = captureFunctionError(err, {
        function: name,
        requestId,
        kind: 'http',
        method: req.method,
        path: req.path,
      });
      logEvent({
        severity: 'error',
        function: name,
        event: `${name}.failure`,
        requestId,
        errorMessage: (err as Error)?.message,
        durationMs: Date.now() - start,
        extra: { sentryId, method: req.method, path: req.path },
      });
      if (!res.headersSent) {
        res.status(500).json({ error: 'internal', sentryId });
      }
    }
  };
}
