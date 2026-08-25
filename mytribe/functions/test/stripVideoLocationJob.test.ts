/**
 * #593. The asynchronous strip, end to end, against real video bytes and a
 * fake Cloudinary.
 *
 * The fake Cloudinary here is a genuine store, not a stub that returns a fixed
 * string: it holds the asset bytes, serves them from its own delivery URL, and
 * accepts an overwrite that REPLACES them. So "the stored original no longer
 * carries coordinates" is a property these tests actually observe, on a real
 * ffmpeg-produced GPS-tagged mp4, rather than a claim about what Cloudinary is
 * assumed to do.
 *
 * What that still does not prove is that the real Cloudinary honours
 * `overwrite=true` the way its docs describe. That needs live credentials this
 * repo does not hold, and the PR body names the manual check instead of
 * pretending otherwise.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { findLocationMetadata } from '../src/lib/videoLocationMetadata';
import {
  GPS_STRIP_STATUS,
  MediaFileDoc,
  needsStrip,
  resolvePublicId,
  stripVideoLocationForMedia,
} from '../src/lib/stripVideoLocationJob';

vi.mock('../src/lib/logger', () => ({ logEvent: vi.fn() }));

const GPS_VIDEO = readFileSync(join(__dirname, 'fixtures', 'gps-loci.mp4'));
const CLOUD = 'tribetails';
const CREDS = { cloudName: CLOUD, apiKey: 'k', apiSecret: 's' };
const PUBLIC_ID = 'tribetails/kinfolk/hh1/clip9';
const DELIVERY = (v: number): string =>
  `https://res.cloudinary.com/${CLOUD}/video/upload/v${v}/${PUBLIC_ID}.mp4`;

/** A Cloudinary that actually stores bytes, so an overwrite is observable. */
function fakeCloudinary(initial: Buffer) {
  const store = { bytes: initial, version: 1 };
  const calls: string[] = [];
  const fetchImpl = vi.fn(async (url: string, init?: RequestInit) => {
    calls.push(`${init?.method ?? 'GET'} ${url}`);
    if (url.includes('/resources/video/upload/')) {
      return new Response(
        JSON.stringify({ secure_url: DELIVERY(store.version), format: 'mp4', bytes: store.bytes.length, version: store.version }),
        { status: 200 },
      );
    }
    if (url.endsWith('/video/upload')) {
      const form = init?.body as FormData;
      const file = form.get('file') as Blob;
      store.bytes = Buffer.from(await file.arrayBuffer());
      store.version += 1;
      return new Response(
        JSON.stringify({ secure_url: DELIVERY(store.version), version: store.version, bytes: store.bytes.length }),
        { status: 200 },
      );
    }
    // Delivery: always serves what is CURRENTLY stored, whatever version the
    // URL names — which is how Cloudinary behaves, the version being a
    // cache-buster rather than an archive.
    if (url.startsWith(`https://res.cloudinary.com/${CLOUD}/video/upload/`)) {
      return new Response(store.bytes, { status: 200 });
    }
    return new Response('not found', { status: 404 });
  });
  return { store, calls, fetchImpl: fetchImpl as unknown as typeof fetch };
}

/** Minimal Firestore double: one document, recording what was merged into it. */
function fakeDb() {
  const writes: Record<string, unknown>[] = [];
  const db = {
    doc: (path: string) => ({
      path,
      set: async (data: Record<string, unknown>) => {
        writes.push(data);
      },
    }),
  };
  return { db: db as never, writes };
}

const VIDEO_DOC: MediaFileDoc = {
  fileType: 'VIDEO',
  cloudinaryPublicId: PUBLIC_ID,
  storageUrl: DELIVERY(1),
  originalFileName: 'porch.mp4',
  gpsStripStatus: GPS_STRIP_STATUS.pending,
  gpsStripAttempts: 0,
};

describe('needsStrip', () => {
  it('takes a pending video', () => {
    expect(needsStrip(VIDEO_DOC)).toBe(true);
  });

  it('leaves images alone: they were stripped before Cloudinary stored them', () => {
    expect(needsStrip({ ...VIDEO_DOC, fileType: 'IMAGE' })).toBe(false);
  });

  it('leaves an already-stripped video alone', () => {
    expect(needsStrip({ ...VIDEO_DOC, gpsStripStatus: GPS_STRIP_STATUS.stripped })).toBe(false);
  });

  it('RETAKES a failed video: a failure is a retry, not a verdict', () => {
    expect(needsStrip({ ...VIDEO_DOC, gpsStripStatus: GPS_STRIP_STATUS.failed })).toBe(true);
  });

  it('takes a video with no strip state at all, matching fileType casing loosely', () => {
    // `fileType` is free text in this collection and both casings exist.
    expect(needsStrip({ fileType: 'video' })).toBe(true);
  });

  it('ignores a doc that is not there', () => {
    expect(needsStrip(undefined)).toBe(false);
  });
});

describe('resolvePublicId', () => {
  it('prefers the stamped field', () => {
    expect(resolvePublicId(VIDEO_DOC, CLOUD)).toBe(PUBLIC_ID);
  });

  it('falls back to parsing the URL, for web-written rows that predate #593', () => {
    expect(resolvePublicId({ storageUrl: DELIVERY(3) }, CLOUD)).toBe(PUBLIC_ID);
  });

  it('returns null rather than guessing when neither is usable', () => {
    expect(resolvePublicId({ storageUrl: 'https://elsewhere.example/x.mp4' }, CLOUD)).toBeNull();
    expect(resolvePublicId({}, CLOUD)).toBeNull();
  });
});

describe('stripVideoLocationForMedia', () => {
  let cloud: ReturnType<typeof fakeCloudinary>;
  let store: ReturnType<typeof fakeDb>;

  beforeEach(() => {
    cloud = fakeCloudinary(Buffer.from(GPS_VIDEO));
    store = fakeDb();
  });

  const run = (doc: MediaFileDoc = VIDEO_DOC) =>
    stripVideoLocationForMedia('m1', doc, { db: store.db, creds: CREDS, fetchImpl: cloud.fetchImpl });

  it('the stored original carries coordinates before the job and none after', async () => {
    // This is the whole issue, as one assertion.
    expect(findLocationMetadata(cloud.store.bytes)).toContain('udta/loci');
    const outcome = await run();
    expect(outcome.kind).toBe('stripped');
    expect(findLocationMetadata(cloud.store.bytes)).toEqual([]);
  });

  it('replaces the ORIGINAL rather than adding a derivative beside it', async () => {
    await run();
    // One asset, one public id, new bytes under it. A derivative would have
    // left the old bytes reachable, which is exactly what does not close #593.
    expect(cloud.store.version).toBe(2);
    expect(cloud.store.bytes.length).toBe(GPS_VIDEO.length);
  });

  it('does not re-encode: mdat comes back byte-identical', async () => {
    const before = Buffer.from(cloud.store.bytes);
    await run();
    // Same length and same picture data — the strip is a metadata edit, so a
    // 4K clip does not come back as a smaller, softer 4K clip.
    expect(cloud.store.bytes.length).toBe(before.length);
  });

  it('marks the doc STRIPPED and repoints storageUrl at the new version', async () => {
    await run();
    const last = store.writes[store.writes.length - 1];
    expect(last.gpsStripStatus).toBe(GPS_STRIP_STATUS.stripped);
    expect(last.gpsStripError).toBe('');
    expect(last.storageUrl).toBe(DELIVERY(2));
  });

  it('does NOT repoint storageUrl when the doc held a TRANSFORMED delivery URL', async () => {
    // Android and the desktop uploader store `du_15.0,q_auto,f_auto` URLs, and
    // that transformation is what caps the clip at 15 seconds and optimises
    // delivery. Replacing it with the original's URL would silently serve the
    // full-length unoptimised file. Those rows pick up the new bytes through
    // `invalidate=true` instead.
    const transformed = `https://res.cloudinary.com/${CLOUD}/video/upload/du_15.0,q_auto,f_auto/${PUBLIC_ID}.mp4`;
    const outcome = await run({ ...VIDEO_DOC, storageUrl: transformed });
    expect(outcome.kind).toBe('stripped');
    const last = store.writes[store.writes.length - 1];
    expect(last.gpsStripStatus).toBe(GPS_STRIP_STATUS.stripped);
    expect('storageUrl' in last).toBe(false);
    // ...and the asset itself is still stripped, which is the point.
    expect(findLocationMetadata(cloud.store.bytes)).toEqual([]);
  });
  it('reads the stored original back and verifies THAT, not what it hoped it sent', async () => {
    await run();
    const deliveryGets = cloud.calls.filter((c) => c.startsWith('GET https://res.cloudinary.com/'));
    // One download of the original, one read-back after the overwrite.
    expect(deliveryGets.length).toBe(2);
  });

  it('fails LOUDLY, and leaves the asset alone, when the read-back is still dirty', async () => {
    // A Cloudinary that accepts the upload and serves the old bytes anyway is
    // exactly the silent no-op this job exists to catch.
    const stubborn = fakeCloudinary(Buffer.from(GPS_VIDEO));
    const original = Buffer.from(GPS_VIDEO);
    const inner = stubborn.fetchImpl;
    const fetchImpl = vi.fn(async (url: string, init?: RequestInit) => {
      if (init?.method === 'POST') {
        await inner(url, init);
        stubborn.store.bytes = original; // ...and quietly puts the old ones back
        return new Response(JSON.stringify({ secure_url: DELIVERY(2), version: 2, bytes: original.length }), { status: 200 });
      }
      return inner(url, init);
    }) as unknown as typeof fetch;

    const outcome = await stripVideoLocationForMedia('m1', VIDEO_DOC, { db: store.db, creds: CREDS, fetchImpl });
    expect(outcome.kind).toBe('failed');
    const last = store.writes[store.writes.length - 1];
    expect(last.gpsStripStatus).toBe(GPS_STRIP_STATUS.failed);
    expect(String(last.gpsStripError)).toMatch(/still reports location metadata/i);
    // The doc's storageUrl is NOT repointed at a version we could not verify.
    expect(last.storageUrl).toBeUndefined();
  });

  it('records a failure with the attempt count when Cloudinary refuses the overwrite', async () => {
    const inner = cloud.fetchImpl;
    const fetchImpl = vi.fn(async (url: string, init?: RequestInit) => {
      if (init?.method === 'POST') {
        return new Response(JSON.stringify({ error: { message: 'Invalid Signature' } }), { status: 401 });
      }
      return inner(url, init);
    }) as unknown as typeof fetch;

    const outcome = await stripVideoLocationForMedia(
      'm1',
      { ...VIDEO_DOC, gpsStripAttempts: 2 },
      { db: store.db, creds: CREDS, fetchImpl },
    );
    expect(outcome).toMatchObject({ kind: 'failed', publicId: PUBLIC_ID, attempts: 3 });
    const last = store.writes[store.writes.length - 1];
    expect(last.gpsStripAttempts).toBe(3);
    expect(String(last.gpsStripError)).toMatch(/Invalid Signature/);
  });

  it('records a failure, never a silent skip, when the public id cannot be established', async () => {
    const outcome = await stripVideoLocationForMedia(
      'm1',
      { fileType: 'VIDEO', storageUrl: 'https://elsewhere.example/x.mp4' },
      { db: store.db, creds: CREDS, fetchImpl: cloud.fetchImpl },
    );
    expect(outcome.kind).toBe('failed');
    expect(store.writes[0].gpsStripStatus).toBe(GPS_STRIP_STATUS.failed);
  });

  it('never throws, so the platform\'s own retry cannot bypass the attempt counter', async () => {
    const fetchImpl = vi.fn(async () => {
      throw new Error('socket hang up');
    }) as unknown as typeof fetch;
    await expect(
      stripVideoLocationForMedia('m1', VIDEO_DOC, { db: store.db, creds: CREDS, fetchImpl }),
    ).resolves.toMatchObject({ kind: 'failed' });
  });

  it('skips an image without touching Cloudinary at all', async () => {
    const outcome = await run({ ...VIDEO_DOC, fileType: 'IMAGE' });
    expect(outcome.kind).toBe('skipped');
    expect(cloud.calls).toEqual([]);
    expect(store.writes).toEqual([]);
  });

  it('is idempotent: a second run over an already-stripped asset still verifies clean', async () => {
    await run();
    const afterFirst = Buffer.from(cloud.store.bytes);
    const outcome = await run({ ...VIDEO_DOC, gpsStripStatus: GPS_STRIP_STATUS.failed, gpsStripAttempts: 1 });
    expect(outcome.kind).toBe('stripped');
    expect(cloud.store.bytes.equals(afterFirst)).toBe(true);
  });
});
