// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { ToastProvider } from '../components/Toast';
import type { FormSchemaSummary } from '../api/formSchemas';
const { listFormSchemas, listBusinessAdmins } = vi.hoisted(() => ({
  listFormSchemas: vi.fn(),
  listBusinessAdmins: vi.fn(),
}));
vi.mock('../api/formSchemas', async (orig) => ({
  ...(await orig<typeof import('../api/formSchemas')>()),
  listFormSchemas,
}));
vi.mock('../api/businessAdmins', async (orig) => ({
  ...(await orig<typeof import('../api/businessAdmins')>()),
  listBusinessAdmins,
}));
// The editor is covered by its own tests; here it only has to hand back a save.
vi.mock('../screens/FormSchemaEditor', async () => {
  const { useToast } = await import('../components/Toast');
  return {
    FormSchemaEditor: ({ onSaved }: { onSaved: (id: string) => void }) => {
      const { showToast } = useToast();
      return (
        <button
          type="button"
          onClick={() => {
            showToast('Saved Fresh Schema.');
            onSaved('fresh');
          }}
        >
          Pretend save
        </button>
      );
    },
  };
});
import { FormSchemasView } from './FormSchemasView';
function row(over: Partial<FormSchemaSummary>): FormSchemaSummary {
  return { id: 'a', name: 'Alpha', appliesTo: 'NONE', version: 1, updatedAt: '2026-07-01T00:00:00Z', updatedBy: 'u', ...over };
}
beforeEach(() => {
  listFormSchemas.mockReset();
  listBusinessAdmins.mockReset();
  listBusinessAdmins.mockResolvedValue({ members: [], source: 'roster', rosterPath: '', reason: null });
});
describe('FormSchemasView (#1615)', () => {
  it('reads the list again after the editor saves and keeps the confirmation on screen', async () => {
    listFormSchemas
      .mockResolvedValueOnce([row({})])
      .mockResolvedValueOnce([row({}), row({ id: 'fresh', name: 'Fresh Schema' })]);
    render(
      <ToastProvider>
        <FormSchemasView />
      </ToastProvider>,
    );
    await screen.findByText('Alpha');
    await userEvent.click(screen.getByRole('button', { name: /new/i }));
    await userEvent.click(await screen.findByRole('button', { name: 'Pretend save' }));
    expect(await screen.findByText('Fresh Schema')).toBeInTheDocument();
    expect(listFormSchemas).toHaveBeenCalledTimes(2);
    expect(screen.getByText('Saved Fresh Schema.')).toBeInTheDocument();
  });
  it('loads once on mount and not again until a save', async () => {
    listFormSchemas.mockResolvedValue([row({})]);
    render(
      <ToastProvider>
        <FormSchemasView />
      </ToastProvider>,
    );
    await screen.findByText('Alpha');
    await waitFor(() => expect(listFormSchemas).toHaveBeenCalledTimes(1));
  });
});
