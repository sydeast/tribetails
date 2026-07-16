import { describe, it, expect, vi, beforeEach } from 'vitest';

// Fake doc store. `chainEntries` holds the synthesised hash-chain in seq
// order; `headDoc` is the chain-head pointer. Tests mutate these to model
// tamper scenarios.
interface FakeEntry {
  id: string;
  data: Record<string, unknown>;
}
let chainEntries: FakeEntry[] = [];
let headDoc: { exists: boolean; data: Record<string, unknown> | undefined } = {
  exists: false,
  data: undefined,
};
// Total docs in activity_log collection (chain entries + unchained client
// writes). Defaults to chainEntries.length when tests don't override.
let totalActivityLogDocs: number | null = null;

function makeQuery(filterSeqGte?: number, equalSeq?: number, limit?: number) {
  return {
    orderBy: () => makeQuery(filterSeqGte, equalSeq, limit),
    where: (field: string, op: string, value: number) => {
      if (field === 'seq' && op === '>=') return makeQuery(value, equalSeq, limit);
      if (field === 'seq' && op === '==') return makeQuery(filterSeqGte, value, limit);
      return makeQuery(filterSeqGte, equalSeq, limit);
    },
    limit: (n: number) => makeQuery(filterSeqGte, equalSeq, n),
    count: () => ({
      get: async () => ({
        data: () => ({
          count: totalActivityLogDocs ?? chainEntries.length,
        }),
      }),
    }),
    get: async () => {
      let filtered = [...chainEntries];
      if (equalSeq !== undefined) {
        filtered = filtered.filter((e) => e.data.seq === equalSeq);
      } else if (filterSeqGte !== undefined) {
        filtered = filtered.filter((e) => (e.data.seq as number) >= filterSeqGte);
      }
      if (limit !== undefined) filtered = filtered.slice(0, limit);
      return {
        empty: filtered.length === 0,
        size: filtered.length,
        docs: filtered.map((e) => ({
          id: e.id,
          data: () => e.data,
        })),
      };
    },
  };
}

const dbMock = {
  collection: (name: string) => {
    if (name === 'activity_log') {
      return makeQuery();
    }
    if (name === 'activity_log_chain_head') {
      return {
        doc: () => ({
          get: async () => ({ exists: headDoc.exists, data: () => headDoc.data }),
        }),
      };
    }
    return makeQuery();
  },
};

vi.mock('../src/lib/firestoreAdmin', () => ({ db: () => dbMock }));
vi.mock('../src/lib/logger', () => ({ logEvent: vi.fn() }));

// Build a clean N-entry chain using the real computeEntryHash, so the
// fixtures the verifier walks are byte-identical to what writeAuditEntry
// would have produced.
async function buildCleanChain(n: number): Promise<FakeEntry[]> {
  const { computeEntryHash, GENESIS_PREV_HASH } = await import('../src/lib/writeAuditEntry');
  const entries: FakeEntry[] = [];
  let prevHash = GENESIS_PREV_HASH;
  for (let seq = 1; seq <= n; seq++) {
    const hashable: Record<string, unknown> = {
      timestamp: `2026-05-26T00:00:${String(seq).padStart(2, '0')}.000Z`,
      actionType: 'AUTH_LOGIN_SUCCESS',
      description: `entry-${seq}`,
      status: 'SUCCESS',
      actorId: `u${seq}`,
      targetId: '',
      targetCollection: '',
      severity: 'info',
      actorRole: 'PRIMARY',
      actorUid: `u${seq}`,
      payload: {},
    };
    const entryHash = computeEntryHash(seq, prevHash, hashable);
    entries.push({
      id: `entry-${seq}`,
      data: { ...hashable, seq, prevHash, entryHash, createdAt: { _serverTs: true } },
    });
    prevHash = entryHash;
  }
  return entries;
}

beforeEach(() => {
  chainEntries = [];
  headDoc = { exists: false, data: undefined };
  totalActivityLogDocs = null;
});

describe('verifyActivityLogChainHandler', () => {
  it('returns ok=true for empty chain', async () => {
    const { verifyActivityLogChainHandler } = await import('../src/admin/verifyActivityLogChain');
    const result = await verifyActivityLogChainHandler({ data: {} });
    expect(result).toEqual({
      ok: true,
      scanned: 0,
      firstSeq: null,
      lastSeq: null,
      unchainedCount: 0,
    });
  });

  it('returns ok=true for clean 3-entry chain with matching head', async () => {
    chainEntries = await buildCleanChain(3);
    const last = chainEntries[chainEntries.length - 1];
    headDoc = {
      exists: true,
      data: { seq: 3, lastHash: last.data.entryHash, lastEntryId: last.id },
    };
    const { verifyActivityLogChainHandler } = await import('../src/admin/verifyActivityLogChain');
    const result = await verifyActivityLogChainHandler({ data: {} });
    expect(result).toEqual({
      ok: true,
      scanned: 3,
      firstSeq: 1,
      lastSeq: 3,
      unchainedCount: 0,
    });
  });

  it('detects entry_hash_mismatch when an entry field is mutated in place', async () => {
    chainEntries = await buildCleanChain(3);
    // Tamper with entry #2 description without re-hashing.
    chainEntries[1].data.description = 'TAMPERED';
    headDoc = {
      exists: true,
      data: {
        seq: 3,
        lastHash: chainEntries[2].data.entryHash,
        lastEntryId: chainEntries[2].id,
      },
    };
    const { verifyActivityLogChainHandler } = await import('../src/admin/verifyActivityLogChain');
    const result = await verifyActivityLogChainHandler({ data: {} });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.anomaly.code).toBe('entry_hash_mismatch');
      if (result.anomaly.code === 'entry_hash_mismatch') {
        expect(result.anomaly.seq).toBe(2);
        expect(result.anomaly.entryId).toBe('entry-2');
      }
    }
  });

  it('detects prev_hash_mismatch when an entry is deleted', async () => {
    chainEntries = await buildCleanChain(3);
    // Delete entry #2 entirely. Entry #3 still references the OLD entry#2
    // hash via prevHash, but the verifier now reads entry#3 right after #1,
    // expecting prevHash = entry#1.entryHash. Mismatch.
    chainEntries.splice(1, 1);
    headDoc = {
      exists: true,
      data: {
        seq: 3,
        lastHash: chainEntries[1].data.entryHash,
        lastEntryId: chainEntries[1].id,
      },
    };
    const { verifyActivityLogChainHandler } = await import('../src/admin/verifyActivityLogChain');
    const result = await verifyActivityLogChainHandler({ data: {} });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      // Either seq_gap (we expected seq=2 next, got seq=3) or
      // prev_hash_mismatch — both prove tampering. We assert seq_gap
      // because seq check happens before prevHash check.
      expect(result.anomaly.code).toBe('seq_gap');
      if (result.anomaly.code === 'seq_gap') {
        expect(result.anomaly.seq).toBe(3);
        expect(result.anomaly.expectedSeq).toBe(2);
      }
    }
  });

  it('detects head_mismatch when head pointer disagrees with last observed entry', async () => {
    chainEntries = await buildCleanChain(3);
    // Head points at wrong hash.
    headDoc = {
      exists: true,
      data: { seq: 3, lastHash: 'a'.repeat(64), lastEntryId: 'entry-3' },
    };
    const { verifyActivityLogChainHandler } = await import('../src/admin/verifyActivityLogChain');
    const result = await verifyActivityLogChainHandler({ data: {} });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.anomaly.code).toBe('head_mismatch');
    }
  });

  it('reports unchainedCount when total activity_log docs > chain entries', async () => {
    chainEntries = await buildCleanChain(3);
    // Simulate 5 total docs in activity_log (2 client-direct writes lacking
    // chain fields + 3 chain entries).
    totalActivityLogDocs = 5;
    const last = chainEntries[chainEntries.length - 1];
    headDoc = {
      exists: true,
      data: { seq: 3, lastHash: last.data.entryHash, lastEntryId: last.id },
    };
    const { verifyActivityLogChainHandler } = await import('../src/admin/verifyActivityLogChain');
    const result = await verifyActivityLogChainHandler({ data: {} });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.scanned).toBe(3);
      expect(result.unchainedCount).toBe(2);
    }
  });

  it('supports incremental scan via since parameter', async () => {
    chainEntries = await buildCleanChain(5);
    headDoc = {
      exists: true,
      data: {
        seq: 5,
        lastHash: chainEntries[4].data.entryHash,
        lastEntryId: chainEntries[4].id,
      },
    };
    const { verifyActivityLogChainHandler } = await import('../src/admin/verifyActivityLogChain');
    const result = await verifyActivityLogChainHandler({ data: { since: 3 } });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.scanned).toBe(3);
      expect(result.firstSeq).toBe(3);
      expect(result.lastSeq).toBe(5);
    }
  });
});
