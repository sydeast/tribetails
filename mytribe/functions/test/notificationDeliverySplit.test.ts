import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * The R5 delivery split, at the two seams the dispatcher tests do not reach:
 * the fan-out trigger (which now watches the work order and writes the workflow
 * into the Activity Log) and the queue promoter shared by the three sweeps.
 *
 * WHAT THIS FILE IS REALLY GUARDING is the operator's second complaint:
 * "Channels, trigger, and dispatched are activity log not notification." It is
 * not enough that those fields left the card. If they had simply been deleted,
 * the product would have lost the record of whether anything was ever sent. So
 * the assertions below are paired throughout: state is off the notification AND
 * state is recorded where the operator said it belongs.
 */

const mocks = vi.hoisted(() => ({
  dbFn: vi.fn(),
  writeAudit: vi.fn().mockResolvedValue('audit1'),
}));
vi.mock('../src/lib/firestoreAdmin', () => ({ db: mocks.dbFn, auth: vi.fn(), getAdmin: vi.fn() }));
vi.mock('../src/lib/logger', () => ({ logEvent: vi.fn() }));
vi.mock('../src/lib/wrapTrigger', () => ({
  wrapTrigger: (_n: string, fn: (...a: unknown[]) => unknown) => fn,
}));
vi.mock('../src/lib/writeAuditEntry', () => ({ writeAuditEntry: mocks.writeAudit }));
vi.mock('firebase-admin/firestore', async () => {
  const actual = await vi.importActual<any>('firebase-admin/firestore');
  return { ...actual, FieldValue: { serverTimestamp: () => '__TS__', increment: (n: number) => n } };
});

beforeEach(() => {
  mocks.dbFn.mockReset();
  mocks.writeAudit.mockClear().mockResolvedValue('audit1');
});

// ── fan-out trigger ──────────────────────────────────────────────────────────

interface BatchOp {
  kind: 'set' | 'update';
  path: string;
  data: Record<string, unknown>;
}

/** A work-order snapshot plus a batch recorder, standing in for the CloudEvent. */
function dispatchEvent(data: Record<string, unknown>) {
  const ops: BatchOp[] = [];
  const setSpy = vi.fn(async (patch: Record<string, unknown>) => {
    ops.push({ kind: 'set', path: 'notificationDispatch/n1', data: patch });
  });
  const ref: any = {
    id: 'n1',
    path: 'notificationDispatch/n1',
    set: setSpy,
    collection: (name: string) => ({
      doc: (id: string) => ({ path: `notificationDispatch/n1/${name}/${id}` }),
    }),
  };
  const db = {
    batch: () => ({
      set: (r: { path: string }, d: Record<string, unknown>) =>
        ops.push({ kind: 'set', path: r.path, data: d }),
      update: (r: { path: string }, d: Record<string, unknown>) =>
        ops.push({ kind: 'update', path: r.path, data: d }),
      commit: async () => undefined,
    }),
  };
  mocks.dbFn.mockReturnValue(db);
  return { event: { data: { data: () => data, ref }, params: { id: 'n1' } }, ops, setSpy };
}

describe('onNotificationCreate now fans out the WORK ORDER', () => {
  it('creates one channel subdoc per channel, UNDER notificationDispatch', async () => {
    const { event, ops } = dispatchEvent({
      notificationId: 'n1',
      key: 'kincare.booking.confirm',
      recipientUid: 'u1',
      channels: ['email', 'sms'],
      mode: 'trigger',
      status: 'pending',
    });
    const { onNotificationDispatchCreateHandler } = await import(
      '../src/notifications/triggers/onNotificationCreate'
    );

    await onNotificationDispatchCreateHandler(event);

    const created = ops.filter((o) => o.path.includes('/channels/')).map((o) => o.path);
    expect(created).toEqual([
      'notificationDispatch/n1/channels/email',
      'notificationDispatch/n1/channels/sms',
    ]);
    // Nothing is written to `notifications/` at all: the card was finished at
    // dispatch time and the pipeline has no business touching it again.
    expect(ops.some((o) => o.path.startsWith('notifications/'))).toBe(false);
    // The dispatched stamp lands on the work order.
    expect(ops.find((o) => o.kind === 'update')).toMatchObject({
      path: 'notificationDispatch/n1',
      data: { status: 'dispatched' },
    });
  });

  it('records the workflow in the Activity Log, targeted at the notification', async () => {
    const { event } = dispatchEvent({
      notificationId: 'n1',
      key: 'kincare.booking.confirm',
      recipientUid: 'u1',
      channels: ['email'],
      mode: 'trigger',
      status: 'pending',
    });
    const { onNotificationDispatchCreateHandler } = await import(
      '../src/notifications/triggers/onNotificationCreate'
    );

    await onNotificationDispatchCreateHandler(event);

    expect(mocks.writeAudit).toHaveBeenCalledWith(
      expect.objectContaining({
        event: 'NOTIFICATION_DISPATCHED',
        status: 'SUCCESS',
        targetUid: 'n1',
        targetCollection: 'notifications',
        payload: expect.objectContaining({
          key: 'kincare.booking.confirm',
          mode: 'trigger',
          channels: ['email'],
        }),
      }),
    );
  });

  it('marks a channel-less work order complete and fans out nothing', async () => {
    const { event, ops, setSpy } = dispatchEvent({
      notificationId: 'n1',
      key: 'broadcast.message',
      recipientUid: 'u1',
      channels: [],
      status: 'pending',
    });
    const { onNotificationDispatchCreateHandler } = await import(
      '../src/notifications/triggers/onNotificationCreate'
    );

    await onNotificationDispatchCreateHandler(event);

    expect(setSpy).toHaveBeenCalledWith(
      expect.objectContaining({ status: 'no-channels' }),
      { merge: true },
    );
    expect(ops.some((o) => o.path.includes('/channels/'))).toBe(false);
  });

  /**
   * The migration guard, restated at the trigger. The backfill script relocates
   * work orders carrying a TERMINAL status ('dispatched'), and this early return
   * is what makes that safe: a year-old delivery cannot be re-fanned-out and
   * re-sent to a household by the act of migrating it.
   */
  it('ignores a work order that is not pending, so a migrated one never re-sends', async () => {
    const { event, ops } = dispatchEvent({
      notificationId: 'n1',
      key: 'kincare.booking.confirm',
      channels: ['email'],
      status: 'dispatched',
    });
    const { onNotificationDispatchCreateHandler } = await import(
      '../src/notifications/triggers/onNotificationCreate'
    );

    await onNotificationDispatchCreateHandler(event);

    expect(ops).toEqual([]);
    expect(mocks.writeAudit).not.toHaveBeenCalled();
  });
});

// ── queue promoter ───────────────────────────────────────────────────────────

/** Records both documents a promotion writes. */
function promoterDb() {
  const writes: Array<{ path: string; data: Record<string, unknown> }> = [];
  let auto = 0;
  const db: any = {
    collection: (name: string) => ({
      doc: (id?: string) => {
        if (!id) auto += 1;
        return { id: id ?? `auto-${auto}`, path: `${name}/${id ?? `auto-${auto}`}` };
      },
    }),
  };
  const tx = {
    set: (ref: { path: string }, data: Record<string, unknown>) =>
      writes.push({ path: ref.path, data }),
  } as any;
  mocks.dbFn.mockReturnValue(db);
  return { writes, tx };
}

describe('promoteQueuedNotification', () => {
  /**
   * THE DROP-OUT THIS CLOSES. All three sweeps built their promoted document
   * inline and all three copied only key/category/recipientUid/actorUid/data/
   * channels, silently losing title, description, actorName, actorPhotoUrl,
   * targetType and targetId. So the same event arriving by the debounced path
   * rendered as a bare catalog key with no Open button, while the trigger path
   * rendered a titled, clickable card. Nothing failed; the card was just poorer.
   */
  it('carries forward every field a card renders, including the ones the sweeps dropped', async () => {
    const { writes, tx } = promoterDb();
    const { promoteQueuedNotification } = await import('../src/notifications/promoteQueued');

    promoteQueuedNotification(
      tx,
      {
        key: 'kincare.upcoming.reminder',
        category: 'visit',
        recipientUid: 'u1',
        actorUid: 'a1',
        title: 'Upcoming KinCare visit',
        description: 'A visit is coming up.',
        actorName: 'Dana Ruiz',
        actorPhotoUrl: 'https://x/y.png',
        data: { bookingId: 'b1' },
        detail: { kinName: 'Rex', bookingDate: 'Mon, Jun 15' },
        targetType: 'booking',
        targetId: 'b1',
        channels: ['email', 'push'],
      },
      { mode: 'scheduled-promoted', origin: { originScheduledId: 's1' } },
    );

    const card = writes.find((w) => w.path.startsWith('notifications/'));
    expect(card!.data).toMatchObject({
      key: 'kincare.upcoming.reminder',
      title: 'Upcoming KinCare visit',
      description: 'A visit is coming up.',
      actorName: 'Dana Ruiz',
      actorPhotoUrl: 'https://x/y.png',
      detail: { kinName: 'Rex', bookingDate: 'Mon, Jun 15' },
      targetType: 'booking',
      targetId: 'b1',
    });
    // ...and carries none of the workflow.
    expect(card!.data.status).toBeUndefined();
    expect(card!.data.mode).toBeUndefined();
    expect(card!.data.channels).toBeUndefined();

    const order = writes.find((w) => w.path.startsWith('notificationDispatch/'));
    expect(order!.data).toMatchObject({
      mode: 'scheduled-promoted',
      status: 'pending',
      channels: ['email', 'push'],
      originScheduledId: 's1',
    });
    // Id-matched, so the pair is navigable without a query.
    expect(order!.path.slice('notificationDispatch/'.length)).toBe(
      card!.path.slice('notifications/'.length),
    );
  });

  it('omits `detail` entirely rather than writing an empty one', async () => {
    const { writes, tx } = promoterDb();
    const { promoteQueuedNotification } = await import('../src/notifications/promoteQueued');

    promoteQueuedNotification(tx, { key: 'k', recipientUid: 'u1' }, { mode: 'debounced-promoted' });

    const card = writes.find((w) => w.path.startsWith('notifications/'));
    expect('detail' in card!.data).toBe(false);
  });

  it('lets an override replace the queued value, which is how a digest rolls up', async () => {
    const { writes, tx } = promoterDb();
    const { promoteQueuedNotification } = await import('../src/notifications/promoteQueued');

    promoteQueuedNotification(
      tx,
      { key: 'kintale.comment.added', recipientUid: 'u1', data: { taleId: 't1' } },
      { mode: 'batched-promoted', overrides: { data: { itemCount: 3 } } },
    );

    const card = writes.find((w) => w.path.startsWith('notifications/'));
    expect(card!.data.data).toEqual({ itemCount: 3 });
  });
});
