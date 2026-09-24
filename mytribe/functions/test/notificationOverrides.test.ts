import { describe, it, expect, vi, beforeEach } from 'vitest';
import { buildDbMock } from './_helpers/mockDb';

const mocks = vi.hoisted(() => ({ dbFn: vi.fn() }));
vi.mock('../src/lib/firestoreAdmin', () => ({
  db: mocks.dbFn,
  auth: vi.fn(),
  getAdmin: vi.fn(),
}));
vi.mock('../src/lib/operatorAllowlist', () => ({
  isAuntieOperator: () => true,
  requireAuntieOperator: vi.fn(),
}));
vi.mock('firebase-admin/firestore', async () => {
  const actual = await vi.importActual<any>('firebase-admin/firestore');
  return {
    ...actual,
    FieldValue: { serverTimestamp: () => '__TS__', delete: () => '__DEL__' },
  };
});

beforeEach(() => mocks.dbFn.mockReset());

import {
  getBusinessNotificationOverridesHandler,
  saveBusinessNotificationOverrideHandler,
  deleteBusinessNotificationOverrideHandler,
} from '../src/admin/notificationOverrides';

describe('getBusinessNotificationOverridesHandler', () => {
  it('returns empty overrides + full catalog when doc missing', async () => {
    mocks.dbFn.mockReturnValue(buildDbMock().db);
    const res = await getBusinessNotificationOverridesHandler({
      data: {},
      auth: { uid: 'admin1', token: {} },
    } as any);
    expect(res.overrides).toEqual({});
    expect(res.catalog.length).toBeGreaterThan(20);
    expect(res.updatedAtMs).toBeNull();
  });

  it('returns existing byKey overrides', async () => {
    const ctx = buildDbMock({
      docs: {
        'businessSettings/notifications': {
          byKey: {
            'kintale.published': { enabled: true, channels: { sms: false } },
          },
          updatedAtMs: 1234,
        },
      },
    });
    mocks.dbFn.mockReturnValue(ctx.db);
    const res = await getBusinessNotificationOverridesHandler({
      data: {},
      auth: { uid: 'admin1', token: {} },
    } as any);
    expect(res.overrides['kintale.published']).toEqual({ enabled: true, channels: { sms: false } });
    expect(res.updatedAtMs).toBe(1234);
  });

  // Audience revamp 2026-07: the admin matrix needs each key's stream taxonomy.
  it('projects the audiences streams for every catalog row', async () => {
    mocks.dbFn.mockReturnValue(buildDbMock().db);
    const res = await getBusinessNotificationOverridesHandler({
      data: {},
      auth: { uid: 'admin1', token: {} },
    } as any);
    const byCatalogKey = Object.fromEntries(res.catalog.map((c: any) => [c.key, c]));
    expect(byCatalogKey['kincare.booking.confirm'].audiences).toEqual({ kinfolk: true, business: true });
    expect(byCatalogKey['kincare.note.kinfolk'].audiences).toEqual({ staff: true });
    expect(byCatalogKey['kintale.published'].audiences).toEqual({ kinfolk: true });
    for (const row of res.catalog) {
      expect(row.audiences, `${row.key} must project audiences`).toBeTruthy();
    }
  });

  // Audience revamp 2026-07: streams + lockReason are stored verbatim and must
  // round-trip through the getter untouched.
  it('returns streams + lockReason verbatim from the stored override', async () => {
    const stored = {
      enabled: true,
      channels: { sms: true },
      lockReason: 'Required for care coordination',
      streams: { kinfolk: { channels: { sms: false } }, business: { enabled: false } },
    };
    const ctx = buildDbMock({
      docs: {
        'businessSettings/notifications': { byKey: { 'kintale.published': stored }, updatedAtMs: 9 },
      },
    });
    mocks.dbFn.mockReturnValue(ctx.db);
    const res = await getBusinessNotificationOverridesHandler({
      data: {},
      auth: { uid: 'admin1', token: {} },
    } as any);
    expect(res.overrides['kintale.published']).toEqual(stored);
  });
});

/**
 * #396. The catalog DTO used to strip `recipientResolver`, `secondaryResolver`
 * and `templates`, so the only screen that lists every notification could not
 * say who any of them reaches or which template renders it. The operator's own
 * words were "we could be leaking info to the wrong ppl, but I have no idea".
 * These cases pin the answer onto the wire.
 */
describe('getBusinessNotificationOverridesHandler: provenance projection (#396)', () => {
  async function fetch() {
    mocks.dbFn.mockReturnValue(buildDbMock().db);
    return getBusinessNotificationOverridesHandler({
      data: {},
      auth: { uid: 'admin1', token: {} },
    } as any);
  }

  function row(res: Awaited<ReturnType<typeof fetch>>, key: string) {
    const found = res.catalog.find((c) => c.key === key);
    if (!found) throw new Error(`catalog row missing: ${key}`);
    return found;
  }

  it('gives every row a plain-English recipient rule, never a bare enum', async () => {
    const res = await fetch();
    for (const entry of res.catalog) {
      expect(entry.whoReceives.length).toBeGreaterThan(0);
      for (const sentence of entry.whoReceives) {
        expect(sentence).not.toBe(entry.recipientResolver);
        // A sentence, not an identifier: identifiers have no spaces.
        expect(sentence).toContain(' ');
      }
    }
  });

  it('names BOTH audiences on a row that fans out to two', async () => {
    const res = await fetch();
    const entry = row(res, 'invoice.new');
    expect(entry.secondaryResolver).toBe('businessAdmins');
    expect(entry.whoReceives).toHaveLength(2);
    expect(entry.whoReceives.join(' ')).toMatch(/admin/i);
  });

  it('carries the template id per channel so the body is findable', async () => {
    const res = await fetch();
    expect(row(res, 'invoice.new').templates.email).toBe('invoice.new');
    expect(row(res, 'kincare.booking.confirm').templates.sms).toBe('kincare.booking.confirm');
  });

  /**
   * The gate can retarget an email TODAY, as data, with no deploy: a write to
   * `notificationTemplateBindings/{templateId}` and `sendFromTemplate` renders a
   * different document. If this DTO kept projecting the catalog default, the
   * screen whose entire job is saying which template writes the message would
   * name the wrong one, on exactly the rows the operator had changed.
   */
  it('names the EFFECTIVE email template when a binding has retargeted it', async () => {
    const ctx = buildDbMock({
      queryDocs: {
        notificationTemplateBindings: [
          { id: 'invoice.new', data: { templateId: 'invoice.new.v2', active: true } },
        ],
      },
    });
    mocks.dbFn.mockReturnValue(ctx.db);
    const res = await getBusinessNotificationOverridesHandler({
      data: {},
      auth: { uid: 'admin1', token: {} },
    } as any);
    const entry = res.catalog.find((c) => c.key === 'invoice.new')!;
    expect(entry.templates.email).toBe('invoice.new.v2');
    expect(entry.emailTemplateRetargetedFrom).toBe('invoice.new');
    // SMS and push read def.templates directly and consult no bindings, which is
    // why retargeting those needs a deploy. They must not move.
    expect(entry.templates.sms).toBe('invoice.new');
  });
  it('ignores an inactive binding, because disabling one means revert not silence', async () => {
    const ctx = buildDbMock({
      queryDocs: {
        notificationTemplateBindings: [
          { id: 'invoice.new', data: { templateId: 'invoice.new.v2', active: false } },
        ],
      },
    });
    mocks.dbFn.mockReturnValue(ctx.db);
    const res = await getBusinessNotificationOverridesHandler({
      data: {},
      auth: { uid: 'admin1', token: {} },
    } as any);
    const entry = res.catalog.find((c) => c.key === 'invoice.new')!;
    expect(entry.templates.email).toBe('invoice.new');
    expect(entry.emailTemplateRetargetedFrom).toBeUndefined();
  });
  it('leaves an unretargeted row saying nothing about retargeting', async () => {
    const res = await fetch();
    expect(res.catalog.every((c) => c.emailTemplateRetargetedFrom === undefined)).toBe(true);
  });
  it('carries the merge fields a template can print', async () => {
    const res = await fetch();
    expect(row(res, 'invoice.new').mergeFields.length).toBeGreaterThan(0);
  });

  it('names what fires each row, in business terms and with a source file', async () => {
    const res = await fetch();
    const entry = row(res, 'kincare.booking.confirm');
    expect(entry.emitters.length).toBeGreaterThan(0);
    expect(entry.emitters[0].trigger).toMatch(/visit/i);
    expect(entry.emitters[0].source).toMatch(/^src\//);
    expect(entry.emitters[0].dataKeys).toContain('kinfolkId');
  });

  it('projects `neverFires`, and today `invoice.updated` is the one dead row', async () => {
    // `quote.accepted` was the standing example here: a row whose toggles were
    // decoration, because nothing sent it. #430 gave it and `quote.denied` a
    // real emitter in portal/quoteDecision.ts, so the badge must be off them
    // both. An operator told "Never fires" about a live row would leave it
    // switched on believing that changed nothing.
    //
    // #906 put exactly one row back on the badge: `invoice.updated`'s only
    // emitter was `postInvoiceEvent`'s arbitrary merge, and that merge is gone.
    // The badge is how the operator learns that toggling it changes nothing,
    // instead of finding out when an edit tells nobody.
    const res = await fetch();
    expect(res.catalog.filter((c) => c.neverFires === true).map((c) => c.key)).toEqual([
      'invoice.updated',
    ]);
    expect(row(res, 'quote.accepted').emitters.map((e) => e.source)).toEqual([
      'src/portal/quoteDecision.ts',
    ]);
    expect(row(res, 'quote.denied').emitters.map((e) => e.source)).toEqual([
      'src/portal/quoteDecision.ts',
    ]);
  });

  it('projects `external`, and only the password reset row is external', async () => {
    const res = await fetch();
    // The dispatcher skips fan-out entirely for an `external` row, so the gate's
    // switches control nothing on it and the admin says so. #905: the reset
    // trigger sends auth.password.reset itself (auth/requestPasswordReset.ts),
    // so no gate switch or override can stop a reset email.
    expect(res.catalog.filter((c) => c.external).map((c) => c.key)).toEqual(['auth.password.reset']);
  });

  it('lists the ungated mail the gate does NOT govern', async () => {
    const res = await fetch();
    const ids = res.ungated.map((u) => u.templateId);
    expect(ids).toContain('invite.primary');
    expect(ids).toContain('recovery.requested');
    expect(ids).toContain('error.daily-digest');
    for (const send of res.ungated) {
      expect(send.trigger).toContain(' ');
      expect(send.source).toMatch(/^src\//);
    }
  });

  it('reports the business-admin roster size, and does not write while reading it', async () => {
    const ctx = buildDbMock({
      docs: { 'businessSettings/admins': { uids: ['a', 'b', 'c'] } },
    });
    mocks.dbFn.mockReturnValue(ctx.db);
    const res = await getBusinessNotificationOverridesHandler({
      data: {},
      auth: { uid: 'admin1', token: {} },
    } as any);
    expect(res.businessAdminCount).toBe(3);
    expect(res.businessAdminRosterPath).toBe('businessSettings/admins.uids');
    // The dispatch-path resolver self-heals by WRITING the roster back from
    // AUNTIE_OPERATOR_UIDS. Opening a settings screen must never do that.
    expect(ctx.writes.filter((w) => w.path.startsWith('businessSettings/admins'))).toEqual([]);
  });

  it('still returns the whole matrix when the roster is empty', async () => {
    const res = await fetch();
    // An empty roster is a real, reportable state; the 44 rows the operator
    // came to read must not vanish because of it.
    expect(res.businessAdminCount).toBe(0);
    expect(res.catalog.length).toBeGreaterThan(20);
  });
});

describe('saveBusinessNotificationOverrideHandler', () => {
  it('writes override to businessSettings/notifications byKey map', async () => {
    const ctx = buildDbMock();
    mocks.dbFn.mockReturnValue(ctx.db);
    const res = await saveBusinessNotificationOverrideHandler({
      data: {
        key: 'kintale.published',
        override: { enabled: true, channels: { sms: false, push: true } },
      },
      auth: { uid: 'admin1', token: {} },
    } as any);
    expect(res).toEqual({ ok: true, key: 'kintale.published' });
    const w = ctx.writes.find((w) => w.path === 'businessSettings/notifications');
    expect(w).toBeDefined();
    expect(w!.merge).toBe(true);
    expect((w!.data.byKey as any)['kintale.published']).toEqual({
      enabled: true,
      channels: { sms: false, push: true },
    });
  });

  it('Run-4 #13: persists admin lockedEnabled + per-channel locked', async () => {
    const ctx = buildDbMock();
    mocks.dbFn.mockReturnValue(ctx.db);
    const res = await saveBusinessNotificationOverrideHandler({
      data: {
        key: 'kintale.published',
        override: {
          enabled: true,
          channels: { email: true, sms: false },
          lockedEnabled: true,
          locked: { email: true },
        },
      },
      auth: { uid: 'admin1', token: {} },
    } as any);
    expect(res).toEqual({ ok: true, key: 'kintale.published' });
    const w = ctx.writes.find((w) => w.path === 'businessSettings/notifications');
    expect((w!.data.byKey as any)['kintale.published']).toEqual({
      enabled: true,
      channels: { email: true, sms: false },
      lockedEnabled: true,
      locked: { email: true },
    });
  });

  // #7 (2026-06-08): warn-but-allow-off. The operator may now disable even an
  // alwaysEnabled notification or a catalog-required channel; the admin UI warns
  // first. The handler no longer rejects these.
  it('allows disabling an alwaysEnabled notification (warn-but-allow-off)', async () => {
    const ctx = buildDbMock();
    mocks.dbFn.mockReturnValue(ctx.db);
    const r = await saveBusinessNotificationOverrideHandler({
      data: { key: 'auth.password.reset', override: { enabled: false } },
      auth: { uid: 'admin1', token: {} },
    } as any);
    expect(r).toMatchObject({ ok: true, key: 'auth.password.reset' });
    expect(ctx.writes.some((w) => w.path === 'businessSettings/notifications')).toBe(true);
  });

  it('allows disabling a catalog-required channel (warn-but-allow-off)', async () => {
    const ctx = buildDbMock();
    mocks.dbFn.mockReturnValue(ctx.db);
    const r = await saveBusinessNotificationOverrideHandler({
      data: { key: 'invoice.new', override: { enabled: true, channels: { email: false } } },
      auth: { uid: 'admin1', token: {} },
    } as any);
    expect(r).toMatchObject({ ok: true, key: 'invoice.new' });
  });

  it('rejects unknown catalog keys', async () => {
    mocks.dbFn.mockReturnValue(buildDbMock().db);
    await expect(
      saveBusinessNotificationOverrideHandler({
        data: { key: 'made.up.key', override: { enabled: true } },
        auth: { uid: 'admin1', token: {} },
      } as any),
    ).rejects.toThrow(/unknown key/);
  });

  // Audience revamp 2026-07: per-stream overlays + operator lockReason.
  it('persists streams + trimmed lockReason verbatim (merge)', async () => {
    const ctx = buildDbMock();
    mocks.dbFn.mockReturnValue(ctx.db);
    const res = await saveBusinessNotificationOverrideHandler({
      data: {
        key: 'kincare.booking.confirm',
        override: {
          enabled: true,
          channels: { sms: true },
          lockReason: '  Bookings must reach you  ',
          streams: {
            kinfolk: { channels: { sms: false }, locked: { email: true } },
            business: { enabled: false },
          },
        },
      },
      auth: { uid: 'admin1', token: {} },
    } as any);
    expect(res).toEqual({ ok: true, key: 'kincare.booking.confirm' });
    const w = ctx.writes.find((w) => w.path === 'businessSettings/notifications');
    expect(w!.merge).toBe(true);
    expect((w!.data.byKey as any)['kincare.booking.confirm']).toEqual({
      enabled: true,
      channels: { sms: true },
      lockReason: 'Bookings must reach you',
      streams: {
        kinfolk: { channels: { sms: false }, locked: { email: true } },
        business: { enabled: false },
      },
    });
  });

  it('an empty (or whitespace-only) lockReason deletes the stored field', async () => {
    const ctx = buildDbMock();
    mocks.dbFn.mockReturnValue(ctx.db);
    await saveBusinessNotificationOverrideHandler({
      data: {
        key: 'kintale.published',
        override: { enabled: true, channels: {}, lockReason: '   ' },
      },
      auth: { uid: 'admin1', token: {} },
    } as any);
    const w = ctx.writes.find((w) => w.path === 'businessSettings/notifications');
    expect((w!.data.byKey as any)['kintale.published'].lockReason).toBe('__DEL__');
  });

  it('rejects a lockReason longer than 300 chars after trimming', async () => {
    mocks.dbFn.mockReturnValue(buildDbMock().db);
    await expect(
      saveBusinessNotificationOverrideHandler({
        data: {
          key: 'kintale.published',
          override: { enabled: true, channels: {}, lockReason: 'x'.repeat(301) },
        },
        auth: { uid: 'admin1', token: {} },
      } as any),
    ).rejects.toThrow();
  });

  it('rejects an unknown stream name', async () => {
    mocks.dbFn.mockReturnValue(buildDbMock().db);
    await expect(
      saveBusinessNotificationOverrideHandler({
        data: {
          key: 'kintale.published',
          override: { enabled: true, channels: {}, streams: { auntie: { enabled: false } } },
        },
        auth: { uid: 'admin1', token: {} },
      } as any),
    ).rejects.toThrow();
  });

  it('rejects unknown channels and non-true locked values inside a stream overlay', async () => {
    mocks.dbFn.mockReturnValue(buildDbMock().db);
    await expect(
      saveBusinessNotificationOverrideHandler({
        data: {
          key: 'kintale.published',
          override: { enabled: true, channels: {}, streams: { kinfolk: { channels: { fax: true } } } },
        },
        auth: { uid: 'admin1', token: {} },
      } as any),
    ).rejects.toThrow();
    await expect(
      saveBusinessNotificationOverrideHandler({
        data: {
          key: 'kintale.published',
          override: { enabled: true, channels: {}, streams: { kinfolk: { locked: { sms: false } } } },
        },
        auth: { uid: 'admin1', token: {} },
      } as any),
    ).rejects.toThrow();
  });
});

describe('deleteBusinessNotificationOverrideHandler', () => {
  it('clears the byKey entry for a catalog key', async () => {
    const ctx = buildDbMock();
    mocks.dbFn.mockReturnValue(ctx.db);
    await deleteBusinessNotificationOverrideHandler({
      data: { key: 'kintale.published' },
      auth: { uid: 'admin1', token: {} },
    } as any);
    const w = ctx.writes.find((w) => w.path === 'businessSettings/notifications');
    expect(w).toBeDefined();
    expect((w!.data.byKey as any)['kintale.published']).toBe('__DEL__');
  });
});
