import { describe, it, expect, vi, beforeEach } from 'vitest';

const { call } = vi.hoisted(() => ({ call: vi.fn() }));
vi.mock('../lib/fns', () => ({ call }));

import { saveMediaTags, mediaTagsErrorMessage, MAX_TAGGED_KIN } from './mediaTags';

beforeEach(() => {
  call.mockReset();
});

describe('saveMediaTags', () => {
  it('calls the saveMediaTags callable with the media id and the complete list', async () => {
    call.mockResolvedValue({ ok: true, mediaFileId: 'm1', taggedKinIds: ['k1', 'k2'] });
    await saveMediaTags('m1', ['k1', 'k2']);
    expect(call).toHaveBeenCalledWith('saveMediaTags', {
      mediaFileId: 'm1',
      taggedKinIds: ['k1', 'k2'],
    });
  });

  it('returns the list AS STORED, which the server may have de-duplicated', async () => {
    call.mockResolvedValue({ ok: true, mediaFileId: 'm1', taggedKinIds: ['k1'] });
    const res = await saveMediaTags('m1', ['k1', 'k1']);
    expect(res.taggedKinIds).toEqual(['k1']);
  });

  it('sends an EMPTY list as a real save: clearing every tag is an edit, not a no-op', async () => {
    call.mockResolvedValue({ ok: true, mediaFileId: 'm1', taggedKinIds: [] });
    await saveMediaTags('m1', []);
    expect(call).toHaveBeenCalledWith('saveMediaTags', { mediaFileId: 'm1', taggedKinIds: [] });
  });

  it('trims the id before sending it', async () => {
    call.mockResolvedValue({ ok: true, mediaFileId: 'm1', taggedKinIds: [] });
    await saveMediaTags('  m1  ', []);
    expect(call).toHaveBeenCalledWith('saveMediaTags', { mediaFileId: 'm1', taggedKinIds: [] });
  });

  it('refuses a blank media id locally, without a pointless round trip', async () => {
    await expect(saveMediaTags('   ', ['k1'])).rejects.toThrow(/non-blank mediaFileId/);
    expect(call).not.toHaveBeenCalled();
  });

  it('propagates a rejected save rather than resolving as if it worked', async () => {
    call.mockRejectedValue(new Error('Media file ‘m1’ no longer exists. Refresh the gallery and try again.'));
    await expect(saveMediaTags('m1', ['k1'])).rejects.toThrow(/no longer exists/);
  });

  it('mirrors the server ceiling so the dialog can refuse before a round trip', () => {
    expect(MAX_TAGGED_KIN).toBe(50);
  });
});

describe('mediaTagsErrorMessage', () => {
  it("keeps the server's own sentence verbatim", () => {
    const msg = mediaTagsErrorMessage(new Error('No kin on file for id ghost. Refresh the household roster and try again.'));
    expect(msg).toBe('No kin on file for id ghost. Refresh the household roster and try again.');
  });

  it('names the failure when something non-Error was thrown, never an empty string', () => {
    expect(mediaTagsErrorMessage('boom')).toMatch(/unknown reason/);
    expect(mediaTagsErrorMessage(new Error('   '))).toMatch(/unknown reason/);
    expect(mediaTagsErrorMessage(undefined)).toMatch(/unknown reason/);
  });
});
