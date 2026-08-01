// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render as rtlRender, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { ToastProvider } from '../components/Toast';
import { type VetClinic } from '../api/vetClinics';

/**
 * The Vet clinics manager (punchlist B4).
 *
 * The behaviours worth pinning here are the ones that make the screen safe to
 * use rather than merely present: the household count that tells the operator
 * how far a save will travel, the retire-not-delete wiring, and the refusal to
 * claim "no households" while the count is still unknown.
 */
function render(ui: React.ReactElement) {
  return rtlRender(<ToastProvider>{ui}</ToastProvider>);
}

const { useCollection } = vi.hoisted(() => ({ useCollection: vi.fn() }));
vi.mock('../lib/firestore', async (orig) => ({
  ...(await orig<typeof import('../lib/firestore')>()),
  useCollection,
}));

const { updateVetClinic, archiveVetClinic, submitVetClinic } = vi.hoisted(() => ({
  updateVetClinic: vi.fn(),
  archiveVetClinic: vi.fn(),
  submitVetClinic: vi.fn(),
}));
vi.mock('../api/vetClinicsWrite', async (orig) => ({
  ...(await orig<typeof import('../api/vetClinicsWrite')>()),
  updateVetClinic,
  archiveVetClinic,
  submitVetClinic,
}));

import { VetClinics } from './VetClinics';

const user = userEvent.setup();

const RIVERSIDE: VetClinic = {
  _id: 'c1',
  name: 'Riverside Animal Hospital',
  phone: '(512) 555 0100',
  address: '418 Mill St',
  hours: 'Mon to Fri 8a to 6p',
  verified: true,
};

const PENDING: VetClinic = { _id: 'p1', name: 'New Place', verified: false, submittedBy: 'kin1' };
const RETIRED: VetClinic = { _id: 'r1', name: 'Closed Clinic', archived: true };

/**
 * The screen opens two listeners: the catalog and the households whose counts
 * it renders. `useCollection` is keyed off the spec's path so each gets its own
 * canned answer.
 */
function seed(opts: {
  clinics?: VetClinic[];
  households?: Array<Record<string, unknown>>;
  householdsPending?: boolean;
} = {}) {
  useCollection.mockImplementation((spec: { path: string }) => {
    if (spec.path === 'vet_clinics') {
      return { status: 'ready', data: opts.clinics ?? [RIVERSIDE] };
    }
    if (spec.path === 'household_data') {
      if (opts.householdsPending === true) return { status: 'loading' };
      return { status: 'ready', data: opts.households ?? [] };
    }
    return { status: 'ready', data: [] };
  });
}

beforeEach(() => {
  useCollection.mockReset();
  updateVetClinic.mockReset();
  archiveVetClinic.mockReset();
  submitVetClinic.mockReset();
  updateVetClinic.mockResolvedValue({ ok: true, clinicId: 'c1', householdsUpdated: 0 });
  archiveVetClinic.mockResolvedValue({
    ok: true,
    clinicId: 'c1',
    archived: true,
    householdCount: 0,
  });
  submitVetClinic.mockResolvedValue({ clinicId: 'new', created: true, pending: false });
});

describe('VetClinics: reading the bank', () => {
  it('lists a clinic with the details on file', async () => {
    seed();
    render(<VetClinics />);
    expect(await screen.findByText('Riverside Animal Hospital')).toBeInTheDocument();
    expect(screen.getByText('(512) 555 0100')).toBeInTheDocument();
    expect(screen.getByText('Mon to Fri 8a to 6p')).toBeInTheDocument();
  });

  it('shows a blank field as Not set rather than hiding it', async () => {
    seed({ clinics: [{ _id: 'c9', name: 'Bare Clinic' }] });
    render(<VetClinics />);
    await screen.findByText('Bare Clinic');
    expect(screen.getAllByText('Not set').length).toBeGreaterThan(0);
  });

  it('separates pending submissions from the live catalog', async () => {
    seed({ clinics: [RIVERSIDE, PENDING] });
    render(<VetClinics />);
    expect(await screen.findByText('Pending approval')).toBeInTheDocument();
    expect(screen.getByText('New Place')).toBeInTheDocument();
  });

  it('lists retired clinics in their own section, not the catalog', async () => {
    seed({ clinics: [RIVERSIDE, RETIRED] });
    render(<VetClinics />);
    expect(await screen.findByText('Retired')).toBeInTheDocument();
    expect(screen.getByText('Closed Clinic')).toBeInTheDocument();
  });

  it('filters on search', async () => {
    seed({ clinics: [RIVERSIDE, { _id: 'c2', name: 'The Mill Vet' }] });
    render(<VetClinics />);
    await screen.findByText('Riverside Animal Hospital');

    await user.type(screen.getByLabelText(/Search clinics/), 'the mill vet');
    await waitFor(() =>
      expect(screen.queryByText('Riverside Animal Hospital')).not.toBeInTheDocument(),
    );
    expect(screen.getByText('The Mill Vet')).toBeInTheDocument();
  });

  it('fails loud on a catalog read error instead of showing an empty bank', async () => {
    useCollection.mockImplementation((spec: { path: string }) =>
      spec.path === 'vet_clinics'
        ? { status: 'error', message: 'permission-denied' }
        : { status: 'ready', data: [] },
    );
    render(<VetClinics />);
    expect(await screen.findByRole('alert')).toHaveTextContent(/permission-denied/);
    expect(screen.queryByText(/The bank is empty/)).not.toBeInTheDocument();
  });
});

describe('VetClinics: the household count', () => {
  it('counts a household linked by id', async () => {
    seed({ households: [{ _id: 'h1', primaryVetClinicId: 'c1' }] });
    render(<VetClinics />);
    expect(await screen.findByText(/1 linked/)).toBeInTheDocument();
  });

  it('names a name-only household separately, since a save cannot reach it', async () => {
    seed({
      households: [{ _id: 'h1', primaryVetClinicId: '', primaryVetName: 'Riverside Animal Hospital' }],
    });
    render(<VetClinics />);
    expect(await screen.findByText(/1 by name only/)).toBeInTheDocument();
    expect(screen.getByText(/not updated by a save/)).toBeInTheDocument();
  });

  it('says no households when there genuinely are none', async () => {
    seed({ households: [] });
    render(<VetClinics />);
    expect(await screen.findByText('No households')).toBeInTheDocument();
  });

  it('refuses to claim zero while the household read is still in flight', async () => {
    // The next control on this card retires the clinic, so "nobody uses this"
    // and "we have not checked" must not look alike.
    seed({ householdsPending: true });
    render(<VetClinics />);
    expect(await screen.findByText(/checking/)).toBeInTheDocument();
    expect(screen.queryByText('No households')).not.toBeInTheDocument();
  });
});

describe('VetClinics: correcting a clinic', () => {
  async function openEdit() {
    seed({ households: [{ _id: 'h1', primaryVetClinicId: 'c1' }] });
    render(<VetClinics />);
    await screen.findByText('Riverside Animal Hospital');
    await user.click(screen.getByRole('button', { name: 'Edit' }));
  }

  it('seeds the form from the stored row', async () => {
    await openEdit();
    expect(screen.getByLabelText('Phone')).toHaveValue('(512) 555 0100');
    expect(screen.getByLabelText('Hours')).toHaveValue('Mon to Fri 8a to 6p');
  });

  it('cannot save without a change', async () => {
    await openEdit();
    expect(screen.getByRole('button', { name: 'Save' })).toBeDisabled();
  });

  it('cannot save a blank name', async () => {
    await openEdit();
    await user.clear(screen.getByLabelText('Name'));
    expect(screen.getByRole('button', { name: 'Save' })).toBeDisabled();
  });

  it('warns before saving that the correction will rewrite households', async () => {
    await openEdit();
    expect(screen.getByText(/Saving rewrites the vet on 1 household/)).toBeInTheDocument();
  });

  it('sends the whole record, so a cleared field is really cleared', async () => {
    await openEdit();
    await user.clear(screen.getByLabelText('Address'));
    await user.clear(screen.getByLabelText('Phone'));
    await user.type(screen.getByLabelText('Phone'), '(512) 555 0199');
    await user.click(screen.getByRole('button', { name: 'Save' }));

    await waitFor(() => expect(updateVetClinic).toHaveBeenCalled());
    expect(updateVetClinic.mock.calls[0]?.[0]).toMatchObject({
      clinicId: 'c1',
      phone: '(512) 555 0199',
      address: '',
    });
  });

  it('reports how far the correction actually travelled', async () => {
    updateVetClinic.mockResolvedValue({ ok: true, clinicId: 'c1', householdsUpdated: 3 });
    await openEdit();
    await user.clear(screen.getByLabelText('Phone'));
    await user.type(screen.getByLabelText('Phone'), '(512) 555 0199');
    await user.click(screen.getByRole('button', { name: 'Save' }));

    expect(
      await screen.findByText(/3 households now read the corrected details/),
    ).toBeInTheDocument();
  });

  it('blocks a rename onto another clinic before the round trip', async () => {
    seed({ clinics: [RIVERSIDE, { _id: 'c2', name: 'The Mill Vet' }] });
    render(<VetClinics />);
    await screen.findByText('Riverside Animal Hospital');
    await user.click(screen.getAllByRole('button', { name: 'Edit' })[0]!);

    const name = screen.getByLabelText('Name');
    await user.clear(name);
    await user.type(name, 'the  MILL vet');

    expect(await screen.findByText(/Another clinic is already called that/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Save' })).toBeDisabled();
  });

  it('surfaces a rejected save rather than swallowing it', async () => {
    updateVetClinic.mockRejectedValue(new Error('permission-denied'));
    await openEdit();
    await user.clear(screen.getByLabelText('Phone'));
    await user.type(screen.getByLabelText('Phone'), '999');
    await user.click(screen.getByRole('button', { name: 'Save' }));

    expect(await screen.findByRole('alert')).toHaveTextContent(/permission-denied/);
  });

  it('approves a pending submission through the same save', async () => {
    seed({ clinics: [PENDING] });
    render(<VetClinics />);
    await screen.findByText('New Place');
    await user.click(screen.getByRole('button', { name: 'Approve' }));

    await waitFor(() => expect(updateVetClinic).toHaveBeenCalled());
    expect(updateVetClinic.mock.calls[0]?.[0]).toMatchObject({ verified: true });
  });
});

describe('VetClinics: retire, never delete', () => {
  it('offers Retire rather than a label promising removal', async () => {
    seed();
    render(<VetClinics />);
    await screen.findByText('Riverside Animal Hospital');
    expect(screen.getByRole('button', { name: 'Retire' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Delete/ })).not.toBeInTheDocument();
  });

  it('archives rather than deleting', async () => {
    seed();
    render(<VetClinics />);
    await screen.findByText('Riverside Animal Hospital');
    await user.click(screen.getByRole('button', { name: 'Retire' }));

    await waitFor(() => expect(archiveVetClinic).toHaveBeenCalledWith('c1', true));
  });

  it('says the households keep what is on file after a retire', async () => {
    archiveVetClinic.mockResolvedValue({
      ok: true,
      clinicId: 'c1',
      archived: true,
      householdCount: 2,
    });
    seed();
    render(<VetClinics />);
    await screen.findByText('Riverside Animal Hospital');
    await user.click(screen.getByRole('button', { name: 'Retire' }));

    expect(
      await screen.findByText(/2 households keep the details already on file/),
    ).toBeInTheDocument();
  });

  it('rejects a pending submission by retiring it, keeping who submitted it', async () => {
    seed({ clinics: [PENDING] });
    render(<VetClinics />);
    await screen.findByText('New Place');
    await user.click(screen.getByRole('button', { name: 'Reject' }));

    await waitFor(() => expect(archiveVetClinic).toHaveBeenCalledWith('p1', true));
  });

  it('restores a retired clinic', async () => {
    archiveVetClinic.mockResolvedValue({
      ok: true,
      clinicId: 'r1',
      archived: false,
      householdCount: 0,
    });
    seed({ clinics: [RETIRED] });
    render(<VetClinics />);
    await screen.findByText('Closed Clinic');
    await user.click(screen.getByRole('button', { name: 'Restore' }));

    await waitFor(() => expect(archiveVetClinic).toHaveBeenCalledWith('r1', false));
  });
});

describe('VetClinics: adding', () => {
  it('routes a new clinic through the deduping create callable', async () => {
    seed();
    render(<VetClinics />);
    await screen.findByText('Riverside Animal Hospital');
    await user.click(screen.getByRole('button', { name: 'Add clinic' }));

    await user.type(screen.getByLabelText('Name'), 'Oak Hill Veterinary');
    await user.click(screen.getByRole('button', { name: 'Add to bank' }));

    await waitFor(() => expect(submitVetClinic).toHaveBeenCalled());
    expect(submitVetClinic.mock.calls[0]?.[0]).toMatchObject({ name: 'Oak Hill Veterinary' });
  });

  it('says so when the create deduped onto an existing clinic', async () => {
    submitVetClinic.mockResolvedValue({ clinicId: 'c1', created: false, pending: false });
    seed();
    render(<VetClinics />);
    await screen.findByText('Riverside Animal Hospital');
    await user.click(screen.getByRole('button', { name: 'Add clinic' }));

    await user.type(screen.getByLabelText('Name'), 'Riverside Animal Hospital');
    await user.click(screen.getByRole('button', { name: 'Add to bank' }));

    expect(await screen.findByText(/was already in the bank/)).toBeInTheDocument();
  });
});
