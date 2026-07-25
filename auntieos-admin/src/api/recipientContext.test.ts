import { describe, it, expect, vi } from 'vitest';

const { getDocMock, callMock } = vi.hoisted(() => ({ getDocMock: vi.fn(), callMock: vi.fn() }));
vi.mock('firebase/firestore', () => ({
  doc: (_db: unknown, coll: string, id: string) => ({ _path: `${coll}/${id}` }),
  getDoc: getDocMock,
}));
vi.mock('../lib/firebase', () => ({ db: {} }));
vi.mock('../lib/fns', () => ({ call: callMock }));

import {
  getDossier,
  getKin411,
  commsQueries,
  recapRecentComms,
  COMMS_MAX,
} from './recipientContext';

// NOTE: mocks reset at the top of EACH test body, the deviation
// `api/invoicesWrite.test.ts` documents: resetting a hoisted mock of a
// `vi.mock`'d local module from a `beforeEach`, in a test that both configures a
// rejection and awaits it, makes Vitest misreport the caught rejection as
// unhandled.

function snap(data: Record<string, unknown> | null) {
  return { exists: () => data !== null, data: () => data };
}

describe('getDossier', () => {
  it('point-reads the dossier whose doc id IS the kinfolk id', async () => {
    getDocMock.mockReset();
    getDocMock.mockResolvedValue(snap({ tldr: 'Prefers texts.', rawSummary: 'long' }));

    const d = await getDossier('kf1');

    expect((getDocMock.mock.calls[0]?.[0] as { _path: string })._path).toBe('dossiers/kf1');
    expect(d?.tldr).toBe('Prefers texts.');
  });

  it('returns null for a household with no dossier yet, which is not an error', async () => {
    getDocMock.mockReset();
    getDocMock.mockResolvedValue(snap(null));
    expect(await getDossier('kf1')).toBeNull();
  });

  it('reads every field defensively, so a legacy doc missing one cannot blank the panel', async () => {
    getDocMock.mockReset();
    getDocMock.mockResolvedValue(snap({ tldr: 42, rawSummary: null }));
    const d = await getDossier('kf1');
    expect(d?.tldr).toBe('');
    expect(d?.rawSummary).toBe('');
  });

  it('never queries on a blank id, which would read a collection root', async () => {
    getDocMock.mockReset();
    expect(await getDossier('   ')).toBeNull();
    expect(getDocMock).not.toHaveBeenCalled();
  });

  it('propagates a permission failure rather than reporting an empty dossier', async () => {
    getDocMock.mockReset();
    getDocMock.mockImplementation(() => Promise.reject(new Error('permission-denied')));
    await expect(getDossier('kf1')).rejects.toThrow('permission-denied');
  });
});

describe('getKin411', () => {
  it('point-reads the deterministic 411 doc id the reconciler writes', async () => {
    getDocMock.mockReset();
    getDocMock.mockResolvedValue(snap({ tldr: 'Loves the couch.', breed: 'Border Collie' }));

    const f = await getKin411('kin9');

    expect((getDocMock.mock.calls[0]?.[0] as { _path: string })._path).toBe('the_411/411_kin9');
    expect(f?.breed).toBe('Border Collie');
  });

  it('returns null when the kin has no 411 yet', async () => {
    getDocMock.mockReset();
    getDocMock.mockResolvedValue(snap(null));
    expect(await getKin411('kin9')).toBeNull();
  });

  it('never queries on a blank kin id', async () => {
    getDocMock.mockReset();
    expect(await getKin411('')).toBeNull();
    expect(getDocMock).not.toHaveBeenCalled();
  });
});

describe('commsQueries', () => {
  it('covers all four channels the recap backend reads', () => {
    expect(commsQueries('kf1').map((q) => q.channel)).toEqual(['sms', 'email', 'call', 'voicemail']);
  });

  it('uses the collection names the backend and the rules use', () => {
    expect(commsQueries('kf1').map((q) => q.spec.path)).toEqual([
      'sms_messages',
      'emails',
      'calls_log',
      'voicemails',
    ]);
  });

  it('filters server-side by kinfolkId, so this is never a whole-collection listener', () => {
    for (const q of commsQueries('kf1')) {
      expect(q.spec.filters).toEqual([['kinfolkId', '==', 'kf1']]);
    }
  });

  it('orders by document id, which the automatic single-field index already serves', () => {
    // An equality filter plus orderBy(timestamp) would need a composite index
    // per collection, and none is deployed. Ordering by __name__ needs none.
    for (const q of commsQueries('kf1')) {
      expect(q.spec.order).toEqual(['__name__', 'asc']);
    }
  });

  it('caps every channel', () => {
    for (const q of commsQueries('kf1')) expect(q.spec.max).toBe(COMMS_MAX);
  });

  it('resolves a blank id to a sentinel that matches nothing, never to an unfiltered stream', () => {
    for (const q of commsQueries('  ')) {
      expect(q.spec.filters?.[0]?.[2]).not.toBe('');
      expect(String(q.spec.filters?.[0]?.[2])).toContain('no-recipient');
    }
  });
});

describe('recapRecentComms', () => {
  it('sends the kinfolkId the Python callable expects', async () => {
    callMock.mockReset();
    callMock.mockResolvedValue({ recap: 'They asked about the long weekend.', lastAt: '2026-07-01', sourceCount: 4 });

    const r = await recapRecentComms('kf1');

    expect(callMock).toHaveBeenCalledWith('recap_recent_comms', { kinfolkId: 'kf1' });
    expect(r.recap).toBe('They asked about the long weekend.');
    expect(r.sourceCount).toBe(4);
  });

  it('reads a missing recap as blank, which the box treats as "no recap"', async () => {
    callMock.mockReset();
    callMock.mockResolvedValue({});
    expect((await recapRecentComms('kf1')).recap).toBe('');
  });

  it('reads a non-numeric sourceCount as 0 rather than NaN', async () => {
    callMock.mockReset();
    callMock.mockResolvedValue({ recap: 'x', sourceCount: 'four' });
    expect((await recapRecentComms('kf1')).sourceCount).toBe(0);
  });

  it('never swallows the callable failure, so the panel can disclose it', async () => {
    callMock.mockReset();
    callMock.mockImplementation(() => Promise.reject(new Error('PERMISSION_DENIED: Admin only')));
    await expect(recapRecentComms('kf1')).rejects.toThrow(/Admin only/);
  });
});
