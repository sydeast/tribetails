import { describe, it, expect, vi, beforeEach } from 'vitest';

const { getDoc } = vi.hoisted(() => ({ getDoc: vi.fn() }));
vi.mock('../lib/firebase', () => ({ db: {} }));
vi.mock('firebase/firestore', () => ({
  doc: vi.fn((_db: unknown, path: string, id: string) => ({ path, id })),
  getDoc,
}));

import { GALLERY_QUERY, getMediaFilesByIds } from './gallery';

type Stored = Record<string, unknown> | 'missing' | 'refused' | 'offline';

/** Answer each by-id read from a table: a document, no document, a rules refusal, or a network failure. */
function serve(files: Record<string, Stored>) {
  getDoc.mockImplementation(async (ref: { path: string; id: string }) => {
    const stored = files[ref.id] ?? 'missing';
    if (stored === 'refused') throw Object.assign(new Error('Missing or insufficient permissions.'), { code: 'permission-denied' });
    if (stored === 'offline') throw Object.assign(new Error('Failed to get document because the client is offline.'), { code: 'unavailable' });
    if (stored === 'missing') return { id: ref.id, exists: () => false, data: () => undefined };
    return { id: ref.id, exists: () => true, data: () => stored };
  });
}

beforeEach(() => {
  getDoc.mockReset();
});

describe('GALLERY_QUERY', () => {
  it('lists media newest first, capped, and names no type of its own', () => {
    expect(GALLERY_QUERY).toEqual({ path: 'media_files', order: ['uploadedAt', 'desc'], max: 500 });
  });
});

/**
 * The KinTale composer's photo strip reads a draft's attached files by id. A
 * file that is gone, or one this account may not read, is one missing
 * thumbnail; it must not blank the others.
 */
describe('getMediaFilesByIds', () => {
  it('HAPPY: returns the files in the order asked for, each with its id', async () => {
    serve({
      a: { entityType: 'VISIT_LOG', storageUrl: 'https://cdn.test/a.jpg', isProfilePhoto: false, durationSeconds: 0 },
      b: { entityType: 'VISIT_LOG', storageUrl: 'https://cdn.test/b.mp4', isProfilePhoto: true, durationSeconds: 12 },
    });
    const rows = await getMediaFilesByIds(['b', 'a']);
    expect(rows.map((r) => r._id)).toEqual(['b', 'a']);
    expect(rows[0]).toMatchObject({ storageUrl: 'https://cdn.test/b.mp4', isProfilePhoto: true, durationSeconds: 12 });
  });

  it('reads each id from media_files, and skips a blank id without a read', async () => {
    serve({ a: { storageUrl: 'https://cdn.test/a.jpg' } });
    await getMediaFilesByIds(['a', '', '   ']);
    expect(getDoc).toHaveBeenCalledTimes(1);
    expect(getDoc).toHaveBeenCalledWith({ path: 'media_files', id: 'a' });
  });

  it('defaults the two fields a stored file may not carry', async () => {
    serve({ a: { storageUrl: 'https://cdn.test/a.jpg' }, b: { durationSeconds: 'long', isProfilePhoto: 'yes' } });
    const rows = await getMediaFilesByIds(['a', 'b']);
    expect(rows.map((r) => [r.isProfilePhoto, r.durationSeconds])).toEqual([
      [false, 0],
      [false, 0],
    ]);
  });

  it('SAD: no ids is an empty list and no read', async () => {
    expect(await getMediaFilesByIds([])).toEqual([]);
    expect(getDoc).not.toHaveBeenCalled();
  });

  it('SAD: a file that was deleted is left out, and the rest still come back', async () => {
    serve({ a: { storageUrl: 'https://cdn.test/a.jpg' }, gone: 'missing', c: { storageUrl: 'https://cdn.test/c.jpg' } });
    expect((await getMediaFilesByIds(['a', 'gone', 'c'])).map((r) => r._id)).toEqual(['a', 'c']);
  });

  it('NEGATIVE: a file this account may not read is left out, and the rest still come back', async () => {
    serve({ a: { storageUrl: 'https://cdn.test/a.jpg' }, theirs: 'refused', c: { storageUrl: 'https://cdn.test/c.jpg' } });
    expect((await getMediaFilesByIds(['a', 'theirs', 'c'])).map((r) => r._id)).toEqual(['a', 'c']);
  });

  it('NEGATIVE: when every file is refused the list is empty, and nothing of a refused file is returned', async () => {
    serve({ x: 'refused', y: 'refused' });
    expect(await getMediaFilesByIds(['x', 'y'])).toEqual([]);
  });

  it('ERROR: a read that failed for any other reason is raised, not read as a missing file', async () => {
    serve({ a: { storageUrl: 'https://cdn.test/a.jpg' }, b: 'offline' });
    await expect(getMediaFilesByIds(['a', 'b'])).rejects.toMatchObject({ code: 'unavailable' });
  });
});
