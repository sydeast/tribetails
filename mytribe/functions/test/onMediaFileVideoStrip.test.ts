/**
 * #593. The `media_files` create trigger that runs the video location strip.
 *
 * Thin by design — the work is in `stripVideoLocationJob`, tested against real
 * video bytes in its own suite. What this file pins is the trigger's own three
 * decisions: which docs it wakes for, that a misconfigured deploy says so out
 * loud instead of quietly stripping nothing, and that it never lets a secret
 * read happen for a doc it was never going to process.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

const { stripVideoLocationForMedia, logEvent, secretValues } = vi.hoisted(() => ({
  stripVideoLocationForMedia: vi.fn(),
  logEvent: vi.fn(),
  secretValues: { CLOUDINARY_CLOUD_NAME: 'tribetails', CLOUDINARY_API_KEY: 'k', CLOUDINARY_API_SECRET: 's' } as Record<string, string>,
}));

vi.mock('../src/lib/logger', () => ({ logEvent }));
vi.mock('../src/lib/wrapTrigger', () => ({ wrapTrigger: (_n: string, h: unknown) => h }));
vi.mock('../src/lib/firestoreAdmin', () => ({ db: () => ({ doc: () => ({ set: async () => undefined }) }) }));
vi.mock('../src/lib/stripVideoLocationJob', async (importActual) => {
  const actual = await importActual<typeof import('../src/lib/stripVideoLocationJob')>();
  return { ...actual, stripVideoLocationForMedia };
});
vi.mock('firebase-functions/params', () => ({
  defineSecret: (name: string) => ({ value: () => secretValues[name] }),
}));
vi.mock('firebase-functions/v2/firestore', () => ({ onDocumentCreated: (_o: unknown, h: unknown) => h }));

import { onMediaFileVideoStripHandler } from '../src/triggers/onMediaFileVideoStrip';

const event = (data: Record<string, unknown> | undefined): unknown => ({
  params: { mediaFileId: 'm1' },
  data: data === undefined ? undefined : { data: () => data },
});

describe('onMediaFileVideoStripHandler', () => {
  beforeEach(() => {
    stripVideoLocationForMedia.mockReset();
    stripVideoLocationForMedia.mockResolvedValue({ kind: 'stripped' });
    logEvent.mockReset();
    secretValues.CLOUDINARY_CLOUD_NAME = 'tribetails';
    secretValues.CLOUDINARY_API_KEY = 'k';
    secretValues.CLOUDINARY_API_SECRET = 's';
  });

  it('runs the strip for a newly uploaded video', async () => {
    await onMediaFileVideoStripHandler(event({ fileType: 'VIDEO', cloudinaryPublicId: 'a/b' }));
    expect(stripVideoLocationForMedia).toHaveBeenCalledTimes(1);
    expect(stripVideoLocationForMedia.mock.calls[0][0]).toBe('m1');
    expect(stripVideoLocationForMedia.mock.calls[0][2].creds).toEqual({
      cloudName: 'tribetails',
      apiKey: 'k',
      apiSecret: 's',
    });
  });

  it('leaves an image alone: the photo path already stripped it before storage', async () => {
    // Images are the overwhelming majority of this collection, and every one of
    // them waking a 1GiB function would be an expensive no-op.
    await onMediaFileVideoStripHandler(event({ fileType: 'IMAGE' }));
    expect(stripVideoLocationForMedia).not.toHaveBeenCalled();
  });

  it('leaves an already-stripped video alone', async () => {
    await onMediaFileVideoStripHandler(event({ fileType: 'VIDEO', gpsStripStatus: 'STRIPPED' }));
    expect(stripVideoLocationForMedia).not.toHaveBeenCalled();
  });

  it('ignores a create event with no document body', async () => {
    await expect(onMediaFileVideoStripHandler(event(undefined))).resolves.toBeUndefined();
    expect(stripVideoLocationForMedia).not.toHaveBeenCalled();
  });

  it('says so LOUDLY when the Cloudinary secrets are unset', async () => {
    // A deploy that silently stopped stripping would reopen #593 with nothing
    // in the logs to say when it happened.
    secretValues.CLOUDINARY_API_SECRET = '';
    await onMediaFileVideoStripHandler(event({ fileType: 'VIDEO', cloudinaryPublicId: 'a/b' }));
    expect(stripVideoLocationForMedia).not.toHaveBeenCalled();
    expect(logEvent).toHaveBeenCalledWith(
      expect.objectContaining({ severity: 'error', event: 'media.video.gps_strip_not_configured' }),
    );
  });
});
