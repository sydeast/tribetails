// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest';
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
  it('joins version, updatedAt, and updatedBy, dropping blanks', () => {
    expect(metaLine(schema({}))).toBe('v3  ·  2026-07-01T00:00:00Z  ·  by admin1');
  });

  it('drops a null updatedAt and blank updatedBy without stray separators', () => {
    expect(metaLine(schema({ updatedAt: null, updatedBy: '' }))).toBe('v3');
  });
});

describe('FormSchemas screen', () => {
  it('loads and renders rows with name, id, and meta', async () => {
    listFormSchemas.mockResolvedValue([schema({})]);
    render(<FormSchemas />);
    expect(await screen.findByText('Tribe Profile')).toBeInTheDocument();
    expect(screen.getByText('tribeProfile')).toBeInTheDocument();
    expect(screen.getByText('v3 · 2026-07-01T00:00:00Z · by admin1')).toBeInTheDocument();
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
    const row = screen.getByText('Tribe Profile').closest('.schemas__row-main');
    expect(row).not.toHaveAttribute('role', 'button');
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
