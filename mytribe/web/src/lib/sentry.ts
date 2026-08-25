import * as Sentry from '@sentry/react';

/**
 * Crash/error reporting for the Kinfolk portal (React) at kinfolk.tribetails.com.
 * Mirrors the Kotlin/android side's Sentry setup (KinfolkPortalApplication.kt):
 * same shared Sentry org, same `reportError` intent for caught exceptions.
 *
 * Fail-loud-but-degrade-gracefully (project convention): with no DSN this does
 * nothing except log one visible line, so a missing secret never silently
 * disables reporting AND never blocks app boot. The DSN is the one external
 * secret the operator must supply (VITE_SENTRY_DSN) to activate it.
 *
 * WHERE THE DSN COMES FROM: Google Secret Manager, as PORTAL_WEB_SENTRY_DSN,
 * declared in scripts/client-secrets.mjs and fetched by release step 0c before
 * the build. A release refuses without it, because this file's graceful
 * degradation is exactly what let the admin ship with reporting off for weeks.
 * A local .env is the fallback for a machine with no gcloud.
 *
 * VITE_ prefix is mandatory: only VITE_-prefixed vars reach the browser bundle.
 */

/**
 * Initialize Sentry for this browser session. Call once, before the app
 * renders. No-op (with a visible console line) when VITE_SENTRY_DSN is absent.
 * Never throws: a reporting failure must not take down the portal.
 */
export function initSentry(): void {
  const dsn = (import.meta.env.VITE_SENTRY_DSN ?? '').trim();
  if (!dsn) {
    // Visible, not silent: this is the fail-loud signal that reporting is off.
    console.info('Sentry disabled: no VITE_SENTRY_DSN');
    return;
  }

  try {
    const release = (import.meta.env.VITE_SENTRY_RELEASE ?? '').trim();
    Sentry.init({
      dsn,
      environment: import.meta.env.MODE,
      tracesSampleRate: 0.1,
      // Kinfolk PII lives here (names, Kin, invoices, contacts). Do NOT let
      // Sentry attach request bodies / IPs / user context by default.
      sendDefaultPii: false,
      // Only set release when a build-time var is present; omit otherwise so we
      // never send an empty string (exactOptionalPropertyTypes is on).
      ...(release ? { release } : {}),
    });
  } catch (err) {
    // Fail loud, but keep the portal alive if Sentry itself misbehaves.
    console.error('Sentry init failed; continuing without crash reporting.', err);
  }
}

/**
 * Report a caught throwable, with an optional context label for triage.
 * Mirrors the wasm/android `reportError(throwable, context)`. Safe no-op when
 * Sentry was never initialized (captureException without init does nothing),
 * and never throws.
 */
export function reportError(error: unknown, context?: string): void {
  try {
    Sentry.captureException(error, context ? { tags: { context } } : undefined);
  } catch {
    // A reporter must never become the thing that crashes the caller.
  }
}
