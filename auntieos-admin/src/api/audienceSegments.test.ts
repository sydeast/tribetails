import { describe, it, expect, vi } from 'vitest';

const { callMock } = vi.hoisted(() => ({ callMock: vi.fn() }));
vi.mock('../lib/fns', () => ({ call: callMock }));

import { listAudienceSegments, saveAudienceSegment, deleteAudienceSegment } from './audienceSegments';

// NOTE: `callMock.mockReset()` runs at the top of EACH test body below, not in a
// shared `beforeEach`. Same deliberate deviation `api/invoicesWrite.test.ts`
// documents: resetting a `vi.hoisted` mock of a `vi.mock`'d LOCAL module from
// inside a `beforeEach`, in a test that both configures a rejection AND awaits
// it, makes Vitest misreport the genuinely-caught rejection as an unhandled
// error and fail a correct assertion. Moving the reset inline removes the
// trigger with no loss of isolation, since every test sets its own return value
// immediately after.


describe('listAudienceSegments', () => {
  it('calls the callable with an empty payload and returns the rows newest-updated first', async () => {
    callMock.mockReset();
    callMock.mockResolvedValue({
      ok: true,
      segments: [
        { id: 's1', name: 'Older', criteria: { kind: 'all' }, description: 'All active kinfolk', createdAtMs: 1, updatedAtMs: 10 },
        { id: 's2', name: 'Newer', criteria: { kind: 'all' }, description: 'All active kinfolk', createdAtMs: 2, updatedAtMs: 99 },
      ],
    });

    const rows = await listAudienceSegments();

    expect(callMock).toHaveBeenCalledWith('listAudienceSegments', {});
    expect(rows.map((r) => r.id)).toEqual(['s2', 's1']);
  });

  it('drops a row with no id, which could never be picked or deleted anyway', async () => {
    callMock.mockReset();
    callMock.mockResolvedValue({
      ok: true,
      segments: [{ id: '', name: 'Ghost', criteria: { kind: 'all' } }, { id: 's1', name: 'Real', criteria: { kind: 'all' } }],
    });
    expect((await listAudienceSegments()).map((r) => r.id)).toEqual(['s1']);
  });

  it('reads a missing updatedAtMs as 0 rather than crashing the sort', async () => {
    callMock.mockReset();
    callMock.mockResolvedValue({ ok: true, segments: [{ id: 's1', name: 'Real', criteria: { kind: 'all' } }] });
    expect((await listAudienceSegments())[0]?.updatedAtMs).toBe(0);
  });

  it('reads a missing segments array as empty rather than throwing on .map', async () => {
    callMock.mockReset();
    callMock.mockResolvedValue({ ok: true });
    expect(await listAudienceSegments()).toEqual([]);
  });

  it('never swallows a callable failure', async () => {
    callMock.mockReset();
    callMock.mockImplementation(() => Promise.reject(new Error('permission-denied')));
    await expect(listAudienceSegments()).rejects.toThrow('permission-denied');
  });
});

describe('saveAudienceSegment', () => {
  it('creates without an id and returns the new one', async () => {
    callMock.mockReset();
    callMock.mockResolvedValue({ ok: true, id: 'new-1' });
    const id = await saveAudienceSegment({ name: 'VIPs', criteria: { kind: 'tags', tags: ['vip'], tagMatch: 'any' } });
    expect(callMock).toHaveBeenCalledWith('saveAudienceSegment', {
      name: 'VIPs',
      criteria: { kind: 'tags', tags: ['vip'], tagMatch: 'any' },
    });
    expect(id).toBe('new-1');
  });

  it('updates in place when an id is supplied, rather than orphaning the old doc', async () => {
    callMock.mockReset();
    callMock.mockResolvedValue({ ok: true, id: 's1' });
    await saveAudienceSegment({ id: 's1', name: 'VIPs', criteria: { kind: 'all' } });
    expect(callMock).toHaveBeenCalledWith('saveAudienceSegment', { id: 's1', name: 'VIPs', criteria: { kind: 'all' } });
  });

  it('omits a blank id instead of sending one the zod min(1) would reject', async () => {
    callMock.mockReset();
    callMock.mockResolvedValue({ ok: true, id: 'new-1' });
    await saveAudienceSegment({ id: '  ', name: 'VIPs', criteria: { kind: 'all' } });
    expect('id' in (callMock.mock.calls[0]?.[1] as Record<string, unknown>)).toBe(false);
  });

  it('trims the name, since the server trims it before storing it anyway', async () => {
    callMock.mockReset();
    callMock.mockResolvedValue({ ok: true, id: 'new-1' });
    await saveAudienceSegment({ name: '  VIPs  ', criteria: { kind: 'all' } });
    expect((callMock.mock.calls[0]?.[1] as Record<string, unknown>)['name']).toBe('VIPs');
  });
});

describe('deleteAudienceSegment', () => {
  it('sends just the id', async () => {
    callMock.mockReset();
    callMock.mockResolvedValue({ ok: true, id: 's1' });
    await deleteAudienceSegment('s1');
    expect(callMock).toHaveBeenCalledWith('deleteAudienceSegment', { id: 's1' });
  });

  it('surfaces a not-found rather than reporting a delete that did not happen', async () => {
    callMock.mockReset();
    callMock.mockImplementation(() => Promise.reject(new Error('Audience segment s9 does not exist.')));
    await expect(deleteAudienceSegment('s9')).rejects.toThrow(/does not exist/);
  });
});
