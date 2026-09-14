import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { AuditEvent } from '../src/lib/auditEvents';

interface FakeRef {
  __ref: true;
  collection: string;
  id: string;
}

const writes: Array<{ ref: FakeRef; data: Record<string, unknown> }> = [];

// Mutable state for chain head — tests assign to `headState` to control
// what tx.get(headRef) returns. Same `headState` is consulted on every
// invocation so a second writeAuditEntry call sees the seq+hash from the
// first (which the implementation wrote back to headRef in the same tx).
let headState: { exists: boolean; data: Record<string, unknown> | undefined } = {
  exists: false,
  data: undefined,
};

function makeRef(collection: string, id: string): FakeRef {
  return { __ref: true, collection, id };
}

let autoIdCounter = 0;
function nextAutoId(): string {
  autoIdCounter += 1;
  return `auto-${autoIdCounter}`;
}

const txGetMock = vi.fn((ref: FakeRef) => {
  if (ref.collection === 'activity_log_chain_head' && ref.id === 'current') {
    return Promise.resolve({ exists: headState.exists, data: () => headState.data });
  }
  return Promise.resolve({ exists: false, data: () => undefined });
});

const txSetMock = vi.fn((ref: FakeRef, data: Record<string, unknown>) => {
  writes.push({ ref, data });
  if (ref.collection === 'activity_log_chain_head' && ref.id === 'current') {
    headState = { exists: true, data };
  }
});

// #866: a fixed-id entry is written with `create`, recorded like a set.
const txCreateMock = vi.fn((ref: FakeRef, data: Record<string, unknown>) => {
  writes.push({ ref, data, created: true } as { ref: FakeRef; data: Record<string, unknown> });
});

const dbMock = {
  collection: (name: string) => ({
    doc: (id?: string) => makeRef(name, id ?? nextAutoId()),
  }),
  runTransaction: async (
    cb: (tx: { get: typeof txGetMock; set: typeof txSetMock; create: typeof txCreateMock }) => Promise<unknown>,
  ) => cb({ get: txGetMock, set: txSetMock, create: txCreateMock }),
};

vi.mock('../src/lib/firestoreAdmin', () => ({
  db: () => dbMock,
}));

beforeEach(() => {
  writes.length = 0;
  txGetMock.mockClear();
  txSetMock.mockClear();
  autoIdCounter = 0;
  headState = { exists: false, data: undefined };
});

describe('writeAuditEntry', () => {
  it('writes to activity_log with canonical Android-mirrored fields + forensic fields', async () => {
    const { writeAuditEntry } = await import('../src/lib/writeAuditEntry');
    await writeAuditEntry({
      status: 'SUCCESS',
      event: 'MEMBERSHIP_INVITE_SENT' as AuditEvent,
      severity: 'info',
      actorRole: 'PRIMARY',
      actorUid: 'u1',
      familyId: 'fid1',
      payload: { invited: 'a@b' },
    });

    const logWrite = writes.find((w) => w.ref.collection === 'activity_log');
    expect(logWrite).toBeDefined();
    const arg = logWrite!.data;

    // Canonical Android-mirrored fields
    expect(arg.actionType).toBe('MEMBERSHIP_INVITE_SENT');
    expect(typeof arg.timestamp).toBe('string');
    expect(arg.timestamp).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(arg.description).toContain('MEMBERSHIP_INVITE_SENT');
    expect(arg.status).toBe('SUCCESS');
    expect(arg.actorId).toBe('u1');
    expect(arg.targetId).toBe('');
    expect(arg.targetCollection).toBe('');

    // Forensic fields preserved
    expect(arg.severity).toBe('info');
    expect(arg.actorUid).toBe('u1');
    expect(arg.familyId).toBe('fid1');
    expect(arg.payload).toEqual({ invited: 'a@b' });
    expect(arg.createdAt).toBeDefined();
  });

  // A4 audit (2026-08): writeAuditEntry used to guess status from severity
  // (`severity === 'critical' ? 'FAILURE' : 'SUCCESS'`) when a caller left
  // status unset. That guess was wrong in both directions — a warn-severity
  // function failure defaulted to SUCCESS (wrapCallable.ts), and
  // critical-severity successes (recovery/rollback flows, flagged critical
  // purely for elevated review) defaulted to FAILURE. `status` is now a
  // required argument with no default, so severity and status can vary
  // independently and every caller must say which one happened.
  it('records status independently of severity: warn+FAILURE', async () => {
    const { writeAuditEntry } = await import('../src/lib/writeAuditEntry');
    await writeAuditEntry({
      status: 'FAILURE',
      event: 'ERROR_FUNCTION_FAILURE' as AuditEvent,
      severity: 'warn',
      actorRole: 'SYSTEM',
    });
    const logWrite = writes.find((w) => w.ref.collection === 'activity_log');
    expect(logWrite!.data.status).toBe('FAILURE');
    expect(logWrite!.data.severity).toBe('warn');
    expect(logWrite!.data.actionType).toBe('ERROR_FUNCTION_FAILURE');
  });

  it('records status independently of severity: critical+SUCCESS', async () => {
    const { writeAuditEntry } = await import('../src/lib/writeAuditEntry');
    await writeAuditEntry({
      status: 'SUCCESS',
      event: 'AUTH_RECOVERY_TRIGGERED' as AuditEvent,
      severity: 'critical',
      actorRole: 'AUNTIE',
    });
    const logWrite = writes.find((w) => w.ref.collection === 'activity_log');
    expect(logWrite!.data.status).toBe('SUCCESS');
    expect(logWrite!.data.severity).toBe('critical');
    expect(logWrite!.data.actionType).toBe('AUTH_RECOVERY_TRIGGERED');
  });

  it('honors explicit description / status / targetCollection over defaults', async () => {
    const { writeAuditEntry } = await import('../src/lib/writeAuditEntry');
    await writeAuditEntry({
      event: 'BOOKING_SUBMITTED' as AuditEvent,
      severity: 'info',
      actorRole: 'PRIMARY',
      actorUid: 'u9',
      targetUid: 'kf-1',
      targetCollection: 'families/kf-1/bookings',
      description: 'Kinfolk submitted 3 visits',
      status: 'PENDING',
    });
    const logWrite = writes.find((w) => w.ref.collection === 'activity_log');
    const arg = logWrite!.data;
    expect(arg.description).toBe('Kinfolk submitted 3 visits');
    expect(arg.status).toBe('PENDING');
    expect(arg.targetCollection).toBe('families/kf-1/bookings');
    expect(arg.targetId).toBe('kf-1');
  });

  // ----- C-A: hash-chain tamper-evidence -----

  it('first entry has seq=1 and prevHash=GENESIS_PREV_HASH', async () => {
    const { writeAuditEntry, GENESIS_PREV_HASH } = await import('../src/lib/writeAuditEntry');
    await writeAuditEntry({
      status: 'SUCCESS',
      event: 'AUTH_LOGIN_SUCCESS' as AuditEvent,
      severity: 'info',
      actorRole: 'PRIMARY',
      actorUid: 'u1',
    });
    const logWrite = writes.find((w) => w.ref.collection === 'activity_log');
    const arg = logWrite!.data;
    expect(arg.seq).toBe(1);
    expect(arg.prevHash).toBe(GENESIS_PREV_HASH);
    expect(typeof arg.entryHash).toBe('string');
    expect((arg.entryHash as string).length).toBe(64);
  });

  it('updates chain head with seq + lastHash + lastEntryId', async () => {
    const { writeAuditEntry } = await import('../src/lib/writeAuditEntry');
    await writeAuditEntry({
      status: 'SUCCESS',
      event: 'AUTH_LOGIN_SUCCESS' as AuditEvent,
      severity: 'info',
      actorRole: 'PRIMARY',
      actorUid: 'u1',
    });
    const logWrite = writes.find((w) => w.ref.collection === 'activity_log');
    const headWrite = writes.find((w) => w.ref.collection === 'activity_log_chain_head');
    expect(headWrite).toBeDefined();
    expect(headWrite!.data.seq).toBe(1);
    expect(headWrite!.data.lastHash).toBe(logWrite!.data.entryHash);
    expect(headWrite!.data.lastEntryId).toBe(logWrite!.ref.id);
  });

  it('second entry has seq=2 and prevHash equal to first entry hash', async () => {
    const { writeAuditEntry } = await import('../src/lib/writeAuditEntry');
    await writeAuditEntry({
      status: 'SUCCESS',
      event: 'AUTH_LOGIN_SUCCESS' as AuditEvent,
      severity: 'info',
      actorRole: 'PRIMARY',
      actorUid: 'u1',
    });
    const firstWrite = writes.find((w) => w.ref.collection === 'activity_log');
    const firstHash = firstWrite!.data.entryHash;
    writes.length = 0;

    await writeAuditEntry({
      status: 'SUCCESS',
      event: 'BOOKING_SUBMITTED' as AuditEvent,
      severity: 'info',
      actorRole: 'PRIMARY',
      actorUid: 'u2',
    });
    const secondWrite = writes.find((w) => w.ref.collection === 'activity_log');
    expect(secondWrite!.data.seq).toBe(2);
    expect(secondWrite!.data.prevHash).toBe(firstHash);
    expect(secondWrite!.data.entryHash).not.toBe(firstHash);
  });

  it('entryHash matches computeEntryHash applied to the same canonical input', async () => {
    const { writeAuditEntry, computeEntryHash } = await import('../src/lib/writeAuditEntry');
    await writeAuditEntry({
      status: 'SUCCESS',
      event: 'AUTH_LOGIN_SUCCESS' as AuditEvent,
      severity: 'info',
      actorRole: 'PRIMARY',
      actorUid: 'u1',
    });
    const logWrite = writes.find((w) => w.ref.collection === 'activity_log');
    const { seq, prevHash, entryHash, createdAt: _ignored1, ...rest } = logWrite!.data as Record<
      string,
      unknown
    > & { seq: number; prevHash: string; entryHash: string };
    // Strip chain fields + createdAt sentinel before re-hashing.
    const hashable = Object.fromEntries(
      Object.entries(rest).filter(([k]) => k !== 'seq' && k !== 'prevHash' && k !== 'entryHash'),
    );
    const recomputed = computeEntryHash(seq, prevHash, hashable);
    expect(recomputed).toBe(entryHash);
  });

  it('resists corrupt prior head (non-64-hex lastHash falls back to GENESIS)', async () => {
    headState = {
      exists: true,
      data: { seq: 7, lastHash: 'not-a-real-hash', lastEntryId: 'whatever' },
    };
    const { writeAuditEntry, GENESIS_PREV_HASH } = await import('../src/lib/writeAuditEntry');
    await writeAuditEntry({
      status: 'SUCCESS',
      event: 'AUTH_LOGIN_SUCCESS' as AuditEvent,
      severity: 'info',
      actorRole: 'PRIMARY',
      actorUid: 'u1',
    });
    const logWrite = writes.find((w) => w.ref.collection === 'activity_log');
    // Fall back to GENESIS because lastHash was malformed — chain BREAK is
    // explicit and inspectable by the verifier (seq jumps but prevHash
    // doesn't reference any real prior entry).
    expect(logWrite!.data.prevHash).toBe(GENESIS_PREV_HASH);
    // Seq still advances so the verifier sees a gap.
    expect(logWrite!.data.seq).toBe(8);
  });

  // #866: the Stripe webhook's paid and failed audits are written at most once
  // per event, so a retry whose first attempt wrote the entry and lost its
  // stamp does not record the event twice.
  it('writes an entry with a caller-supplied docId at exactly that id', async () => {
    const { writeAuditEntry } = await import('../src/lib/writeAuditEntry');
    const id = await writeAuditEntry({
      status: 'SUCCESS',
      event: 'BILLING_INVOICE_PAID' as AuditEvent,
      severity: 'info',
      actorRole: 'SYSTEM',
      docId: 'stripe_evt_1_paid',
    });
    expect(id).toBe('stripe_evt_1_paid');
    const logWrite = writes.find((w) => w.ref.collection === 'activity_log');
    expect(logWrite!.ref.id).toBe('stripe_evt_1_paid');
    expect(logWrite!.data.seq).toBe(1);
  });

  it('writes nothing, and does not advance the chain, when the docId entry already exists', async () => {
    headState = { exists: true, data: { seq: 4, lastHash: 'a'.repeat(64), lastEntryId: 'stripe_evt_1_paid' } };
    txGetMock.mockImplementation((ref: FakeRef) => {
      if (ref.collection === 'activity_log' && ref.id === 'stripe_evt_1_paid') {
        return Promise.resolve({ exists: true, data: () => ({ seq: 4 }) });
      }
      if (ref.collection === 'activity_log_chain_head' && ref.id === 'current') {
        return Promise.resolve({ exists: headState.exists, data: () => headState.data });
      }
      return Promise.resolve({ exists: false, data: () => undefined });
    });
    const { writeAuditEntry } = await import('../src/lib/writeAuditEntry');
    const id = await writeAuditEntry({
      status: 'SUCCESS',
      event: 'BILLING_INVOICE_PAID' as AuditEvent,
      severity: 'info',
      actorRole: 'SYSTEM',
      docId: 'stripe_evt_1_paid',
    });
    expect(id).toBe('stripe_evt_1_paid');
    expect(writes).toHaveLength(0);
    expect(headState.data!['seq']).toBe(4);
  });
});
