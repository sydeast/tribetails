import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { CallableRequest } from 'firebase-functions/v2/https';
import { buildDbMock } from './_helpers/mockDb';
const mocks = vi.hoisted(() => ({ dbFn: vi.fn() }));
vi.mock('../src/lib/firestoreAdmin', () => ({ db: mocks.dbFn, auth: vi.fn(), getAdmin: vi.fn() }));
vi.mock('../src/lib/sentry', () => ({ initSentry: vi.fn() }));
vi.mock('../src/lib/logger', () => ({ logEvent: vi.fn() }));
import {
  getRecordingAudioHandler,
  twilioRecordingFetchUrl,
  MAX_AUDIO_BYTES,
} from '../src/admin/getRecordingAudio';
const SID = 'AC' + 'a'.repeat(32);
const REC = 'RE' + 'b'.repeat(32);
const TWILIO_URL = `https://api.twilio.com/2010-04-01/Accounts/${SID}/Recordings/${REC}`;
function req(data: unknown, uid: string | null = 'admin-1'): CallableRequest<unknown> {
  return { data, auth: uid ? ({ uid, token: { admin: true } } as never) : undefined } as unknown as CallableRequest<unknown>;
}
const fetchMock = vi.fn();
beforeEach(() => {
  mocks.dbFn.mockReset();
  fetchMock.mockReset();
  vi.stubGlobal('fetch', fetchMock);
  process.env.TWILIO_ACCOUNT_SID = 'ACtestsid';
  process.env.TWILIO_AUTH_TOKEN = 'tok';
});
afterEach(() => {
  vi.unstubAllGlobals();
  delete process.env.TWILIO_ACCOUNT_SID;
  delete process.env.TWILIO_AUTH_TOKEN;
});
function audioResponse(bytes: Buffer, init: { status?: number; type?: string; length?: boolean } = {}) {
  const headers: Record<string, string> = { 'content-type': init.type ?? 'audio/mpeg' };
  if (init.length !== false) headers['content-length'] = String(bytes.length);
  return new Response(bytes, { status: init.status ?? 200, headers });
}
describe('twilioRecordingFetchUrl', () => {
  it('accepts a Twilio recording and asks for the MP3 form', () => {
    expect(twilioRecordingFetchUrl(TWILIO_URL)).toBe(`${TWILIO_URL}.mp3`);
    expect(twilioRecordingFetchUrl(`${TWILIO_URL}.wav`)).toBe(`${TWILIO_URL}.mp3`);
    expect(twilioRecordingFetchUrl(`${TWILIO_URL}.mp3`)).toBe(`${TWILIO_URL}.mp3`);
  });
  it('refuses anything that is not an https api.twilio.com recording path', () => {
    for (const bad of [
      '',
      'not a url',
      `http://api.twilio.com/2010-04-01/Accounts/${SID}/Recordings/${REC}`,
      `https://evil.example/2010-04-01/Accounts/${SID}/Recordings/${REC}`,
      `https://api.twilio.com.evil.example/2010-04-01/Accounts/${SID}/Recordings/${REC}`,
      `https://user:pw@api.twilio.com/2010-04-01/Accounts/${SID}/Recordings/${REC}`,
      `https://api.twilio.com:8443/2010-04-01/Accounts/${SID}/Recordings/${REC}`,
      `https://api.twilio.com/2010-04-01/Accounts/${SID}/Calls/${REC}`,
      `https://api.twilio.com/2010-04-01/Accounts/${SID}/Recordings/${REC}/../../x`,
    ]) {
      expect(twilioRecordingFetchUrl(bad), bad).toBeNull();
    }
  });
});
describe('getRecordingAudio (admin)', () => {
  it('fetches a voicemail from Twilio with Basic auth and returns the bytes', async () => {
    mocks.dbFn.mockReturnValue(buildDbMock({ docs: { 'voicemails/v1': { audioUrl: TWILIO_URL } } }).db);
    const audio = Buffer.from('ID3-fake-mp3-bytes');
    fetchMock.mockResolvedValue(audioResponse(audio));
    const out = await getRecordingAudioHandler(req({ kind: 'voicemail', id: 'v1' }));
    expect(out).toEqual({
      ok: true,
      source: 'twilio',
      contentType: 'audio/mpeg',
      base64: audio.toString('base64'),
      bytes: audio.length,
    });
    const [url, init] = fetchMock.mock.calls[0] as [string, { headers: Record<string, string> }];
    expect(url).toBe(`${TWILIO_URL}.mp3`);
    expect(init.headers.Authorization).toBe(`Basic ${Buffer.from('ACtestsid:tok').toString('base64')}`);
  });
  it('reads a call recording from calls_log.recordingUrl', async () => {
    mocks.dbFn.mockReturnValue(buildDbMock({ docs: { 'calls_log/c1': { recordingUrl: TWILIO_URL } } }).db);
    fetchMock.mockResolvedValue(audioResponse(Buffer.from('x')));
    const out = await getRecordingAudioHandler(req({ kind: 'call', id: 'c1' }));
    expect(out).toMatchObject({ ok: true, source: 'twilio' });
  });
  it('never fetches a URL it did not read from the document, and sends no credential off-Twilio', async () => {
    mocks.dbFn.mockReturnValue(
      buildDbMock({ docs: { 'calls_log/c2': { recordingUrl: 'https://auntie.example/call/CA123' } } }).db,
    );
    const out = await getRecordingAudioHandler(req({ kind: 'call', id: 'c2' }));
    expect(out).toEqual({ ok: true, source: 'external', url: 'https://auntie.example/call/CA123' });
    expect(fetchMock).not.toHaveBeenCalled();
  });
  it('refuses a non-https stored link', async () => {
    mocks.dbFn.mockReturnValue(buildDbMock({ docs: { 'voicemails/v2': { audioUrl: 'http://x.example/a.mp3' } } }).db);
    await expect(getRecordingAudioHandler(req({ kind: 'voicemail', id: 'v2' }))).rejects.toMatchObject({
      code: 'failed-precondition',
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });
  it('rejects unauthenticated callers', async () => {
    mocks.dbFn.mockReturnValue(buildDbMock().db);
    await expect(getRecordingAudioHandler(req({ kind: 'voicemail', id: 'v1' }, null))).rejects.toMatchObject({
      code: 'unauthenticated',
    });
  });
  it('rejects a malformed request', async () => {
    mocks.dbFn.mockReturnValue(buildDbMock().db);
    await expect(getRecordingAudioHandler(req({ kind: 'sms', id: 'x' }))).rejects.toMatchObject({ code: 'invalid-argument' });
    await expect(getRecordingAudioHandler(req({ kind: 'voicemail' }))).rejects.toMatchObject({ code: 'invalid-argument' });
  });
  it('says not-found for a missing row and failed-precondition for a row with no recording', async () => {
    mocks.dbFn.mockReturnValue(buildDbMock({ docs: { 'voicemails/empty': { audioUrl: '' } } }).db);
    await expect(getRecordingAudioHandler(req({ kind: 'voicemail', id: 'nope' }))).rejects.toMatchObject({ code: 'not-found' });
    await expect(getRecordingAudioHandler(req({ kind: 'voicemail', id: 'empty' }))).rejects.toMatchObject({
      code: 'failed-precondition',
    });
  });
  it('fails loud when Twilio is not configured', async () => {
    delete process.env.TWILIO_AUTH_TOKEN;
    mocks.dbFn.mockReturnValue(buildDbMock({ docs: { 'voicemails/v1': { audioUrl: TWILIO_URL } } }).db);
    await expect(getRecordingAudioHandler(req({ kind: 'voicemail', id: 'v1' }))).rejects.toMatchObject({
      code: 'failed-precondition',
    });
  });
  it('maps a Twilio 404 to not-found and any other refusal to unavailable', async () => {
    mocks.dbFn.mockReturnValue(buildDbMock({ docs: { 'voicemails/v1': { audioUrl: TWILIO_URL } } }).db);
    fetchMock.mockResolvedValueOnce(audioResponse(Buffer.from(''), { status: 404 }));
    await expect(getRecordingAudioHandler(req({ kind: 'voicemail', id: 'v1' }))).rejects.toMatchObject({ code: 'not-found' });
    fetchMock.mockResolvedValueOnce(audioResponse(Buffer.from(''), { status: 401 }));
    await expect(getRecordingAudioHandler(req({ kind: 'voicemail', id: 'v1' }))).rejects.toMatchObject({ code: 'unavailable' });
  });
  it('maps a network failure to unavailable', async () => {
    mocks.dbFn.mockReturnValue(buildDbMock({ docs: { 'voicemails/v1': { audioUrl: TWILIO_URL } } }).db);
    fetchMock.mockRejectedValue(new Error('socket hang up'));
    await expect(getRecordingAudioHandler(req({ kind: 'voicemail', id: 'v1' }))).rejects.toMatchObject({ code: 'unavailable' });
  });
  it('refuses audio over the cap, declared or not', async () => {
    mocks.dbFn.mockReturnValue(buildDbMock({ docs: { 'voicemails/v1': { audioUrl: TWILIO_URL } } }).db);
    const big = Buffer.alloc(MAX_AUDIO_BYTES + 1);
    fetchMock.mockResolvedValueOnce(audioResponse(big));
    await expect(getRecordingAudioHandler(req({ kind: 'voicemail', id: 'v1' }))).rejects.toMatchObject({
      code: 'failed-precondition',
    });
    fetchMock.mockResolvedValueOnce(audioResponse(big, { length: false }));
    await expect(getRecordingAudioHandler(req({ kind: 'voicemail', id: 'v1' }))).rejects.toMatchObject({
      code: 'failed-precondition',
    });
  });
});
