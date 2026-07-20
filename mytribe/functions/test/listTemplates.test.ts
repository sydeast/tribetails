import { describe, it, expect, vi, beforeEach } from 'vitest';
import { buildDbMock } from './_helpers/mockDb';
import { CallableRequest } from 'firebase-functions/v2/https';

const mocks = vi.hoisted(() => ({ dbFn: vi.fn() }));
vi.mock('../src/lib/firestoreAdmin', () => ({ db: mocks.dbFn, auth: vi.fn(), getAdmin: vi.fn() }));
vi.mock('../src/lib/sentry', () => ({ initSentry: vi.fn() }));
beforeEach(() => mocks.dbFn.mockReset());

import { listTemplatesHandler } from '../src/admin/listTemplates';

function req(data: unknown = {}, uid: string | undefined = 'admin1'): CallableRequest<unknown> {
  return {
    data,
    auth: uid ? { uid, token: { admin: true } as any } : undefined,
    rawRequest: {} as any,
    instanceIdToken: undefined,
    acceptsStreaming: false,
  } as unknown as CallableRequest<unknown>;
}

/** Seed the emailTemplates collection with the given rows. */
function seed(rows: Array<{ id: string; data: Record<string, unknown> }>) {
  return buildDbMock({ queryDocs: { emailTemplates: rows } }).db;
}

describe('listTemplates', () => {
  it('HAPPY: returns every doc mapped to the summary shape, nextCursor null when unbounded', async () => {
    mocks.dbFn.mockReturnValue(
      seed([
        { id: 'booking.confirmed', data: { subject: 'S', body: 'B', category: 'Booking' } },
        { id: 'invoice.reminder', data: { subject: 'S2', body: 'B2' } },
      ]),
    );
    const res = await listTemplatesHandler(req());
    expect(res.nextCursor).toBeNull();
    expect(res.templates).toHaveLength(2);
    expect(res.templates[0]).toMatchObject({ templateId: 'booking.confirmed', category: 'Booking' });
  });

  it('I9: defaults usageInstructions/sectionDefinitions for docs that lack them', async () => {
    mocks.dbFn.mockReturnValue(seed([{ id: 't1', data: { subject: 'S', body: 'B' } }]));
    const res = await listTemplatesHandler(req());
    expect(res.templates[0]).toMatchObject({ usageInstructions: '', sectionDefinitions: [] });
  });

  it('I9: returns usageInstructions/sectionDefinitions when present, normalizing each section', async () => {
    mocks.dbFn.mockReturnValue(
      seed([
        {
          id: 't1',
          data: {
            subject: 'S',
            body: 'B',
            usageInstructions: 'Use after first visit.',
            sectionDefinitions: [{ title: 'Greeting', description: 'Hello' }, { title: 'Body' }],
          },
        },
      ]),
    );
    const res = await listTemplatesHandler(req());
    expect(res.templates[0]?.usageInstructions).toBe('Use after first visit.');
    expect(res.templates[0]?.sectionDefinitions).toEqual([
      { title: 'Greeting', description: 'Hello' },
      { title: 'Body', description: '' },
    ]);
  });

  it('I8: a full page (docs.length === limit) hands back the last id as nextCursor', async () => {
    mocks.dbFn.mockReturnValue(
      seed([
        { id: 'a', data: { subject: 'S', body: 'B' } },
        { id: 'b', data: { subject: 'S', body: 'B' } },
      ]),
    );
    const res = await listTemplatesHandler(req({ limit: 2 }));
    expect(res.templates).toHaveLength(2);
    expect(res.nextCursor).toBe('b');
  });

  it('I8: a short page (fewer than the limit) exhausts the list, nextCursor null', async () => {
    mocks.dbFn.mockReturnValue(seed([{ id: 'a', data: { subject: 'S', body: 'B' } }]));
    const res = await listTemplatesHandler(req({ limit: 50 }));
    expect(res.nextCursor).toBeNull();
  });

  it('I8: accepts a startAfter cursor (does not throw when paging forward)', async () => {
    mocks.dbFn.mockReturnValue(seed([{ id: 'c', data: { subject: 'S', body: 'B' } }]));
    const res = await listTemplatesHandler(req({ limit: 50, startAfter: 'b' }));
    expect(res.templates[0]?.templateId).toBe('c');
  });

  it('SAD: an invalid limit (0) is rejected', async () => {
    mocks.dbFn.mockReturnValue(seed([]));
    await expect(listTemplatesHandler(req({ limit: 0 }))).rejects.toThrow();
  });

  it('SAD: unauthenticated rejected', async () => {
    mocks.dbFn.mockReturnValue(seed([]));
    await expect(
      listTemplatesHandler({ data: {} } as CallableRequest<unknown>),
    ).rejects.toThrow();
  });
});
