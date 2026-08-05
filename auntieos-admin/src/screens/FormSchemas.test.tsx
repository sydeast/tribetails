// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, beforeAll, afterAll } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { type FormSchemaSummary } from '../api/formSchemas';

const { listFormSchemas, deleteFormSchema } = vi.hoisted(() => ({
  listFormSchemas: vi.fn(),
  deleteFormSchema: vi.fn(),
}));
vi.mock('../api/formSchemas', async (orig) => ({
  ...(await orig<typeof import('../api/formSchemas')>()),
  listFormSchemas,
  deleteFormSchema,
}));

import { FormSchemas, sortByUpdatedAtDesc, filterSchemas, metaLine } from './FormSchemas';

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

beforeEach(() => {
  listFormSchemas.mockReset();
  deleteFormSchema.mockReset();
});

// The meta line renders `updatedAt` in the operator's LOCAL zone (AO-18), so
// every assertion on it would read differently on a UTC CI box than on a
// laptop. Pinned west of UTC so the local-vs-UTC difference is actually
// visible in the expected strings, the same discipline
// lib/formSchemaFormat.test.ts and lib/tribalIntelFormat.test.ts use.
let originalTz: string | undefined;
beforeAll(() => {
  originalTz = process.env.TZ;
  process.env.TZ = 'America/Chicago';
});
afterAll(() => {
  if (originalTz === undefined) delete process.env.TZ;
  else process.env.TZ = originalTz;
});

describe('sortByUpdatedAtDesc (pure)', () => {
  it('orders most-recently-updated first', () => {
    const older = schema({ id: 'a', updatedAt: '2026-01-01T00:00:00Z' });
    const newer = schema({ id: 'b', updatedAt: '2026-06-01T00:00:00Z' });
    expect(sortByUpdatedAtDesc([older, newer])).toEqual([newer, older]);
  });

  it('sorts null updatedAt last regardless of direction', () => {
    const blank = schema({ id: 'blank', updatedAt: null });
    const dated = schema({ id: 'dated', updatedAt: '2026-01-01T00:00:00Z' });
    expect(sortByUpdatedAtDesc([blank, dated])).toEqual([dated, blank]);
    expect(sortByUpdatedAtDesc([dated, blank])).toEqual([dated, blank]);
  });

  // The string compare is only sound because `listFormSchemas` normalises every
  // non-null value to a fixed-width `YYYY-MM-DDTHH:mm:ss.sssZ` instant (see the
  // write-path audit in lib/formSchemaFormat.ts). These pin the shape the sort
  // depends on, over the digit positions a byte compare could plausibly get
  // wrong: a single-digit month/day, and a difference that lives only in the
  // clock or the milliseconds.
  it('orders full ISO instants chronologically at every digit position', () => {
    const rows = [
      schema({ id: 'sep', updatedAt: '2026-09-01T00:00:00.000Z' }),
      schema({ id: 'jan', updatedAt: '2026-01-31T23:59:59.999Z' }),
      schema({ id: 'oct', updatedAt: '2026-10-01T00:00:00.000Z' }),
      schema({ id: 'lastYear', updatedAt: '2025-12-31T23:59:59.999Z' }),
    ];
    expect(sortByUpdatedAtDesc(rows).map((r) => r.id)).toEqual(['oct', 'sep', 'jan', 'lastYear']);
  });

  it('separates two instants that differ only in the clock, and only in the millis', () => {
    const rows = [
      schema({ id: 'early', updatedAt: '2026-08-02T09:15:00.000Z' }),
      schema({ id: 'late', updatedAt: '2026-08-02T10:15:00.000Z' }),
      schema({ id: 'latest', updatedAt: '2026-08-02T10:15:00.001Z' }),
    ];
    expect(sortByUpdatedAtDesc(rows).map((r) => r.id)).toEqual(['latest', 'late', 'early']);
  });

  it('treats an empty-string updatedAt as blank, not as the earliest instant', () => {
    const empty = schema({ id: 'empty', updatedAt: '' });
    const dated = schema({ id: 'dated', updatedAt: '2026-01-01T00:00:00.000Z' });
    expect(sortByUpdatedAtDesc([empty, dated]).map((r) => r.id)).toEqual(['dated', 'empty']);
  });

  it('never drops or duplicates a row, whatever the input classes are', () => {
    const rows = [
      schema({ id: 'iso', updatedAt: '2026-08-02T10:15:00.000Z' }),
      schema({ id: 'null', updatedAt: null }),
      schema({ id: 'empty', updatedAt: '' }),
      schema({ id: 'junk', updatedAt: 'not-a-date' }),
    ];
    const out = sortByUpdatedAtDesc(rows);
    expect(out).toHaveLength(4);
    expect([...out.map((r) => r.id)].sort()).toEqual(['empty', 'iso', 'junk', 'null']);
  });

  it('does not mutate its input', () => {
    const rows = [
      schema({ id: 'a', updatedAt: '2026-01-01T00:00:00.000Z' }),
      schema({ id: 'b', updatedAt: '2026-06-01T00:00:00.000Z' }),
    ];
    sortByUpdatedAtDesc(rows);
    expect(rows.map((r) => r.id)).toEqual(['a', 'b']);
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

describe('metaLine (pure)', () => {
  it('joins version, the FORMATTED updatedAt, and updatedBy', () => {
    // 2026-07-01T00:00:00Z is 2026-06-30 19:00 in America/Chicago (CDT, UTC-5).
    expect(metaLine(schema({}))).toBe('v3  ·  06-30 19:00  ·  by admin1');
  });

  it('never leaks the raw machine timestamp the operator was being shown', () => {
    const line = metaLine(schema({ updatedAt: '2026-08-02T10:15:00.000Z' }));
    expect(line).not.toContain('2026-08-02T10:15:00.000Z');
    expect(line).not.toContain('T10:15');
    expect(line).not.toContain('.000Z');
    expect(line).toBe('v3  ·  08-02 05:15  ·  by admin1');
  });

  it('says "date unknown" for a null updatedAt rather than leaving a gap', () => {
    expect(metaLine(schema({ updatedAt: null, updatedBy: '' }))).toBe('v3  ·  date unknown');
  });

  it('keeps updatedBy when only the date is missing', () => {
    expect(metaLine(schema({ updatedAt: null }))).toBe('v3  ·  date unknown  ·  by admin1');
  });

  it('drops a blank updatedBy without a stray separator', () => {
    expect(metaLine(schema({ updatedBy: '' }))).toBe('v3  ·  06-30 19:00');
  });

  it('shows an unparseable updatedAt verbatim, never "Invalid Date" or "NaN"', () => {
    const line = metaLine(schema({ updatedAt: 'sometime last Tuesday' }));
    expect(line).toBe('v3  ·  sometime last Tuesday  ·  by admin1');
    expect(line).not.toMatch(/Invalid Date|NaN/);
  });
});

describe('FormSchemas screen', () => {
  it('loads and renders rows with name, id, and meta', async () => {
    listFormSchemas.mockResolvedValue([schema({})]);
    render(<FormSchemas />);
    expect(await screen.findByText('Tribe Profile')).toBeInTheDocument();
    expect(screen.getByText('tribeProfile')).toBeInTheDocument();
    expect(screen.getByText('v3 · 06-30 19:00 · by admin1')).toBeInTheDocument();
  });

  it('renders a human local time on the row, never the raw ISO instant', async () => {
    listFormSchemas.mockResolvedValue([
      schema({ id: 'intake-household', name: 'Household intake', version: 4, updatedAt: '2026-08-02T10:15:00.000Z', updatedBy: 'e2e-admin' }),
    ]);
    render(<FormSchemas />);
    await screen.findByText('Household intake');
    expect(screen.getByText('v4 · 08-02 05:15 · by e2e-admin')).toBeInTheDocument();
    expect(screen.queryByText(/2026-08-02T10:15:00\.000Z/)).toBeNull();
  });

  it('renders a schema with no updatedAt honestly, and still renders the row', async () => {
    listFormSchemas.mockResolvedValue([
      schema({ id: 'meet-and-greet', name: 'Meet and greet checklist', version: 1, updatedAt: null, updatedBy: null }),
    ]);
    render(<FormSchemas />);
    // The row survives: a missing timestamp must never cost the operator the schema.
    expect(await screen.findByText('Meet and greet checklist')).toBeInTheDocument();
    expect(screen.getByText('v1 · date unknown')).toBeInTheDocument();
  });

  it('renders a malformed updatedAt without ever printing "Invalid Date"', async () => {
    listFormSchemas.mockResolvedValue([
      schema({ id: 'legacy', name: 'Legacy schema', version: 2, updatedAt: 'sometime last Tuesday', updatedBy: 'admin1' }),
    ]);
    render(<FormSchemas />);
    await screen.findByText('Legacy schema');
    expect(screen.getByText('v2 · sometime last Tuesday · by admin1')).toBeInTheDocument();
    expect(screen.queryByText(/Invalid Date|NaN/)).toBeNull();
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
    expect(await screen.findByText(/no schemas yet/i)).toBeInTheDocument();
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
    // Row is a plain <div> when unwired, not a focusable button (a handler-less
    // <button> would still carry the implicit button role). The Delete icon
    // button stays interactive, so assert the ROW element's tag directly rather
    // than a name query that the "Delete Tribe Profile" button would also match.
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
});
