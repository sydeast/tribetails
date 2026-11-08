import { onCall, CallableRequest, HttpsError } from 'firebase-functions/v2/https';
import { z, ZodError } from 'zod';
import { db } from '../lib/firestoreAdmin';
import { logEvent } from '../lib/logger';
import { initSentry } from '../lib/sentry';
import { wrapAdminCallable } from '../lib/wrapAdminCallable';
import { TRIBETAILS_CORS } from '../lib/cors';
/**
 * getRecordingAudio (admin). Hands a voicemail or a call recording to the Inbox
 * player.
 *
 * ── WHY THIS EXISTS (#1573) ───────────────────────────────────────────────
 * `voicemails.audioUrl` and `calls_log.recordingUrl` hold Twilio's own
 * RecordingUrl (`https://api.twilio.com/2010-04-01/Accounts/AC…/Recordings/RE…`).
 * That link answers 401 without the account's credentials. The Inbox gave it to
 * an `<audio>` element (web) and to the browser (Android), neither of which can
 * send Basic auth, so the player sat at 0:00 and nothing played. The
 * credentials must stay on the server, so the server fetches the audio and the
 * client plays the bytes it returns.
 *
 * ── THE CLIENT NAMES A ROW, NEVER A URL ───────────────────────────────────
 * The request carries `{ kind, id }`. The URL comes from the document, read
 * here, so a caller cannot make this function fetch an address of their
 * choosing. The stored URL must still be an https `api.twilio.com` recording
 * path before any credential is attached; anything else is not fetched at all.
 *
 * ── A LINK THAT IS NOT A TWILIO RECORDING ─────────────────────────────────
 * The Android FCM path writes a `popupUrl` into `calls_log.recordingUrl` for
 * some rows. That is not a Twilio recording, needs no credential, and may be
 * played as-is, so it is returned as `{ source: 'external', url }` (https only)
 * and never fetched by the server.
 *
 * ── BOUNDED ───────────────────────────────────────────────────────────────
 * A callable response tops out at 10 MB and base64 adds a third, so the audio
 * is capped at `MAX_AUDIO_BYTES`. A voicemail at Twilio's MP3 rate is far
 * under that; a longer recording gets a clear error instead of a truncated one.
 */
export const MAX_AUDIO_BYTES = 6_500_000;
const FETCH_TIMEOUT_MS = 20_000;
const Args = z.object({
  kind: z.enum(['voicemail', 'call']),
  id: z.string().min(1).max(200),
});
export type RecordingAudioResult =
  | { ok: true; source: 'twilio'; contentType: string; base64: string; bytes: number }
  | { ok: true; source: 'external'; url: string };
const TWILIO_RECORDING_PATH = /^\/2010-04-01\/Accounts\/AC[0-9a-f]{32}\/Recordings\/RE[0-9a-f]{32}(\.(mp3|wav))?$/i;
/** The Twilio recording URL to fetch (MP3 form), or null when `raw` is not one. Pure. */
export function twilioRecordingFetchUrl(raw: string): string | null {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    return null;
  }
  if (u.protocol !== 'https:' || u.hostname !== 'api.twilio.com' || u.port !== '') return null;
  if (u.username !== '' || u.password !== '') return null;
  if (!TWILIO_RECORDING_PATH.test(u.pathname)) return null;
  const path = u.pathname.replace(/\.(mp3|wav)$/i, '');
  return `https://api.twilio.com${path}.mp3`;
}
function storedUrl(kind: 'voicemail' | 'call', data: Record<string, unknown>): string {
  const raw = kind === 'voicemail' ? data.audioUrl : data.recordingUrl;
  return typeof raw === 'string' ? raw.trim() : '';
}
export async function getRecordingAudioHandler(req: CallableRequest<unknown>): Promise<RecordingAudioResult> {
  initSentry();
  const uid = req.auth?.uid;
  if (!uid) throw new HttpsError('unauthenticated', 'Sign-in required.');
  let args: z.infer<typeof Args>;
  try {
    args = Args.parse(req.data);
  } catch (err) {
    if (err instanceof ZodError) throw new HttpsError('invalid-argument', 'getRecordingAudio validation failed');
    throw err;
  }
  const collection = args.kind === 'voicemail' ? 'voicemails' : 'calls_log';
  const snap = await db().collection(collection).doc(args.id).get();
  if (!snap.exists) throw new HttpsError('not-found', 'That recording does not exist.');
  const url = storedUrl(args.kind, (snap.data() ?? {}) as Record<string, unknown>);
  if (url === '') throw new HttpsError('failed-precondition', 'This item has no recording.');
  const fetchUrl = twilioRecordingFetchUrl(url);
  if (fetchUrl === null) {
    // Not a Twilio recording: nothing to authenticate, so nothing to proxy.
    if (/^https:\/\//i.test(url)) return { ok: true, source: 'external', url };
    throw new HttpsError('failed-precondition', 'This recording is not at an address that can be played.');
  }
  const sid = process.env.TWILIO_ACCOUNT_SID;
  const token = process.env.TWILIO_AUTH_TOKEN;
  if (!sid || !token) {
    throw new HttpsError('failed-precondition', 'Twilio is not configured, so recordings cannot be played yet.');
  }
  let res: Response;
  try {
    res = await fetch(fetchUrl, {
      headers: { Authorization: `Basic ${Buffer.from(`${sid}:${token}`).toString('base64')}` },
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
  } catch (err) {
    logEvent({
      severity: 'error',
      function: 'getRecordingAudio',
      event: 'fetch.failed',
      uid,
      errorMessage: (err as Error)?.message,
    });
    throw new HttpsError('unavailable', 'Twilio did not answer. Try the recording again in a moment.');
  }
  if (res.status === 404) throw new HttpsError('not-found', 'Twilio no longer has this recording.');
  if (!res.ok) {
    logEvent({ severity: 'error', function: 'getRecordingAudio', event: 'fetch.status', uid, extra: { status: res.status } });
    throw new HttpsError('unavailable', `Twilio refused the recording (HTTP ${res.status}).`);
  }
  const declared = Number(res.headers.get('content-length') ?? '0');
  if (Number.isFinite(declared) && declared > MAX_AUDIO_BYTES) {
    throw new HttpsError('failed-precondition', 'This recording is too long to play here.');
  }
  const buf = Buffer.from(await res.arrayBuffer());
  if (buf.length > MAX_AUDIO_BYTES) {
    throw new HttpsError('failed-precondition', 'This recording is too long to play here.');
  }
  const contentType = (res.headers.get('content-type') ?? '').split(';')[0]?.trim() || 'audio/mpeg';
  return { ok: true, source: 'twilio', contentType, base64: buf.toString('base64'), bytes: buf.length };
}
export const getRecordingAudio = onCall(
  {
    region: 'us-central1',
    cors: TRIBETAILS_CORS,
    secrets: ['TWILIO_ACCOUNT_SID', 'TWILIO_AUTH_TOKEN', 'SENTRY_DSN'],
    timeoutSeconds: 60,
  },
  wrapAdminCallable('getRecordingAudio', getRecordingAudioHandler),
);
