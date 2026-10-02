import type { ErrorEvent } from '@sentry/react';
/**
 * Drops Sentry events that come from Google's reCAPTCHA script and nothing of
 * ours (#1140). One visitor produced 81 events in 6 seconds from
 * `recaptcha__en.js` ("Cannot read properties of undefined (reading 'h6')"),
 * escalating the issue and burying real errors. We load that script through
 * Firebase App Check and the Auth SDK; we cannot fix its internals, and nothing
 * on our side retries it (App Check is activated once, see lib/boot.ts).
 *
 * The rule is deliberately narrow: an event is dropped only when EVERY frame
 * that names a file is a reCAPTCHA frame, or when it is the legacy
 * `[web] ... recaptcha` message form. One first-party frame keeps the event.
 */
const RECAPTCHA_URL = /^(?:https?:)?\/\/(?:[\w-]+\.)*(?:gstatic\.com|google\.com|recaptcha\.net)\/recaptcha\//i;
/** The `[web] Uncaught ...` message the retired wasm admin's sentry-bridge sent. */
const FORWARDED_RECAPTCHA_MESSAGE = /^\[web\][\s\S]*(?:gstatic\.com|google\.com|recaptcha\.net)\/recaptcha\//i;
function isRecaptchaUrl(url: string | undefined): boolean {
  return typeof url === 'string' && RECAPTCHA_URL.test(url);
}
/** True when the event is reCAPTCHA third-party noise with no first-party frame. */
export function isRecaptchaNoise(event: ErrorEvent): boolean {
  const message = event.message ?? '';
  if (FORWARDED_RECAPTCHA_MESSAGE.test(message)) return true;
  const frames = (event.exception?.values ?? []).flatMap((v) => v.stacktrace?.frames ?? []);
  let recaptchaFrames = 0;
  for (const frame of frames) {
    const file = frame.filename ?? frame.abs_path;
    // A frame with no file (native code, "<anonymous>") says nothing either way.
    if (!file || file === '<anonymous>' || file === 'native') continue;
    if (!isRecaptchaUrl(file)) return false;
    recaptchaFrames += 1;
  }
  return recaptchaFrames > 0;
}
/** Sentry `beforeSend`: returns null (drop) for reCAPTCHA-only events. */
export function dropRecaptchaNoise(event: ErrorEvent): ErrorEvent | null {
  return isRecaptchaNoise(event) ? null : event;
}
