import { describe, it, expect, vi, beforeEach } from 'vitest';

const mocks = vi.hoisted(() => ({
  enqueue: vi.fn(),
  resolveKinfolkUid: vi.fn(),
  logEvent: vi.fn(),
  staffDocs: {} as Record<string, Record<string, unknown> | undefined>,
  staffReadFails: false,
}));
vi.mock('../src/lib/firestoreAdmin', () => ({
  db: () => ({
    doc: (path: string) => ({
      get: async () => {
        if (mocks.staffReadFails) throw new Error('unavailable');
        const d = mocks.staffDocs[path];
        return { exists: d !== undefined, data: () => d };
      },
    }),
  }),
  auth: vi.fn(),
  getAdmin: vi.fn(),
}));
vi.mock('../src/lib/logger', () => ({ logEvent: mocks.logEvent }));
vi.mock('../src/lib/sentry', () => ({ initSentry: vi.fn(), captureFunctionError: vi.fn() }));
vi.mock('../src/lib/resolveKinfolkUid', () => ({ resolveKinfolkUid: mocks.resolveKinfolkUid }));
vi.mock('../src/notifications/dispatcher', () => ({ enqueueNotification: mocks.enqueue }));

import {
  noteWriterName,
  onBookingNoteCreateHandler,
  type BookingNoteCreateEvent,
} from '../src/triggers/onBookingNoteCreate';

beforeEach(() => {
  mocks.enqueue.mockReset().mockResolvedValue(['n1']);
  mocks.resolveKinfolkUid.mockReset().mockResolvedValue('primary1');
  mocks.logEvent.mockReset();
  mocks.staffDocs = {};
  mocks.staffReadFails = false;
});

const PARAMS = { kinfolkId: 'fam1', batchId: 'bat1', visitId: 'vis1', noteId: 'n1' };
const created = (note: Record<string, unknown> | undefined): BookingNoteCreateEvent => ({
  params: PARAMS,
  data: { data: () => note },
});
const sent = () => mocks.enqueue.mock.calls[0]![0] as Record<string, unknown> & { data: Record<string, unknown> };

describe('onBookingNoteCreate (#2277): the office note notice', () => {
  it("names the owner when she wrote it, and leaves her out", async () => {
    mocks.staffDocs['staff/owner1'] = { displayName: 'Nora Halbrook' };
    await onBookingNoteCreateHandler(created({ authorUid: 'owner1', authorRole: 'admin', body: 'Gate code changed.' }));
    expect(sent()).toMatchObject({
      key: 'kincare.note.auntie',
      actorUid: 'owner1',
      skipActorCopy: true,
      data: { actorName: 'Nora Halbrook', authorUid: 'owner1', visitId: 'vis1', preview: 'Gate code changed.' },
    });
  });

  it('names an Auntie when she wrote it, and leaves her out', async () => {
    mocks.staffDocs['staff/auntie1'] = { displayName: 'Mia Torres', staffRole: 'auntie' };
    await onBookingNoteCreateHandler(created({ authorUid: 'auntie1', authorRole: 'admin', body: 'All good.' }));
    expect(sent()).toMatchObject({ actorUid: 'auntie1', skipActorCopy: true, data: { actorName: 'Mia Torres' } });
  });

  it('an Auntie with no name on record reads "An Auntie", the owner "The office"', async () => {
    mocks.staffDocs['staff/auntie1'] = { staffRole: 'auntie' };
    await onBookingNoteCreateHandler(created({ authorUid: 'auntie1', authorRole: 'admin', body: 'x' }));
    expect(sent().data.actorName).toBe('An Auntie');
    mocks.enqueue.mockClear();
    await onBookingNoteCreateHandler(created({ authorUid: 'owner1', authorRole: 'admin', body: 'x' }));
    expect(sent().data.actorName).toBe('The office');
  });

  it('a failed staff read still sends the notice, with a fallback name', async () => {
    mocks.staffReadFails = true;
    await onBookingNoteCreateHandler(created({ authorUid: 'auntie1', authorRole: 'admin', body: 'x' }));
    expect(mocks.enqueue).toHaveBeenCalledTimes(1);
    expect(sent()).toMatchObject({ actorUid: 'auntie1', skipActorCopy: true, data: { actorName: 'The office' } });
    expect(mocks.logEvent).toHaveBeenCalledWith(expect.objectContaining({ event: 'note.writer.read.failed' }));
  });

  it('a household note is unchanged: kinfolk key, no writer left out, no name token', async () => {
    await onBookingNoteCreateHandler(created({ authorUid: 'primary1', authorRole: 'kinfolk', body: 'Water bowl.' }));
    const args = sent();
    expect(args.key).toBe('kincare.note.kinfolk');
    expect(args.actorUid).toBeUndefined();
    expect(args.skipActorCopy).toBeUndefined();
    expect(args.data.actorName).toBeUndefined();
  });

  it('a staff note with no author uid is still sent, with nobody left out', async () => {
    await onBookingNoteCreateHandler(created({ authorRole: 'admin', body: 'x' }));
    const args = sent();
    expect(args.skipActorCopy).toBeUndefined();
    expect(args.data.actorName).toBe('The office');
  });

  it('an unknown role or an empty doc sends nothing', async () => {
    await onBookingNoteCreateHandler(created({ authorUid: 'x', authorRole: 'guest', body: 'x' }));
    await onBookingNoteCreateHandler(created(undefined));
    expect(mocks.enqueue).not.toHaveBeenCalled();
  });

  it('a failed send is logged, never thrown', async () => {
    mocks.enqueue.mockRejectedValue(new Error('boom'));
    await expect(
      onBookingNoteCreateHandler(created({ authorUid: 'owner1', authorRole: 'admin', body: 'x' })),
    ).resolves.toBeUndefined();
    expect(mocks.logEvent).toHaveBeenCalledWith(expect.objectContaining({ event: 'notification.dispatch.failed' }));
  });
});

describe('noteWriterName', () => {
  it('never uses an email as a name', () => {
    expect(noteWriterName({ displayName: 'catch@hanasamku.com', staffRole: 'auntie' })).toBe('An Auntie');
    expect(noteWriterName({ displayName: '  ' })).toBe('The office');
    expect(noteWriterName(undefined)).toBe('The office');
    expect(noteWriterName({ displayName: ' Mia Torres ' })).toBe('Mia Torres');
  });
});
