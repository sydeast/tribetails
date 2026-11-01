// @vitest-environment jsdom
import { useRef, useState } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { SecondaryKinfolkCard } from './SecondaryKinfolkCard';
import type { SecondaryKinfolkDto } from '../api/tribeApi';
import type { CardSave } from './cardSave';

/**
 * The portal's Secondary Kinfolk card (operator ruling 2026-09-27, Q3): the
 * primary adds a secondary kinfolk with no invite and no portal access, and
 * hands one to the invite card with "Give portal access".
 */

const mocks = vi.hoisted(() => ({ list: vi.fn(), save: vi.fn(), remove: vi.fn() }));
vi.mock('../api/tribeApi', async () => {
  const actual = await vi.importActual<typeof import('../api/tribeApi')>('../api/tribeApi');
  return {
    ...actual,
    listSecondaryKinfolk: (...a: unknown[]) => mocks.list(...a),
    saveSecondaryKinfolk: (...a: unknown[]) => mocks.save(...a),
    removeSecondaryKinfolk: (...a: unknown[]) => mocks.remove(...a),
  };
});

const SAM: SecondaryKinfolkDto = { personId: 'p1', name: 'Sam Lee', phone: '+18055550177', email: null, access: 'NONE', memberUid: null, createdAt: null };
const JO: SecondaryKinfolkDto = { personId: 'p2', name: 'Jo Park', phone: null, email: 'jo@example.com', access: 'INVITED', memberUid: null, createdAt: null };
const ADA: SecondaryKinfolkDto = { personId: 'p3', name: 'Ada Wall', phone: null, email: null, access: 'ACTIVE', memberUid: 'u3', createdAt: null };

/**
 * Stands in for the Tribe Profile page (#1324): the card has no Save button, the
 * page's one Save Changes asks it to save when it holds edits (`dirty`), exactly
 * as the page does, and prints a worded result.
 */
function PageHarness(props: { onGiveAccess: (p: SecondaryKinfolkDto) => void }) {
  const ref = useRef<CardSave | null>(null);
  const [saving, setSaving] = useState(false);
  const [outcome, setOutcome] = useState<string | null>(null);
  return (
    <>
      <SecondaryKinfolkCard kinfolkId="kin-fam-1" onGiveAccess={props.onGiveAccess} saveRef={ref} />
      <button
        type="button"
        disabled={saving}
        onClick={() => {
          if (!ref.current?.dirty) return;
          setSaving(true);
          void ref.current.save().then((r) => {
            setOutcome(r.ok ? 'Saved.' : r.message);
            setSaving(false);
          });
        }}
      >
        {saving ? 'Saving…' : 'Save Changes'}
      </button>
      {outcome && <p data-testid="page-outcome">{outcome}</p>}
    </>
  );
}
function mount(onGiveAccess = vi.fn()) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={qc}>
      <PageHarness onGiveAccess={onGiveAccess} />
    </QueryClientProvider>,
  );
  return { onGiveAccess };
}
beforeEach(() => {
  mocks.list.mockReset().mockResolvedValue([]);
  mocks.save.mockReset().mockResolvedValue({ person: SAM, created: true });
  mocks.remove.mockReset().mockResolvedValue({ ok: true });
});

describe('SecondaryKinfolkCard', () => {
  it('adds one with a name only: no invite, blank phone and email sent as null', async () => {
    mount();
    await userEvent.type(await screen.findByLabelText('Name'), 'Sam Lee');
    // The form says what will happen, and there is no Add button of its own.
    expect(screen.getByTestId('skin-unsaved')).toHaveTextContent('Sam Lee is added when you press Save Changes.');
    expect(screen.queryByRole('button', { name: 'Add secondary kinfolk' })).toBeNull();
    await userEvent.click(screen.getByRole('button', { name: 'Save Changes' }));
    await waitFor(() =>
      expect(mocks.save).toHaveBeenCalledWith({ kinfolkId: 'kin-fam-1', name: 'Sam Lee', phone: null, email: null }),
    );
    expect(await screen.findByText('Saved.')).toBeInTheDocument();
    expect(screen.getByLabelText('Name')).toHaveValue('');
  });

  it('refuses a blank name locally, and shows a server refusal verbatim with the typing kept', async () => {
    mocks.save.mockRejectedValue(new Error('That phone number is not a valid number.'));
    mount();
    // A phone with no name is an edit, and it is refused locally.
    await userEvent.type(await screen.findByLabelText('Phone (optional)'), '12');
    await userEvent.click(screen.getByRole('button', { name: 'Save Changes' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('A secondary kinfolk needs a name.');
    expect(screen.getByTestId('page-outcome')).toHaveTextContent('A secondary kinfolk needs a name.');
    expect(mocks.save).not.toHaveBeenCalled();
    await userEvent.type(screen.getByLabelText('Name'), 'Sam');
    await userEvent.click(screen.getByRole('button', { name: 'Save Changes' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('That phone number is not a valid number.');
    expect(screen.getByLabelText('Phone (optional)')).toHaveValue('12');
  });

  it('lists NONE and INVITED people with their state, not an ACTIVE one, each with Give portal access', async () => {
    mocks.list.mockResolvedValue([SAM, JO, ADA]);
    const { onGiveAccess } = mount();
    const rows = await screen.findAllByTestId('skin-row');
    expect(rows.map((r) => r.textContent)).toEqual([expect.stringContaining('No portal access'), expect.stringContaining('Invited')]);
    expect(screen.queryByText('Ada Wall')).toBeNull();
    await userEvent.click(within(rows[0]!).getByRole('button', { name: 'Give portal access' }));
    expect(onGiveAccess).toHaveBeenCalledWith(SAM);
  });

  it('edits one, sending every field with its person id', async () => {
    mocks.list.mockResolvedValue([SAM]);
    mount();
    await userEvent.click(await screen.findByRole('button', { name: 'Edit Sam Lee' }));
    expect(screen.getByLabelText('Phone (optional)')).toHaveValue('(805) 555-0177');
    await userEvent.clear(screen.getByLabelText('Phone (optional)'));
    await userEvent.click(screen.getByRole('button', { name: 'Save Changes' }));
    await waitFor(() =>
      expect(mocks.save).toHaveBeenCalledWith({ kinfolkId: 'kin-fam-1', personId: 'p1', name: 'Sam Lee', phone: null, email: null }),
    );
  });

  it('an untouched form is not dirty, so the page Save never calls the callable for it', async () => {
    mocks.list.mockResolvedValue([SAM]);
    mount();
    await screen.findByRole('button', { name: 'Edit Sam Lee' });
    await userEvent.click(screen.getByRole('button', { name: 'Save Changes' }));
    // Editing and changing nothing is not an edit either.
    await userEvent.click(screen.getByRole('button', { name: 'Edit Sam Lee' }));
    expect(screen.queryByTestId('skin-unsaved')).toBeNull();
    await userEvent.click(screen.getByRole('button', { name: 'Save Changes' }));
    expect(mocks.save).not.toHaveBeenCalled();
  });
  it('removes one after a confirm', async () => {
    mocks.list.mockResolvedValue([SAM]);
    mount();
    await userEvent.click(await screen.findByRole('button', { name: 'Remove Sam Lee' }));
    expect(mocks.remove).not.toHaveBeenCalled();
    await userEvent.click(screen.getByRole('button', { name: 'Yes, remove' }));
    await waitFor(() => expect(mocks.remove).toHaveBeenCalledWith({ kinfolkId: 'kin-fam-1', personId: 'p1' }));
  });

  it('a load failure says so, with no form and no empty list', async () => {
    mocks.list.mockRejectedValue(new Error('permission-denied'));
    mount();
    expect(await screen.findByText('Couldn’t load secondary kinfolk right now.')).toBeInTheDocument();
    expect(screen.queryByLabelText('Name')).toBeNull();
  });
});
