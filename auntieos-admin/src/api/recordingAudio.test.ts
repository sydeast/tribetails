import { describe, it, expect, vi, beforeEach } from 'vitest';
const { call } = vi.hoisted(() => ({ call: vi.fn() }));
vi.mock('../lib/fns', () => ({ call }));
import { getRecordingAudio, base64ToBlob } from './recordingAudio';
beforeEach(() => call.mockReset());
describe('getRecordingAudio', () => {
  it('calls the callable with the row id and decodes the bytes into a typed blob', async () => {
    call.mockResolvedValue({ ok: true, source: 'twilio', contentType: 'audio/mpeg', base64: btoa('ID3abc'), bytes: 6 });
    const out = await getRecordingAudio('voicemail', 'vm1');
    expect(call).toHaveBeenCalledWith('getRecordingAudio', { kind: 'voicemail', id: 'vm1' });
    expect(out.kind).toBe('blob');
    if (out.kind !== 'blob') return;
    expect(out.blob.type).toBe('audio/mpeg');
    expect(out.blob.size).toBe(6);
  });
  it('passes a non-Twilio link straight through', async () => {
    call.mockResolvedValue({ ok: true, source: 'external', url: 'https://example.test/a.mp3' });
    expect(await getRecordingAudio('call', 'c1')).toEqual({ kind: 'url', url: 'https://example.test/a.mp3' });
  });
  it('lets a callable failure reach the caller', async () => {
    call.mockRejectedValueOnce(new Error('Twilio is not configured'));
    await expect(getRecordingAudio('voicemail', 'vm1')).rejects.toThrow('Twilio is not configured');
  });
  it('base64ToBlob round-trips arbitrary bytes', async () => {
    const bin = String.fromCharCode(0, 255, 128, 10);
    const blob = base64ToBlob(btoa(bin), 'audio/wav');
    expect(blob.size).toBe(4);
  });
});
