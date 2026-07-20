import { onCall, CallableRequest } from 'firebase-functions/v2/https';
import { logEvent } from '../lib/logger';
import { initSentry } from '../lib/sentry';
import { TRIBETAILS_CORS } from '../lib/cors';

interface HealthResult {
  status: 'ok';
  ts: string;
  node: string;
}

export async function healthHandler(req: CallableRequest): Promise<HealthResult> {
  // Retry Sentry init here in case SENTRY_DSN was not yet in process.env at
  // module cold-start (e.g. secret not yet mounted). initSentry() is a no-op
  // once successfully initialized.
  initSentry();
  logEvent({
    severity: 'info',
    function: 'health',
    event: 'health.ping',
    uid: req.auth?.uid,
  });
  return {
    status: 'ok',
    ts: new Date().toISOString(),
    node: process.version,
  };
}

export const health = onCall(
  { region: 'us-central1', cors: TRIBETAILS_CORS, secrets: ['SENTRY_DSN'] },
  healthHandler,
);
