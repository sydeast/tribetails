import type { Request } from 'firebase-functions/v2/https';
import type { Response } from 'express';
import { logEvent } from '../lib/logger';

/**
 * Twilio webhook signature verification, shared by every Twilio-facing HTTP
 * function in this codebase.
 *
 * Lifted verbatim out of `twilioInbound.ts`, where it lived as two module-private
 * functions, so the voice handler can reuse the exact same rules rather than
 * grow a second, subtly different copy. `test/twilioInbound.test.ts`'s
 * `describe.each` guard battery still exercises this code through the three
 * original handlers, so the move is proved by tests that predate it.
 *
 * FAIL CLOSED is the whole point: with `TWILIO_AUTH_TOKEN` unset, nothing is
 * verifiable and every request is refused, so a forged POST cannot be accepted
 * in the window before an operator finishes wiring a webhook up.
 */

/**
 * Twilio signs the EXACT public URL it POSTs to. Behind Cloud Functions the
 * container sees a `Host` header that can differ from the `cloudfunctions.net`
 * name Twilio hashed, so the observed `req.hostname` is not reliable on its own.
 * Each webhook therefore takes a per-webhook env override naming its exact
 * public URL, and only derives the URL from the request when that is unset.
 */
function expectedUrl(req: Request, urlEnv: string): string {
  return (process.env[urlEnv] || '').trim() || `https://${req.hostname}${req.originalUrl}`;
}

/**
 * The same idea for a function that serves MANY paths under one name.
 *
 * A single-URL env var cannot describe a handler Twilio posts to at `/`,
 * `/route`, `/voicemail` and so on: pinning one path would 403 every other.
 * `baseEnv` therefore names the function's public root with NO trailing slash,
 * and the request's own path and query string are appended, which is exactly
 * what Twilio hashed.
 *
 * `req.originalUrl` is already the post-gateway path: a POST to
 * `https://us-central1-PROJECT.cloudfunctions.net/twilioVoice/route` arrives at
 * the container as `/route`, because the function name is consumed by the
 * cloudfunctions.net gateway and never reaches Express.
 */
function expectedUrlForBase(req: Request, baseEnv: string): string {
  const base = (process.env[baseEnv] || '').trim().replace(/\/+$/, '');
  if (!base) return `https://${req.hostname}${req.originalUrl}`;
  return `${base}${req.originalUrl}`;
}

async function validate(req: Request, url: string): Promise<boolean> {
  const token = process.env.TWILIO_AUTH_TOKEN;
  if (!token) return false; // fail closed: cannot verify without the auth token
  const sig = req.header('X-Twilio-Signature') ?? '';
  const params = (req.body ?? {}) as Record<string, string>;
  try {
    // Loaded here, not at file scope: a file-scope import of the Twilio SDK
    // charges its cold start to every other function in `index.js`. The
    // fail-closed token check above still runs before anything is loaded.
    const { default: twilio } = await import('twilio');
    return twilio.validateRequest(token, sig, url, params);
  } catch {
    return false;
  }
}

/** Verify against a single pinned public URL (`TWILIO_INBOUND_SMS_URL` and friends). */
export async function twilioVerify(req: Request, urlEnv: string): Promise<boolean> {
  return validate(req, expectedUrl(req, urlEnv));
}

/** Verify against a public ROOT plus this request's own path (multi-path handlers). */
export async function twilioVerifyWithBase(req: Request, baseEnv: string): Promise<boolean> {
  return validate(req, expectedUrlForBase(req, baseEnv));
}

/**
 * Shared guard: 405 on non-POST, 403 on bad/unverifiable signature. Returns the
 * parsed form body when the request is authentic, else null (response sent).
 */
export async function guard(
  req: Request,
  res: Response,
  fn: string,
  urlEnv: string,
): Promise<Record<string, string> | null> {
  if (req.method !== 'POST') {
    res.status(405).end();
    return null;
  }
  if (!(await twilioVerify(req, urlEnv))) {
    logEvent({ severity: 'warn', function: fn, event: `${fn}.verify.fail` });
    res.status(403).json({ error: 'bad-signature' });
    return null;
  }
  return (req.body ?? {}) as Record<string, string>;
}

/**
 * The multi-path guard.
 *
 * Refuses with TwiML rather than JSON, because this one answers a LIVE CALL: a
 * non-TwiML body makes Twilio play its own "an application error has occurred"
 * message, which tells the caller nothing and tells us nothing either. The 403
 * status is kept so the refusal is still visible in logs and metrics.
 */
export async function guardVoice(
  req: Request,
  res: Response,
  fn: string,
  baseEnv: string,
): Promise<Record<string, string> | null> {
  if (req.method !== 'POST') {
    res.status(405).end();
    return null;
  }
  if (!(await twilioVerifyWithBase(req, baseEnv))) {
    logEvent({
      severity: 'warn',
      function: fn,
      event: `${fn}.verify.fail`,
      extra: { path: req.path },
    });
    res.set('Content-Type', 'text/xml');
    res.status(403).send('<Response><Reject/></Response>');
    return null;
  }
  return (req.body ?? {}) as Record<string, string>;
}
