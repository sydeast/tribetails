import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { buildDbMock } from './_helpers/mockDb';

/**
 * #1987: a portal Home layout equal to the default is the default.
 *
 * The 2026-11-10 walk saved one Limit, then put it back. The four rows that
 * were left (every section on, standard order, no limits) stayed stored as an
 * explicit list, which the admin read as "Custom" and the portal read as "one
 * stacked column". The save stores such a list as the empty list, and
 * `getMyHome` answers with the empty list for a document stored before it did.
 *
 * The vectors below are the same cases the admin web, admin Android and both
 * portal clients pin in their own suites.
 */
const mocks = vi.hoisted(() => ({ dbFn: vi.fn(), logEvent: vi.fn(), writeAuditEntry: vi.fn() }));
vi.mock('../src/lib/firestoreAdmin', () => ({ db: mocks.dbFn, auth: vi.fn(), getAdmin: vi.fn() }));
vi.mock('../src/lib/logger', () => ({ logEvent: mocks.logEvent }));
vi.mock('../src/lib/writeAuditEntry', () => ({ writeAuditEntry: mocks.writeAuditEntry }));
vi.mock('../src/lib/sentry', () => ({
  captureFunctionError: vi.fn().mockReturnValue('s1'),
  initSentry: () => {},
}));
vi.mock('../src/lib/sessionRevocation', () => import('./_helpers/mockSessionRevocation'));

import { saveBusinessSettingsHandler } from '../src/admin/saveBusinessSettings';
import { getMyHomeHandler } from '../src/portal/getMyHome';
import {
  DEFAULT_HOME_SECTION_IDS,
  isDefaultHomeLayout,
  withDefaultHomeLayoutCollapsed,
} from '../src/lib/homeLayout';

const PATH = 'business_settings/business_settings';

type Row = { id: string; enabled?: boolean; limit?: number };
const row = (id: string, enabled = true, limit = 0): Row => ({ id, enabled, limit });
/** Every section on, standard order, no limits: the default written out in full. */
const DEFAULT_ROWS: Row[] = DEFAULT_HOME_SECTION_IDS.map((id) => row(id));
/** The walk's step 2: only the Up next Limit differs. */
const LIMIT_ONLY: Row[] = DEFAULT_ROWS.map((r) => (r.id === 'upNext' ? { ...r, limit: 2 } : r));
/** A real custom order: Quick start moved to the top. */
const CUSTOM_ORDER: Row[] = [row('quickStart'), row('liveVisit'), row('upNext'), row('tales')];

let ctx: ReturnType<typeof buildDbMock>;
function setup(stored: Record<string, unknown>) {
  ctx = buildDbMock({
    writeThrough: true,
    docs: {
      [PATH]: stored,
      'clients/u1': { kinfolkIds: ['demo-1'] },
      'families/demo-1': { displayName: 'The Foster' },
    },
  });
  mocks.dbFn.mockReturnValue(ctx.db);
}
const owner = (changes: Record<string, unknown>) =>
  ({
    data: { changes },
    auth: { uid: 'owner-1', token: { admin: true, email: 'e2e-admin@tribetails.com' } },
  }) as never;
const settingsWrites = () => ctx.writes.filter((w: { path: string }) => w.path === PATH);
const saveLayout = (sections: unknown) =>
  saveBusinessSettingsHandler(owner({ mytribePortal: { home: { sections } } }));
async function storedSectionsAfter(sections: unknown): Promise<unknown> {
  await saveLayout(sections);
  const [w] = settingsWrites();
  return (w!.data['mytribePortal'] as { home: { sections: unknown } }).home.sections;
}
async function portalHome(): Promise<unknown> {
  const res = await getMyHomeHandler({ data: { kinfolkId: 'demo-1' }, auth: { uid: 'u1' } } as never);
  return res.portal.home;
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubEnv('CLOUDINARY_CLOUD_NAME', 'tribetails');
  vi.stubEnv('AUNTIE_OPERATOR_UIDS', '');
  mocks.writeAuditEntry.mockResolvedValue('audit-1');
  setup({ businessName: 'Tribe Tails', timeZone: 'America/Chicago' });
});
afterEach(() => {
  vi.unstubAllEnvs();
});

describe('isDefaultHomeLayout', () => {
  it('is true for the empty list and for the four default rows written out', () => {
    expect(isDefaultHomeLayout([])).toBe(true);
    expect(isDefaultHomeLayout(DEFAULT_ROWS)).toBe(true);
  });
  it('reads a row with no enabled as on and a row with no limit as unlimited', () => {
    expect(isDefaultHomeLayout(DEFAULT_HOME_SECTION_IDS.map((id) => ({ id })))).toBe(true);
  });
  it('is false as soon as a limit, a switch or the order differs', () => {
    expect(isDefaultHomeLayout(LIMIT_ONLY)).toBe(false);
    expect(isDefaultHomeLayout(DEFAULT_ROWS.map((r) => (r.id === 'tales' ? { ...r, enabled: false } : r)))).toBe(false);
    expect(isDefaultHomeLayout(CUSTOM_ORDER)).toBe(false);
  });
  it('never calls a list with a row it does not know the default', () => {
    // Collapsing any of these would throw a visible row away.
    expect(isDefaultHomeLayout([...DEFAULT_ROWS, row('roster')])).toBe(false);
    expect(isDefaultHomeLayout([...DEFAULT_ROWS.slice(0, 3), row('roster'), row('quickStart')])).toBe(false);
    expect(isDefaultHomeLayout([...DEFAULT_ROWS, row('somethingNew')])).toBe(false);
    expect(isDefaultHomeLayout([...DEFAULT_ROWS, row('tales')])).toBe(false);
    expect(isDefaultHomeLayout([row('liveVisit'), row('upNext'), row('tales'), row('')])).toBe(false);
    expect(isDefaultHomeLayout(DEFAULT_ROWS.slice(0, 3))).toBe(false);
  });
  it('is false for anything that is not a list of rows', () => {
    expect(isDefaultHomeLayout(undefined)).toBe(false);
    expect(isDefaultHomeLayout('liveVisit')).toBe(false);
    expect(isDefaultHomeLayout(['liveVisit', 'upNext', 'tales', 'quickStart'])).toBe(false);
    expect(isDefaultHomeLayout(DEFAULT_ROWS.map((r) => ({ ...r, limit: '0' })))).toBe(false);
  });
});

describe('withDefaultHomeLayoutCollapsed', () => {
  it('leaves a patch with no Home layout, and the patch it was given, alone', () => {
    const changes = { businessEmail: 'e2e-admin@tribetails.com', mytribePortal: { themeId: '' } };
    expect(withDefaultHomeLayoutCollapsed(changes)).toBe(changes);
    const withLayout = { mytribePortal: { themeId: '', home: { sections: DEFAULT_ROWS } } };
    const out = withDefaultHomeLayoutCollapsed(withLayout);
    expect(out).toEqual({ mytribePortal: { themeId: '', home: { sections: [] } } });
    expect(withLayout.mytribePortal.home.sections).toBe(DEFAULT_ROWS);
  });
});

describe('saveBusinessSettings stores a default-equal Home layout as the default', () => {
  it('a limit-only change is stored as written, so the cap is kept', async () => {
    expect(await storedSectionsAfter(LIMIT_ONLY)).toEqual(LIMIT_ONLY);
  });

  it('putting every value back stores the empty list, not four rows', async () => {
    setup({ businessName: 'Tribe Tails', mytribePortal: { home: { sections: LIMIT_ONLY } } });
    expect(await storedSectionsAfter(DEFAULT_ROWS)).toEqual([]);
    const [w] = settingsWrites();
    expect((w!.options?.mergeFields ?? []).map(String)).toContain('mytribePortal.home.sections');
  });

  it('a real custom order is stored exactly as sent', async () => {
    expect(await storedSectionsAfter(CUSTOM_ORDER)).toEqual(CUSTOM_ORDER);
  });

  it('a hidden section is stored exactly as sent', async () => {
    const hidden = DEFAULT_ROWS.map((r) => (r.id === 'tales' ? { ...r, enabled: false } : r));
    expect(await storedSectionsAfter(hidden)).toEqual(hidden);
  });

  it('keeps a list with a row it does not know, rather than dropping the row', async () => {
    const withRoster = [...DEFAULT_ROWS, row('roster')];
    expect(await storedSectionsAfter(withRoster)).toEqual(withRoster);
  });

  it('collapses the layout and leaves the rest of the portal slice as sent', async () => {
    await saveBusinessSettingsHandler(
      owner({
        mytribePortal: { themeId: '', chat: { enabled: false }, home: { sections: DEFAULT_ROWS } },
      }),
    );
    const [w] = settingsWrites();
    expect(w!.data['mytribePortal']).toEqual({
      themeId: '',
      chat: { enabled: false },
      home: { sections: [] },
    });
  });

  it('still refuses a bad limit by name before any collapsing, and writes nothing', async () => {
    const bad = DEFAULT_ROWS.map((r) => (r.id === 'upNext' ? { ...r, limit: -1 } : r));
    await expect(saveLayout(bad)).rejects.toMatchObject({
      code: 'invalid-argument',
      message: 'Enter a limit of 0 or more, as a whole number. 0 shows everything.',
    });
    expect(settingsWrites()).toHaveLength(0);
  });
});

describe('getMyHome answers a stored default-equal layout as the default', () => {
  it('four default rows already in the document go out as the empty list', async () => {
    setup({ mytribePortal: { home: { sections: DEFAULT_ROWS } } });
    expect(await portalHome()).toEqual([]);
  });

  it('a limit-only layout goes out with its limit', async () => {
    setup({ mytribePortal: { home: { sections: LIMIT_ONLY } } });
    expect(await portalHome()).toEqual(LIMIT_ONLY);
  });

  it('a real custom order goes out in that order', async () => {
    setup({ mytribePortal: { home: { sections: CUSTOM_ORDER } } });
    expect(await portalHome()).toEqual(CUSTOM_ORDER);
  });

  it('no layout at all is the empty list', async () => {
    setup({ businessName: 'Tribe Tails' });
    expect(await portalHome()).toEqual([]);
  });
});
