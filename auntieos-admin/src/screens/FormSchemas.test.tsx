// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, beforeAll, afterAll } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { type FormSchemaSummary } from '../api/formSchemas';
import { type BusinessAdminRoster } from '../api/businessAdmins';

const { listFormSchemas, deleteFormSchema, listBusinessAdmins } = vi.hoisted(() => ({
  listFormSchemas: vi.fn(),
  deleteFormSchema: vi.fn(),
  listBusinessAdmins: vi.fn(),
}));
vi.mock('../api/formSchemas', async (orig) => ({
  ...(await orig<typeof import('../api/formSchemas')>()),
  listFormSchemas,
  deleteFormSchema,
}));
vi.mock('../api/businessAdmins', async (orig) => ({
  ...(await orig<typeof import('../api/businessAdmins')>()),
  listBusinessAdmins,
}));

import {
  FormSchemas,
  sortSchemas,
  filterSchemas,
  resolveUpdatedBy,
  DEFAULT_SORT,
  type SortState,
} from './FormSchemas';

function schema(over: Partial<FormSchemaSummary>): FormSchemaSummary {
  return {
    id: 'tribeProfile',
    name: 'Tribe Profile',
    appliesTo: 'NONE',
    version: 3,
    updatedAt: '2026-07-01T00:00:00Z',
    updatedBy: 'admin1',
    ...over,
  };
}

function roster(members: BusinessAdminRoster['members']): BusinessAdminRoster {
  return { members, source: 'roster', rosterPath: 'businessSettings/admins.uids', reason: null };
}

beforeEach(() => {
  listFormSchemas.mockReset();
  deleteFormSchema.mockReset();
  listBusinessAdmins.mockReset();
  // Every screen-level test gets a resolved-but-empty roster by default, so a
  // test that never mocks it does not hang waiting on a pending promise.
  listBusinessAdmins.mockResolvedValue(roster([]));
});

// updatedAt renders in the operator's LOCAL zone (AO-18), so every assertion
// on it would read differently on a UTC CI box than on a laptop. Pinned west
// of UTC so the local-vs-UTC difference is actually visible in the expected
// strings, the same discipline lib/formSchemaFormat.test.ts uses.
let originalTz: string | undefined;
beforeAll(() => {
  originalTz = process.env.TZ;
  process.env.TZ = 'America/Chicago';
});
afterAll(() => {
  if (originalTz === undefined) delete process.env.TZ;
  else process.env.TZ = originalTz;
});

const emptyRoster = new Map<string, string>();

describe('resolveUpdatedBy (pure)', () => {
  it('resolves a known uid to the roster email', () => {
    const map = new Map([['uid1', 'auntie@tribetails.example']]);
    expect(resolveUpdatedBy('uid1', map)).toBe('auntie@tribetails.example');
  });

  it('shortens an unresolved value that looks like a uid', () => {
    expect(resolveUpdatedBy('nppJNdMNYJfUigibGKUQj3n4obt2', emptyRoster)).toBe('nppJNdMN…');
  });

  it('shows a non-uid unresolved value verbatim (e.g. a seed script name)', () => {
    expect(resolveUpdatedBy('seed_phase14_schemas', emptyRoster)).toBe('seed_phase14_schemas');
  });

  it('is null for a blank or null updatedBy, never a placeholder string', () => {
    expect(resolveUpdatedBy(null, emptyRoster)).toBeNull();
    expect(resolveUpdatedBy('', emptyRoster)).toBeNull();
    expect(resolveUpdatedBy('   ', emptyRoster)).toBeNull();
  });
});

describe('sortSchemas (pure)', () => {
  const rows = [
    schema({ id: 'b', name: 'Bravo', version: 2, updatedAt: '2026-02-01T00:00:00.000Z', updatedBy: 'uid-b' }),
    schema({ id: 'a', name: 'Alpha', version: 4, updatedAt: '2026-04-01T00:00:00.000Z', updatedBy: 'uid-a' }),
    schema({ id: 'c', name: 'Charlie', version: 1, updatedAt: '2026-01-01T00:00:00.000Z', updatedBy: 'uid-c' }),
  ];

  it('defaults to Updated, descending (DEFAULT_SORT)', () => {
    expect(DEFAULT_SORT).toEqual<SortState>({ column: 'updatedAt', direction: 'desc' });
    expect(sortSchemas(rows, emptyRoster, DEFAULT_SORT).map((r) => r.id)).toEqual(['a', 'b', 'c']);
  });

  it('sorts by name, both directions', () => {
    expect(sortSchemas(rows, emptyRoster, { column: 'name', direction: 'asc' }).map((r) => r.id)).toEqual([
      'a',
      'b',
      'c',
    ]);
    expect(sortSchemas(rows, emptyRoster, { column: 'name', direction: 'desc' }).map((r) => r.id)).toEqual([
      'c',
      'b',
      'a',
    ]);
  });

  it('sorts by version numerically, both directions', () => {
    expect(sortSchemas(rows, emptyRoster, { column: 'version', direction: 'asc' }).map((r) => r.id)).toEqual([
      'c',
      'b',
      'a',
    ]);
    expect(sortSchemas(rows, emptyRoster, { column: 'version', direction: 'desc' }).map((r) => r.id)).toEqual([
      'a',
      'b',
      'c',
    ]);
  });

  it('sorts by updatedAt, both directions', () => {
    expect(sortSchemas(rows, emptyRoster, { column: 'updatedAt', direction: 'asc' }).map((r) => r.id)).toEqual([
      'c',
      'b',
      'a',
    ]);
    expect(sortSchemas(rows, emptyRoster, { column: 'updatedAt', direction: 'desc' }).map((r) => r.id)).toEqual([
      'a',
      'b',
      'c',
    ]);
  });

  it('sorts by updatedBy on the RESOLVED label, not the raw uid', () => {
    const emailByUid = new Map([
      ['uid-a', 'zed@tribetails.example'],
      ['uid-b', 'ann@tribetails.example'],
      ['uid-c', 'mid@tribetails.example'],
    ]);
    // Alphabetically by resolved email: ann (b), mid (c), zed (a).
    expect(sortSchemas(rows, emailByUid, { column: 'updatedBy', direction: 'asc' }).map((r) => r.id)).toEqual([
      'b',
      'c',
      'a',
    ]);
  });

  it('sorts a blank updatedAt last in BOTH directions', () => {
    const withBlank = [
      schema({ id: 'blank', updatedAt: null }),
      schema({ id: 'dated', updatedAt: '2026-01-01T00:00:00.000Z' }),
    ];
    expect(sortSchemas(withBlank, emptyRoster, { column: 'updatedAt', direction: 'asc' }).map((r) => r.id)).toEqual([
      'dated',
      'blank',
    ]);
    expect(sortSchemas(withBlank, emptyRoster, { column: 'updatedAt', direction: 'desc' }).map((r) => r.id)).toEqual([
      'dated',
      'blank',
    ]);
  });

  it('sorts a blank updatedBy last in BOTH directions', () => {
    const withBlank = [schema({ id: 'blank', updatedBy: null }), schema({ id: 'has', updatedBy: 'uid1' })];
    expect(sortSchemas(withBlank, emptyRoster, { column: 'updatedBy', direction: 'asc' }).map((r) => r.id)).toEqual([
      'has',
      'blank',
    ]);
    expect(sortSchemas(withBlank, emptyRoster, { column: 'updatedBy', direction: 'desc' }).map((r) => r.id)).toEqual([
      'has',
      'blank',
    ]);
  });

  it('never drops or duplicates a row, whatever the input classes are', () => {
    const mixed = [
      schema({ id: 'iso', updatedAt: '2026-08-02T10:15:00.000Z' }),
      schema({ id: 'null', updatedAt: null }),
      schema({ id: 'empty', updatedAt: '' }),
      schema({ id: 'junk', updatedAt: 'not-a-date' }),
    ];
    const out = sortSchemas(mixed, emptyRoster, DEFAULT_SORT);
    expect(out).toHaveLength(4);
    expect([...out.map((r) => r.id)].sort()).toEqual(['empty', 'iso', 'junk', 'null']);
  });

  it('does not mutate its input', () => {
    const copy = [...rows];
    sortSchemas(rows, emptyRoster, { column: 'name', direction: 'asc' });
    expect(rows).toEqual(copy);
  });
});

describe('filterSchemas (pure)', () => {
  const rows = [schema({ id: 'tribeProfile', name: 'Tribe Profile' }), schema({ id: 'vetInfo', name: 'Vet Info' })];

  it('is a no-op on a blank query', () => {
    expect(filterSchemas(rows, '  ')).toEqual(rows);
  });

  it('matches by name, case-insensitively', () => {
    expect(filterSchemas(rows, 'vet')).toEqual([rows[1]]);
  });

  it('matches by id', () => {
    expect(filterSchemas(rows, 'tribeprofile')).toEqual([rows[0]]);
  });
});

describe('FormSchemas screen', () => {
  it('loads and renders the table with a name, id, version, updated, and updated-by cell', async () => {
    listFormSchemas.mockResolvedValue([schema({})]);
    listBusinessAdmins.mockResolvedValue(
      roster([{ uid: 'admin1', email: 'auntie@tribetails.example', displayName: null, hasStaffRecord: true, defaultAssignee: false }]),
    );
    render(<FormSchemas />);
    expect(await screen.findByText('Tribe Profile')).toBeInTheDocument();
    expect(screen.getByText('tribeProfile')).toBeInTheDocument();
    // The mock's `.ver` is mono text in the Version column, not a capsule.
    const version = screen.getByText('v3');
    expect(version).toHaveClass('schemas__version');
    expect(version).not.toHaveClass('den-pill');
    // 2026-07-01T00:00:00Z is 2026-06-30 19:00 in America/Chicago (CDT, UTC-5).
    expect(screen.getByText('2026-06-30 19:00')).toBeInTheDocument();
    expect(await screen.findByText('auntie@tribetails.example')).toBeInTheDocument();
  });

  it('renders the table headers as sort controls, Updated active and descending by default', async () => {
    listFormSchemas.mockResolvedValue([schema({})]);
    render(<FormSchemas />);
    await screen.findByText('Tribe Profile');
    expect(screen.getByRole('columnheader', { name: /updated$/i })).toHaveAttribute('aria-sort', 'descending');
    expect(screen.getByRole('columnheader', { name: /^name/i })).toHaveAttribute('aria-sort', 'none');
    expect(screen.getByRole('columnheader', { name: /^version/i })).toHaveAttribute('aria-sort', 'none');
    expect(screen.getByRole('columnheader', { name: /updated by/i })).toHaveAttribute('aria-sort', 'none');
  });

  it('sorts by a column when its header is clicked, and flips direction on a second click', async () => {
    listFormSchemas.mockResolvedValue([
      schema({ id: 'b', name: 'Bravo', version: 2 }),
      schema({ id: 'a', name: 'Alpha', version: 4 }),
    ]);
    render(<FormSchemas />);
    await screen.findByText('Bravo');

    function bodyRowIds(): (string | null | undefined)[] {
      return screen.getAllByRole('row').slice(1).map((row) => row.querySelector('code')?.textContent);
    }

    await userEvent.click(screen.getByRole('button', { name: /^name/i }));
    expect(bodyRowIds()).toEqual(['a', 'b']);
    expect(screen.getByRole('columnheader', { name: /^name/i })).toHaveAttribute('aria-sort', 'ascending');

    await userEvent.click(screen.getByRole('button', { name: /^name/i }));
    expect(bodyRowIds()).toEqual(['b', 'a']);
    expect(screen.getByRole('columnheader', { name: /^name/i })).toHaveAttribute('aria-sort', 'descending');
  });

  it('selecting a new column starts it ascending', async () => {
    listFormSchemas.mockResolvedValue([
      schema({ id: 'lo', name: 'Lo', version: 1 }),
      schema({ id: 'hi', name: 'Hi', version: 9 }),
    ]);
    render(<FormSchemas />);
    await screen.findByText('Lo');
    await userEvent.click(screen.getByRole('button', { name: /^version/i }));
    const ids = screen.getAllByRole('row').slice(1).map((row) => row.querySelector('code')?.textContent);
    expect(ids).toEqual(['lo', 'hi']);
    expect(screen.getByRole('columnheader', { name: /^version/i })).toHaveAttribute('aria-sort', 'ascending');
  });

  it('renders a full local timestamp with the year, never the raw ISO instant', async () => {
    listFormSchemas.mockResolvedValue([
      schema({
        id: 'intake-household',
        name: 'Household intake',
        version: 4,
        updatedAt: '2026-08-02T10:15:00.000Z',
        updatedBy: 'e2e-admin',
      }),
    ]);
    render(<FormSchemas />);
    await screen.findByText('Household intake');
    expect(screen.getByText('2026-08-02 05:15')).toBeInTheDocument();
    expect(screen.queryByText(/2026-08-02T10:15:00\.000Z/)).toBeNull();
  });

  it('renders "-" for a blank updatedAt and a blank updatedBy, and still renders the row', async () => {
    listFormSchemas.mockResolvedValue([
      schema({ id: 'meet-and-greet', name: 'Meet and greet checklist', version: 1, updatedAt: null, updatedBy: null }),
    ]);
    render(<FormSchemas />);
    // The row survives: missing metadata must never cost the operator the schema.
    expect(await screen.findByText('Meet and greet checklist')).toBeInTheDocument();
    expect(screen.getAllByText('-')).toHaveLength(2);
  });

  it('sorts a blank-updatedAt row last by default', async () => {
    listFormSchemas.mockResolvedValue([
      schema({ id: 'draft', name: 'Draft', updatedAt: null, updatedBy: null }),
      schema({ id: 'dated', name: 'Dated', updatedAt: '2026-01-01T00:00:00.000Z', updatedBy: 'admin1' }),
    ]);
    render(<FormSchemas />);
    await screen.findByText('Dated');
    const ids = screen.getAllByRole('row').slice(1).map((row) => row.querySelector('code')?.textContent);
    expect(ids).toEqual(['dated', 'draft']);
  });

  it('shows a shortened uid when it does not resolve against the admin roster', async () => {
    listFormSchemas.mockResolvedValue([
      schema({ id: 'legacy', name: 'Legacy schema', updatedBy: 'nppJNdMNYJfUigibGKUQj3n4obt2' }),
    ]);
    listBusinessAdmins.mockResolvedValue(roster([]));
    render(<FormSchemas />);
    await screen.findByText('Legacy schema');
    expect(await screen.findByText('nppJNdMN…')).toBeInTheDocument();
  });

  it('renders the schemas list even when the admin roster fails to load', async () => {
    listFormSchemas.mockResolvedValue([schema({ id: 'tribeProfile', name: 'Tribe Profile', updatedBy: 'admin1' })]);
    listBusinessAdmins.mockRejectedValue(new Error('permission-denied'));
    render(<FormSchemas />);
    expect(await screen.findByText('Tribe Profile')).toBeInTheDocument();
    // Falls back to the raw value since it neither resolves nor looks like a uid.
    expect(screen.getByText('admin1')).toBeInTheDocument();
  });

  it('surfaces a load failure naming the callable, never a false empty list', async () => {
    listFormSchemas.mockRejectedValue(new Error('permission-denied'));
    render(<FormSchemas />);
    expect(await screen.findByText(/listFormSchemas failed: permission-denied/)).toBeInTheDocument();
    expect(screen.queryByText(/no schemas yet/i)).toBeNull();
  });

  it('retries the load on demand', async () => {
    listFormSchemas.mockRejectedValueOnce(new Error('offline')).mockResolvedValue([schema({})]);
    render(<FormSchemas />);
    await screen.findByText(/listFormSchemas failed/i);
    await userEvent.click(screen.getByRole('button', { name: /retry/i }));
    expect(await screen.findByText('Tribe Profile')).toBeInTheDocument();
    expect(listFormSchemas).toHaveBeenCalledTimes(2);
  });

  it('renders the proven-empty state, not while the load is failing', async () => {
    listFormSchemas.mockResolvedValue([]);
    render(<FormSchemas />);
    // The mock's `.panel`: the empty copy sits in the centred state box.
    expect(await screen.findByText(/no schemas yet/i)).toHaveClass('schemas__state');
  });
  it('draws the mock hero: the clipboard tile on the brand gradient before the kicker and title', async () => {
    listFormSchemas.mockResolvedValue([schema({})]);
    const { container } = render(<FormSchemas />);
    await screen.findByText('Tribe Profile');
    const heading = container.querySelector('.den-heading');
    expect(heading).not.toBeNull();
    expect(heading!.querySelector('.den-heading-kicker')).toHaveTextContent('The Den · Admin');
    expect(screen.getByRole('heading', { level: 1 })).toHaveTextContent('Form Schemas');
    const tile = heading!.querySelector('.den-heading-leading .icon-tile');
    expect(tile).not.toBeNull();
    expect(tile).toHaveClass('icon-tile-gradient');
    // Decorative: the tile restates the title and must not announce a second name.
    expect(tile).toHaveAttribute('aria-hidden', 'true');
    // The explanation is the heading's tooltip, never a line of copy.
    expect(screen.queryByText('Author the dynamic forms kinfolk fill out.')).toHaveAttribute('role', 'tooltip');
  });
  it('lays the mock controls row out: the filter box with its magnifier, then the count chip, then the table, then Reload', async () => {
    listFormSchemas.mockResolvedValue([schema({}), schema({ id: 'other', name: 'Other' })]);
    const { container } = render(<FormSchemas />);
    await screen.findByText('Tribe Profile');
    const controls = container.querySelector('.schemas__controls');
    expect(controls).not.toBeNull();
    const search = controls!.querySelector('.schemas__search');
    expect(search!.querySelector('svg')).not.toBeNull();
    expect(search!.querySelector('input')).toBe(screen.getByRole('searchbox', { name: /filter schemas/i }));
    expect(controls!.querySelector('.schemas__count')).toHaveTextContent('2 schemas');
    // Order on the ground: controls, table, footer. No DenPanel wraps any of it.
    const screenEl = container.querySelector('.screen')!;
    const order = Array.from(screenEl.querySelectorAll('.schemas__controls, .schemas__table-wrap, .schemas__footer')).map(
      (el) => el.className,
    );
    expect(order).toEqual(['schemas__controls', 'schemas__table-wrap', 'schemas__footer']);
    expect(container.querySelector('.den-panel')).toBeNull();
  });

  it('filters the visible rows by the search box', async () => {
    listFormSchemas.mockResolvedValue([
      schema({ id: 'tribeProfile', name: 'Tribe Profile' }),
      schema({ id: 'vetInfo', name: 'Vet Info' }),
    ]);
    render(<FormSchemas />);
    await screen.findByText('Tribe Profile');
    await userEvent.type(screen.getByLabelText(/filter schemas/i), 'vet');
    expect(screen.queryByText('Tribe Profile')).toBeNull();
    expect(screen.getByText('Vet Info')).toBeInTheDocument();
  });

  it('calls onSelect with the schema id when a row is activated', async () => {
    listFormSchemas.mockResolvedValue([schema({ id: 'tribeProfile' })]);
    const onSelect = vi.fn();
    render(<FormSchemas onSelect={onSelect} />);
    await userEvent.click(await screen.findByText('Tribe Profile'));
    expect(onSelect).toHaveBeenCalledWith('tribeProfile');
  });

  it('calls onNew when New schema is clicked', async () => {
    listFormSchemas.mockResolvedValue([]);
    const onNew = vi.fn();
    render(<FormSchemas onNew={onNew} />);
    await userEvent.click(await screen.findByRole('button', { name: /new schema/i }));
    expect(onNew).toHaveBeenCalledOnce();
  });

  it('renders New schema + rows STATIC (not a live no-op button) when unwired', async () => {
    // Fable blocker: with the route mounting <FormSchemas/> propless, a live "New
    // schema" button that silently does nothing is a dead control. When onNew/
    // onSelect are omitted the label must render, but NOT as an interactive button.
    listFormSchemas.mockResolvedValue([schema({})]);
    render(<FormSchemas />);
    await screen.findByText('Tribe Profile');
    expect(screen.getByText('New schema')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /new schema/i })).toBeNull();
    // The name cell is a plain <div> when unwired, not a focusable button (a
    // handler-less <button> would still carry the implicit button role). The
    // Delete icon button stays interactive, so assert the CELL element's tag
    // directly rather than a name query that "Delete Tribe Profile" would match.
    expect(screen.getByText('Tribe Profile').closest('.schemas__row-main')?.tagName).toBe('DIV');
  });

  it('confirms delete, calls deleteFormSchema, and reloads the list', async () => {
    listFormSchemas.mockResolvedValueOnce([schema({ id: 'tribeProfile', name: 'Tribe Profile' })]);
    listFormSchemas.mockResolvedValueOnce([]);
    deleteFormSchema.mockResolvedValue(undefined);
    render(<FormSchemas />);
    await screen.findByText('Tribe Profile');

    await userEvent.click(screen.getByRole('button', { name: /delete tribe profile/i }));
    expect(screen.getByRole('dialog')).toBeInTheDocument();
    expect(screen.getByText(/tribe profile \(v3\)/i)).toBeInTheDocument();

    await userEvent.click(screen.getByRole('button', { name: /delete schema/i }));

    await waitFor(() => expect(deleteFormSchema).toHaveBeenCalledWith('tribeProfile'));
    await waitFor(() => expect(listFormSchemas).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
  });

  it('cancels the delete confirm without calling deleteFormSchema', async () => {
    listFormSchemas.mockResolvedValue([schema({ id: 'tribeProfile', name: 'Tribe Profile' })]);
    render(<FormSchemas />);
    await screen.findByText('Tribe Profile');
    await userEvent.click(screen.getByRole('button', { name: /delete tribe profile/i }));
    await userEvent.click(screen.getByRole('button', { name: /^cancel$/i }));
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(deleteFormSchema).not.toHaveBeenCalled();
  });

  it('fails loud when deleteFormSchema rejects, naming the callable', async () => {
    listFormSchemas.mockResolvedValue([schema({ id: 'tribeProfile', name: 'Tribe Profile' })]);
    deleteFormSchema.mockRejectedValue(new Error("Schema 'tribeProfile' not found."));
    render(<FormSchemas />);
    await screen.findByText('Tribe Profile');
    await userEvent.click(screen.getByRole('button', { name: /delete tribe profile/i }));
    await userEvent.click(screen.getByRole('button', { name: /delete schema/i }));
    expect(await screen.findByText(/deleteFormSchema failed:.*not found/i)).toBeInTheDocument();
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('deleting a row does not activate onSelect for that row', async () => {
    listFormSchemas.mockResolvedValue([schema({ id: 'tribeProfile', name: 'Tribe Profile' })]);
    const onSelect = vi.fn();
    render(<FormSchemas onSelect={onSelect} />);
    await screen.findByText('Tribe Profile');
    await userEvent.click(screen.getByRole('button', { name: /delete tribe profile/i }));
    expect(onSelect).not.toHaveBeenCalled();
  });
});
