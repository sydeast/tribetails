import { describe, it, expect, vi, beforeEach } from 'vitest';
import { buildDbMock } from './_helpers/mockDb';
import { CallableRequest } from 'firebase-functions/v2/https';

const mocks = vi.hoisted(() => ({ dbFn: vi.fn() }));
vi.mock('../src/lib/firestoreAdmin', () => ({ db: mocks.dbFn, auth: vi.fn(), getAdmin: vi.fn() }));
vi.mock('../src/lib/logger', () => ({ logEvent: vi.fn() }));
vi.mock('../src/lib/sentry', () => ({ initSentry: vi.fn() }));

import { unassignTemplateHandler } from '../src/admin/unassignTemplate';
import { logEvent } from '../src/lib/logger';

beforeEach(() => {
  mocks.dbFn.mockReset();
  (logEvent as any).mockClear();
});

function req(data: unknown, uid: string | null = 'admin1'): CallableRequest<unknown> {
  return {
    data,
    auth: uid ? ({ uid, token: {} as any } as any) : undefined,
    rawRequest: {} as any, instanceIdToken: undefined, acceptsStreaming: false,
  } as unknown as CallableRequest<unknown>;
}

function seed() {
  return buildDbMock({
    docs: {
      'notificationTemplateBindings/booking.confirmed': {
        catalogKey: 'booking.confirmed',
        templateId: 'tmpl_booking_ok',
        active: true,
      },
    },
  });
}

describe('unassignTemplate happy path', () => {
  it('deletes the binding doc and reports removed:true', async () => {
    const ctx = seed();
    mocks.dbFn.mockReturnValue(ctx.db);
    const res = await unassignTemplateHandler(req({ catalogKey: 'booking.confirmed' }));
    expect(res).toEqual({ catalogKey: 'booking.confirmed', removed: true });
    expect(ctx.deletes).toContain('notificationTemplateBindings/booking.confirmed');
  });

  it('logs an admin.template.unassigned event', async () => {
    const ctx = seed();
    mocks.dbFn.mockReturnValue(ctx.db);
    await unassignTemplateHandler(req({ catalogKey: 'booking.confirmed' }));
    expect(logEvent).toHaveBeenCalledWith(
      expect.objectContaining({ event: 'admin.template.unassigned', uid: 'admin1' }),
    );
  });
});

describe('unassignTemplate idempotency', () => {
  it('is a no-op success (removed:false, no delete) when the key was never bound', async () => {
    const ctx = seed();
    mocks.dbFn.mockReturnValue(ctx.db);
    const res = await unassignTemplateHandler(req({ catalogKey: 'never.bound' }));
    expect(res).toEqual({ catalogKey: 'never.bound', removed: false });
    expect(ctx.deletes).toHaveLength(0);
  });
});

describe('unassignTemplate validation + auth', () => {
  it('rejects a blank catalogKey (invalid-argument via zod)', async () => {
    mocks.dbFn.mockReturnValue(seed().db);
    await expect(unassignTemplateHandler(req({ catalogKey: '' }))).rejects.toBeTruthy();
  });

  it('rejects an unauthenticated caller', async () => {
    mocks.dbFn.mockReturnValue(seed().db);
    await expect(unassignTemplateHandler(req({ catalogKey: 'booking.confirmed' }, null))).rejects.toMatchObject({
      code: 'unauthenticated',
    });
  });
});
