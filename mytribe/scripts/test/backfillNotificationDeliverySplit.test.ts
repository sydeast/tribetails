import { describe, it, expect } from 'vitest';
import {
  parseArgs,
  planForNotification,
} from '../backfillNotificationDeliverySplit';

/**
 * The R5 relocation script's decision half.
 *
 * The migration DECISION (relocate the legacy delivery state to the work-order
 * collection; do NOT replay it as activity_log entries, because writeAuditEntry
 * timestamps at write time and the hash chain is append-only, so a replay would
 * bury the real audit trail under tens of thousands of entries claiming to have
 * happened today) is argued in the script's own docstring. What is testable here
 * is the per-document plan and the safety contract, so that is what this covers.
 */

describe('backfillNotificationDeliverySplit: per-document plan', () => {
  it('moves every workflow field off a legacy notification', () => {
    const plan = planForNotification(
      'n1',
      {
        key: 'kincare.booking.confirm',
        recipientUid: 'u1',
        title: 'Booking confirmed',
        status: 'dispatched',
        mode: 'trigger',
        channels: ['email', 'sms'],
        dispatchedAt: 'ts',
      },
      ['email', 'sms'],
    );

    expect(plan).not.toBeNull();
    expect(Object.keys(plan!.moved).sort()).toEqual([
      'channels',
      'dispatchedAt',
      'mode',
      'status',
    ]);
    expect(plan!.channelDocs).toEqual(['email', 'sms']);
  });

  it('moves the sweeps’ origin stamps too, because provenance is dispatch state', () => {
    const plan = planForNotification(
      'n1',
      { status: 'dispatched', originScheduledId: 's1', scheduledFireAtMs: 123 },
      [],
    );

    expect(Object.keys(plan!.moved).sort()).toEqual([
      'originScheduledId',
      'scheduledFireAtMs',
      'status',
    ]);
  });

  /**
   * IDEMPOTENCE, which is what makes a re-run safe. A doc already in the new
   * shape yields no plan at all, so the second pass reports zero writes rather
   * than restamping every notification in the collection.
   */
  it('returns no plan for a notification already in the split shape', () => {
    expect(
      planForNotification(
        'n1',
        { key: 'k', recipientUid: 'u1', title: 'T', detail: { kinName: 'Rex' } },
        [],
      ),
    ).toBeNull();
  });

  it('still plans a move for a doc whose fields are gone but whose channel subdocs remain', () => {
    // A half-migrated doc (fields stripped, subdocs not yet copied) must not be
    // mistaken for a finished one, or those subdocs are stranded forever.
    const plan = planForNotification('n1', { key: 'k' }, ['email']);
    expect(plan).not.toBeNull();
    expect(plan!.moved).toEqual({});
    expect(plan!.channelDocs).toEqual(['email']);
  });

  it('never treats content fields as workflow', () => {
    expect(
      planForNotification(
        'n1',
        {
          key: 'k',
          category: 'visit',
          recipientUid: 'u1',
          title: 'T',
          description: 'D',
          actorName: 'Dana',
          data: { bookingId: 'b1' },
          targetType: 'booking',
          targetId: 'b1',
          readAt: 'ts',
          archivedAt: null,
        },
        [],
      ),
    ).toBeNull();
  });
});

describe('backfillNotificationDeliverySplit: argument contract', () => {
  it('defaults to a dry run, like every other backfill in this tree', () => {
    expect(parseArgs([])).toMatchObject({ mode: 'dry-run', allowProd: false });
  });

  it('only writes when --allow-prod is passed explicitly', () => {
    expect(parseArgs(['--allow-prod'])).toMatchObject({ mode: 'apply', allowProd: true });
  });

  it('accepts a project and a page size', () => {
    expect(parseArgs(['--project', 'p1', '--page-size', '50'])).toMatchObject({
      projectId: 'p1',
      pageSize: 50,
    });
  });

  it('ignores a nonsense page size rather than paging by zero forever', () => {
    expect(parseArgs(['--page-size', 'banana']).pageSize).toBe(300);
    expect(parseArgs(['--page-size', '0']).pageSize).toBe(300);
  });
});
