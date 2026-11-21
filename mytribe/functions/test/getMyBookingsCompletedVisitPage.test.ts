import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Timestamp } from 'firebase-admin/firestore';
import { buildDbMock } from './_helpers/mockDb';

/**
 * #1836: the booking page of a completed visit said "Nothing has been sent for
 * this visit yet." after its KinTale had gone out, and "Not yet assigned" for
 * its Auntie. The walk's visit was the office's own: no Auntie assigned, taken
 * through On my way, Arrived and Departed in Auntie Time, then its KinTale sent.
 * Production shape: the household's `kinCares` copy stays `confirmed` and the
 * session alone moves, linked to the visit by `kinCareVisitId`.
 */

const mocks = vi.hoisted(() => ({ dbFn: vi.fn() }));
vi.mock('../src/lib/firestoreAdmin', () => ({ db: mocks.dbFn, auth: vi.fn(), getAdmin: vi.fn() }));
vi.mock('../src/lib/sentry', () => ({ initSentry: vi.fn() }));
vi.mock('../src/lib/logger', () => ({ logEvent: vi.fn() }));
beforeEach(() => mocks.dbFn.mockReset());

function world(opts: {
  visit?: Record<string, unknown>;
  sessionStatus?: string;
  reports?: Array<{ id: string; data: Record<string, unknown> }>;
} = {}) {
  const startMs = Date.now() - 2 * 3600_000;
  return buildDbMock({
    docs: {
      'clients/u1': { kinfolkIds: ['3'] },
      'families/3/bookings/env-a': { envelopeStatus: 'confirmed', pattern: 'individual', kinIds: ['k1'], kinNames: ['Biscuit'] },
    },
    collectionGroupDocs: {
      kinCares: [
        {
          id: 'v1',
          path: 'families/3/bookings/env-a/kinCares/v1',
          data: {
            familyId: '3',
            batchId: 'env-a',
            kinIds: ['k1'],
            kinNames: ['Biscuit'],
            status: 'confirmed',
            startTime: Timestamp.fromMillis(startMs),
            ...opts.visit,
          },
        },
      ],
    },
    queryDocs: {
      kin_care_sessions: [
        {
          id: 'vis_v1',
          data: {
            kinfolkId: '3',
            status: opts.sessionStatus ?? 'DEPARTED',
            startTime: new Date(startMs).toISOString(),
            kinCareBatchId: 'env-a',
            kinCareVisitId: 'v1',
          },
        },
      ],
      kin_care_reports: opts.reports ?? [
        {
          id: 'tale-1',
          data: { kinfolkId: '3', sessionId: 'vis_v1', sentAt: '2026-11-10T23:21:00Z', authorDisplayName: 'Maya' },
        },
      ],
    },
  });
}

async function visitOf(ctx: ReturnType<typeof world>) {
  mocks.dbFn.mockReturnValue(ctx.db);
  const { getMyBookingsHandler } = await import('../src/portal/getMyBookings');
  const res = await getMyBookingsHandler({ data: { kinfolkId: '3' }, auth: { uid: 'u1' } } as any);
  const listed = [...res.recent, ...res.upcoming].find((b) => b.id === 'v1') ?? null;
  return { listed, inEnvelope: res.envelopes[0]?.kinCares.find((b) => b.id === 'v1') ?? null };
}

describe('getMyBookings: the page of a completed visit the office worked itself (#1836)', () => {
  it('departed, linked only through the session: completed, linked to its sent KinTale, signed by its author', async () => {
    const { listed, inEnvelope } = await visitOf(world());
    expect(listed).toMatchObject({ status: 'completed', kinTaleId: 'tale-1', auntieDisplayName: 'Maya' });
    expect(inEnvelope).toMatchObject({ kinTaleId: 'tale-1', auntieDisplayName: 'Maya' });
  });

  it('the session already completed reads the same', async () => {
    const { listed } = await visitOf(world({ sessionStatus: 'COMPLETED' }));
    expect(listed).toMatchObject({ status: 'completed', kinTaleId: 'tale-1', auntieDisplayName: 'Maya' });
  });

  it('an assigned Auntie keeps her own name over the tale signature', async () => {
    const { listed } = await visitOf(world({ visit: { auntieDisplayName: 'Rosa', assignedAuntieUid: 'a1' } }));
    expect(listed).toMatchObject({ kinTaleId: 'tale-1', auntieDisplayName: 'Rosa' });
  });

  it('a tale signed with an email address names nobody, and a blank one too', async () => {
    for (const author of ['owner@tribetails.com', '   ', undefined]) {
      const { listed } = await visitOf(
        world({
          reports: [{ id: 'tale-1', data: { kinfolkId: '3', sessionId: 'vis_v1', sentAt: '2026-11-10T23:21:00Z', authorDisplayName: author } }],
        }),
      );
      expect(listed).toMatchObject({ kinTaleId: 'tale-1', auntieDisplayName: null });
    }
  });

  it('an unsent tale links nothing and signs nothing', async () => {
    const { listed } = await visitOf(
      world({ reports: [{ id: 'tale-1', data: { kinfolkId: '3', sessionId: 'vis_v1', authorDisplayName: 'Maya' } }] }),
    );
    expect(listed).toMatchObject({ status: 'completed', kinTaleId: null, auntieDisplayName: null });
  });

  it('another household’s tale on the same session id is never read', async () => {
    const { listed } = await visitOf(
      world({
        reports: [{ id: 'tale-x', data: { kinfolkId: '9', sessionId: 'vis_v1', sentAt: '2026-11-10T23:21:00Z', authorDisplayName: 'Maya' } }],
      }),
    );
    expect(listed).toMatchObject({ kinTaleId: null, auntieDisplayName: null });
  });

  it('a visit still under way is not signed by a tale', async () => {
    const { listed } = await visitOf(world({ sessionStatus: 'ARRIVED' }));
    expect(listed).toMatchObject({ status: 'active', kinTaleId: null, auntieDisplayName: null });
  });
});
