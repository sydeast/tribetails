import { call } from '../lib/fns';
/**
 * What the Inbox player gets for one voicemail or call recording.
 *
 * Twilio's stored recording link answers 401 without the account's
 * credentials, and an `<audio>` element cannot send them (#1573). The
 * `getRecordingAudio` admin callable fetches the audio server-side and returns
 * the bytes, so the credentials never leave the server. A stored link that is
 * not a Twilio recording needs no credential and comes back as `url`.
 */
export type RecordingAudio = { kind: 'blob'; blob: Blob } | { kind: 'url'; url: string };
type Wire =
  | { ok: true; source: 'twilio'; contentType: string; base64: string; bytes: number }
  | { ok: true; source: 'external'; url: string };
export function base64ToBlob(base64: string, contentType: string): Blob {
  const bin = atob(base64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return new Blob([bytes], { type: contentType });
}
export async function getRecordingAudio(kind: 'voicemail' | 'call', id: string): Promise<RecordingAudio> {
  const res = await call<{ kind: 'voicemail' | 'call'; id: string }, Wire>('getRecordingAudio', { kind, id });
  if (res.source === 'external') return { kind: 'url', url: res.url };
  return { kind: 'blob', blob: base64ToBlob(res.base64, res.contentType) };
}
