import * as Sentry from '@sentry/node';

let initialized = false;
let warned = false;

/**
 * Initialise Sentry exactly once.
 *
 * DSN resolution order (both must ultimately land in process.env.SENTRY_DSN):
 *   • Local emulator , set in functions/.env  (gitignored; emulator reads it automatically)
 *   • Production     , set via:  firebase functions:secrets:set SENTRY_DSN
 *                       then redeploy: firebase deploy --only functions
 *
 * NOTE: initialized is only set to true when a DSN is available so that the
 * first handler invocation can retry if the secret was not yet in process.env
 * at module cold-start.
 */
export function initSentry(): void {
  if (initialized) return;
  const dsn = process.env.SENTRY_DSN;
  if (!dsn) {
    if (!warned) {
      console.warn('[sentry] SENTRY_DSN unset; Sentry disabled. Errors will not be reported.');
      warned = true;
    }
    return; // do NOT set initialized=true, allow a later handler invocation to retry
  }
  initialized = true;
  Sentry.init({
    dsn,
    environment: process.env.SENTRY_ENVIRONMENT ?? 'unknown',
    tracesSampleRate: Number(process.env.SENTRY_TRACES_SAMPLE_RATE ?? '0.1'),
    release: process.env.SENTRY_RELEASE,
  });
}

/**
 * Whether `initSentry` actually took a DSN and initialised the client.
 *
 * The one honest liveness check this integration has, and it costs nothing: no
 * event is sent, no network is touched. It reads the flag `initSentry` sets,
 * which is only ever true after a real `Sentry.init`, so it separates "the DSN
 * is set" (a `process.env` fact) from "error reporting is actually on" (this
 * one). They come apart on a cold start where the secret had not mounted yet,
 * which is precisely the case an operator would otherwise never see.
 */
export function isSentryInitialized(): boolean {
  return initialized;
}

export function captureFunctionError(
  err: unknown,
  context: Record<string, unknown> = {},
): string {
  return Sentry.captureException(err, { extra: context });
}

export function captureCritical(message: string, context: Record<string, unknown> = {}): string {
  return Sentry.captureMessage(message, { level: 'fatal', extra: context });
}