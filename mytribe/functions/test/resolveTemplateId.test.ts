import { describe, it, expect, vi, beforeEach } from 'vitest';
import { buildDbMock } from './_helpers/mockDb';

const mocks = vi.hoisted(() => ({ dbFn: vi.fn() }));
vi.mock('../src/lib/firestoreAdmin', () => ({ db: mocks.dbFn, auth: vi.fn(), getAdmin: vi.fn() }));
vi.mock('../src/lib/email', () => ({ sendTemplatedEmail: vi.fn() }));
beforeEach(() => mocks.dbFn.mockReset());

import { resolveTemplateId } from '../src/lib/sendFromTemplate';

describe('resolveTemplateId', () => {
  it('falls back to catalog key when no binding exists', async () => {
    const ctx = buildDbMock({});
    mocks.dbFn.mockReturnValue(ctx.db);
    const id = await resolveTemplateId('kincare.booking.confirm');
    expect(id).toBe('kincare.booking.confirm');
  });

  it('returns bound templateId when binding active', async () => {
    const ctx = buildDbMock({
      docs: {
        'notificationTemplateBindings/kincare.booking.confirm': {
          templateId: 'welcome.kinfolk.v2',
          active: true,
        },
      },
    });
    mocks.dbFn.mockReturnValue(ctx.db);
    const id = await resolveTemplateId('kincare.booking.confirm');
    expect(id).toBe('welcome.kinfolk.v2');
  });

  it('falls back to catalog key when binding inactive (revert-to-default semantics)', async () => {
    const ctx = buildDbMock({
      docs: {
        'notificationTemplateBindings/kincare.booking.confirm': {
          templateId: 'welcome.kinfolk.v2',
          active: false,
        },
      },
    });
    mocks.dbFn.mockReturnValue(ctx.db);
    const id = await resolveTemplateId('kincare.booking.confirm');
    expect(id).toBe('kincare.booking.confirm');
  });

  it('falls back to catalog key when binding exists but templateId missing', async () => {
    const ctx = buildDbMock({
      docs: {
        'notificationTemplateBindings/cat.k': { active: true },
      },
    });
    mocks.dbFn.mockReturnValue(ctx.db);
    const id = await resolveTemplateId('cat.k');
    expect(id).toBe('cat.k');
  });
});
