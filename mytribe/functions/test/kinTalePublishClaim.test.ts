import { describe, it, expect, vi, beforeEach } from 'vitest';
import { buildDbMock } from './_helpers/mockDb';

const mocks = vi.hoisted(() => ({ dbFn: vi.fn() }));
vi.mock('../src/lib/firestoreAdmin', () => ({ db: mocks.dbFn }));
vi.mock('../src/lib/logger', () => ({ logEvent: vi.fn() }));

beforeEach(() => {
  mocks.dbFn.mockReset();
});

import { claimKinTalePublish } from '../src/lib/kinTalePublishClaim';

describe('claimKinTalePublish', () => {
  it('the first caller wins the claim and stamps the taleId-keyed tracker', async () => {
    const { db, writes } = buildDbMock({ docs: {} });
    mocks.dbFn.mockReturnValue(db);

    await expect(claimKinTalePublish('r1')).resolves.toBe(true);

    const stamp = writes.find((w) => w.path === 'kinTaleNotifications/r1');
    expect(stamp).toBeDefined();
    expect(typeof stamp!.data.publishedNotifiedAtMs).toBe('number');
  });

  it('a second caller loses once the claim is stamped, and writes nothing', async () => {
    const { db, writes } = buildDbMock({
      docs: { 'kinTaleNotifications/r1': { publishedNotifiedAtMs: 1_700_000_000_000 } },
    });
    mocks.dbFn.mockReturnValue(db);

    await expect(claimKinTalePublish('r1')).resolves.toBe(false);
    expect(writes).toHaveLength(0);
  });

  it('merges into the tracker so the note.added HWM fields survive', async () => {
    const { db, writes } = buildDbMock({
      docs: { 'kinTaleNotifications/r1': { lastDigest: '11|m1', lastNotifiedAtMs: 42 } },
    });
    mocks.dbFn.mockReturnValue(db);

    await expect(claimKinTalePublish('r1')).resolves.toBe(true);

    const stamp = writes.find((w) => w.path === 'kinTaleNotifications/r1');
    expect(stamp!.merge).toBe(true);
    expect(stamp!.data).not.toHaveProperty('lastDigest');
  });

  it('fails open (claims) when the tracker read throws, so a send is never silently swallowed', async () => {
    const { db } = buildDbMock({ docs: {} });
    db.runTransaction = vi.fn(async () => {
      throw new Error('firestore unavailable');
    });
    mocks.dbFn.mockReturnValue(db);

    await expect(claimKinTalePublish('r1')).resolves.toBe(true);
  });
});
