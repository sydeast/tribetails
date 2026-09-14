// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

const { createKinfolk, mapboxSuggest, mapboxRetrieve, saveEmergencyContacts } = vi.hoisted(() => ({
  createKinfolk: vi.fn(),
  mapboxSuggest: vi.fn(),
  mapboxRetrieve: vi.fn(),
  saveEmergencyContacts: vi.fn(),
}));
vi.mock('../api/directoryWrite', async () => {
  const actual = await vi.importActual<typeof import('../api/directoryWrite')>('../api/directoryWrite');
  return { ...actual, createKinfolk };
});
// The Address field is now AddressAutofillField, which debounces a real
// `mapboxSearch` callable 250 ms after the last keystroke. Typing an address in
// a test here would otherwise reach for Firebase after the assertion ran.
vi.mock('../api/mapbox', async () => {
  const actual = await vi.importActual<typeof import('../api/mapbox')>('../api/mapbox');
  return { ...actual, mapboxSuggest, mapboxRetrieve };
});
vi.mock('../api/emergencyContacts', async () => {
  const actual = await vi.importActual<typeof import('../api/emergencyContacts')>('../api/emergencyContacts');
  return { ...actual, saveEmergencyContacts };
});

import { AddKinfolkDialog } from './AddKinfolkDialog';
import { EMERGENCY_CONTACT_REQUIRED } from '../api/emergencyContacts';

async function fillHousehold() {
  await userEvent.type(screen.getByLabelText('First name'), 'Jamie');
  await userEvent.type(screen.getByLabelText('Last name'), 'Halbrook');
  await userEvent.type(screen.getByLabelText('Phone', { selector: '#add-kinfolk-phone' }), '(512) 555-1234');
}

beforeEach(() => {
  createKinfolk.mockReset();
  mapboxSuggest.mockReset().mockResolvedValue([]);
  mapboxRetrieve.mockReset();
  saveEmergencyContacts.mockReset().mockResolvedValue([]);
});

describe('AddKinfolkDialog', () => {
  it('opens blank, status defaulted to active', () => {
    render(<AddKinfolkDialog onClose={vi.fn()} onCreated={vi.fn()} />);
    expect(screen.getByLabelText('First name')).toHaveValue('');
    expect(screen.getByLabelText('Last name')).toHaveValue('');
    expect(screen.getByLabelText('Phone', { selector: '#add-kinfolk-phone' })).toHaveValue('');
    expect(screen.getByLabelText('Email')).toHaveValue('');
    expect(screen.getByLabelText('Address')).toHaveValue('');
    expect(screen.getByLabelText('Status')).toHaveValue('active');
  });

  it('offers exactly the create-only prospect/active status choice', () => {
    render(<AddKinfolkDialog onClose={vi.fn()} onCreated={vi.fn()} />);
    const options = screen.getAllByRole('option').map((o) => o.textContent);
    expect(options).toEqual(['Prospect', 'Active']);
  });

  it('creates the household with the trimmed fields and reports success via onCreated', async () => {
    createKinfolk.mockResolvedValue('new-kf-1');
    const onCreated = vi.fn();
    render(<AddKinfolkDialog onClose={vi.fn()} onCreated={onCreated} />);

    await userEvent.type(screen.getByLabelText('First name'), '  Jamie  ');
    await userEvent.type(screen.getByLabelText('Last name'), '  Halbrook  ');
    await userEvent.type(screen.getByLabelText('Phone', { selector: '#add-kinfolk-phone' }), '(512) 555-1234');
    await userEvent.type(screen.getByLabelText('Email'), 'jamie@example.com');
    await userEvent.type(screen.getByLabelText('Address'), '123 Bark Ave');
    await userEvent.type(screen.getByLabelText('Name', { selector: '#add-kinfolk-ec-0-name' }), 'Rae Halbrook');
    await userEvent.type(screen.getByLabelText('Phone', { selector: '#add-kinfolk-ec-0-phone' }), '5125559090');

    await userEvent.click(screen.getByRole('button', { name: /^add kinfolk$/i }));

    await waitFor(() =>
      expect(createKinfolk).toHaveBeenCalledWith({
        firstName: '  Jamie  ',
        lastName: '  Halbrook  ',
        phoneNumber: '(512) 555-1234',
        email: 'jamie@example.com',
        status: 'active',
        serviceAddress: '123 Bark Ave',
      }),
    );
    await waitFor(() => expect(onCreated).toHaveBeenCalledWith('new-kf-1'));
  });

  it('offers Mapbox suggestions on the address, and saves the RESOLVED address (#12)', async () => {
    mapboxSuggest.mockResolvedValue([
      { name: 'Bark House', fullAddress: '123 Bark Ave, Austin TX 78701', mapboxId: 'id-1', placeFormatted: 'Austin TX' },
    ]);
    mapboxRetrieve.mockResolvedValue('123 Bark Ave, Austin TX 78701');
    createKinfolk.mockResolvedValue('new-kf-2');
    render(<AddKinfolkDialog onClose={vi.fn()} onCreated={vi.fn()} />);

    await userEvent.type(screen.getByLabelText('First name'), 'Jamie');
    await userEvent.type(screen.getByLabelText('Last name'), 'Halbrook');
    await userEvent.type(screen.getByLabelText('Address'), '123 Bark');
    await userEvent.type(screen.getByLabelText('Name', { selector: '#add-kinfolk-ec-0-name' }), 'Rae Halbrook');
    await userEvent.type(screen.getByLabelText('Phone', { selector: '#add-kinfolk-ec-0-phone' }), '5125559090');

    await userEvent.click(await screen.findByRole('button', { name: /Bark House/ }));
    await waitFor(() => expect(screen.getByLabelText('Address')).toHaveValue('123 Bark Ave, Austin TX 78701'));

    await userEvent.click(screen.getByRole('button', { name: /^add kinfolk$/i }));
    await waitFor(() =>
      expect(createKinfolk).toHaveBeenCalledWith(
        expect.objectContaining({ serviceAddress: '123 Bark Ave, Austin TX 78701' }),
      ),
    );
  });

  it('still creates the household when the address lookup fails (autofill is additive)', async () => {
    mapboxSuggest.mockRejectedValue(new Error('mapbox_502'));
    createKinfolk.mockResolvedValue('new-kf-3');
    render(<AddKinfolkDialog onClose={vi.fn()} onCreated={vi.fn()} />);

    await userEvent.type(screen.getByLabelText('First name'), 'Jamie');
    await userEvent.type(screen.getByLabelText('Last name'), 'Halbrook');
    await userEvent.type(screen.getByLabelText('Address'), '9 Unmapped Rd');
    expect(await screen.findByText(/address lookup failed: mapbox_502/i)).toBeInTheDocument();
    await userEvent.type(screen.getByLabelText('Name', { selector: '#add-kinfolk-ec-0-name' }), 'Rae Halbrook');
    await userEvent.type(screen.getByLabelText('Phone', { selector: '#add-kinfolk-ec-0-phone' }), '5125559090');

    await userEvent.click(screen.getByRole('button', { name: /^add kinfolk$/i }));
    await waitFor(() =>
      expect(createKinfolk).toHaveBeenCalledWith(expect.objectContaining({ serviceAddress: '9 Unmapped Rd' })),
    );
  });

  it('rejects a blank first/last name without calling createKinfolk', async () => {
    render(<AddKinfolkDialog onClose={vi.fn()} onCreated={vi.fn()} />);
    await userEvent.click(screen.getByRole('button', { name: /^add kinfolk$/i }));

    expect(await screen.findAllByRole('alert')).toHaveLength(2);
    expect(createKinfolk).not.toHaveBeenCalled();
  });

  it('surfaces a required-field error on blur alone, before any save attempt (AO-44)', async () => {
    render(<AddKinfolkDialog onClose={vi.fn()} onCreated={vi.fn()} />);
    // Focus first name, then leave it blank. The error appears without a save click,
    // and the still-untouched last-name field stays silent.
    await userEvent.click(screen.getByLabelText('First name'));
    await userEvent.tab();
    expect(await screen.findByText(/first name can't be blank/i)).toBeInTheDocument();
    expect(screen.queryByText(/last name can't be blank/i)).toBeNull();
    expect(createKinfolk).not.toHaveBeenCalled();
  });

  it('disables Cancel and Add while a create is in flight', async () => {
    let resolveCreate!: (id: string) => void;
    createKinfolk.mockReturnValue(new Promise<string>((resolve) => (resolveCreate = resolve)));
    render(<AddKinfolkDialog onClose={vi.fn()} onCreated={vi.fn()} />);

    await userEvent.type(screen.getByLabelText('First name'), 'Jamie');
    await userEvent.type(screen.getByLabelText('Last name'), 'Halbrook');
    await userEvent.type(screen.getByLabelText('Name', { selector: '#add-kinfolk-ec-0-name' }), 'Rae Halbrook');
    await userEvent.type(screen.getByLabelText('Phone', { selector: '#add-kinfolk-ec-0-phone' }), '5125559090');
    await userEvent.click(screen.getByRole('button', { name: /^add kinfolk$/i }));

    expect(screen.getByRole('button', { name: /adding/i })).toBeDisabled();
    expect(screen.getByRole('button', { name: /^cancel$/i })).toBeDisabled();
    expect(screen.getByLabelText('First name')).toBeDisabled();

    resolveCreate('new-kf-2');
    await waitFor(() => expect(screen.queryByRole('button', { name: /adding/i })).toBeNull());
  });

  it('fails loud on a rejected create: names the call, keeps the dialog open, never calls onCreated', async () => {
    createKinfolk.mockRejectedValue(new Error('permission-denied'));
    const onCreated = vi.fn();
    render(<AddKinfolkDialog onClose={vi.fn()} onCreated={onCreated} />);

    await userEvent.type(screen.getByLabelText('First name'), 'Jamie');
    await userEvent.type(screen.getByLabelText('Last name'), 'Halbrook');
    await userEvent.type(screen.getByLabelText('Name', { selector: '#add-kinfolk-ec-0-name' }), 'Rae Halbrook');
    await userEvent.type(screen.getByLabelText('Phone', { selector: '#add-kinfolk-ec-0-phone' }), '5125559090');
    await userEvent.click(screen.getByRole('button', { name: /^add kinfolk$/i }));

    expect(await screen.findByText(/createKinfolk failed:.*permission-denied/i)).toBeInTheDocument();
    expect(onCreated).not.toHaveBeenCalled();
    expect(screen.getByRole('button', { name: /^add kinfolk$/i })).toBeEnabled();
  });

  it('calls onClose (discarding the draft) when Cancel is clicked', async () => {
    const onClose = vi.fn();
    render(<AddKinfolkDialog onClose={onClose} onCreated={vi.fn()} />);
    await userEvent.click(screen.getByRole('button', { name: /^cancel$/i }));
    expect(onClose).toHaveBeenCalledOnce();
    expect(createKinfolk).not.toHaveBeenCalled();
  });

  it('requires an Emergency Contact before anything is created', async () => {
    render(<AddKinfolkDialog onClose={vi.fn()} onCreated={vi.fn()} />);
    await fillHousehold();
    await userEvent.click(screen.getByRole('button', { name: /^add kinfolk$/i }));
    expect(await screen.findByText('A household needs at least one Emergency Contact.')).toBeInTheDocument();
    expect(createKinfolk).not.toHaveBeenCalled();
  });

  it('titles the section "Emergency Contacts", with its sentence behind an info button beside the title', async () => {
    render(<AddKinfolkDialog onClose={vi.fn()} onCreated={vi.fn()} />);
    const heading = screen.getByRole('heading', { name: /^Emergency Contacts/ });
    const tip = within(heading).getByRole('tooltip', { hidden: true });
    expect(tip).toHaveTextContent('Called only when no kinfolk can be reached. The first one is called first.');
    await userEvent.click(within(heading).getByRole('button', { name: 'About this section' }));
    expect(tip).toBeVisible();
  });

  // #829 review item 6.
  it('closing with the household created but its contact unsaved names that household to the caller', async () => {
    createKinfolk.mockResolvedValue('new-kf-9');
    saveEmergencyContacts.mockRejectedValue(new Error('deadline-exceeded'));
    const onLeftWithoutContact = vi.fn();
    const onClose = vi.fn();
    render(<AddKinfolkDialog onClose={onClose} onCreated={vi.fn()} onLeftWithoutContact={onLeftWithoutContact} />);
    await fillHousehold();
    await userEvent.type(screen.getByLabelText('Name', { selector: '#add-kinfolk-ec-0-name' }), 'Rae Halbrook');
    await userEvent.type(screen.getByLabelText('Phone', { selector: '#add-kinfolk-ec-0-phone' }), '5125550199');
    await userEvent.click(screen.getByRole('button', { name: /^add kinfolk$/i }));
    await screen.findByText(/deadline-exceeded/);
    await userEvent.click(screen.getByRole('button', { name: /^cancel$/i }));
    expect(onLeftWithoutContact).toHaveBeenCalledWith('new-kf-9');
    expect(onClose).toHaveBeenCalledOnce();
  });

  it('closing before anything was created reports no household', async () => {
    const onLeftWithoutContact = vi.fn();
    render(<AddKinfolkDialog onClose={vi.fn()} onCreated={vi.fn()} onLeftWithoutContact={onLeftWithoutContact} />);
    await userEvent.click(screen.getByRole('button', { name: /^cancel$/i }));
    expect(onLeftWithoutContact).not.toHaveBeenCalled();
  });

  it('creates the household, then saves its contact', async () => {
    createKinfolk.mockResolvedValue('new-kf-1');
    saveEmergencyContacts.mockResolvedValue([]);
    const onCreated = vi.fn();
    render(<AddKinfolkDialog onClose={vi.fn()} onCreated={onCreated} />);
    await fillHousehold();
    await userEvent.type(screen.getByLabelText('Name', { selector: '#add-kinfolk-ec-0-name' }), 'Rae Halbrook');
    await userEvent.type(screen.getByLabelText('Phone', { selector: '#add-kinfolk-ec-0-phone' }), '5125559090');
    await userEvent.click(screen.getByRole('button', { name: /^add kinfolk$/i }));
    await waitFor(() => expect(onCreated).toHaveBeenCalledWith('new-kf-1'));
    expect(saveEmergencyContacts).toHaveBeenCalledWith('new-kf-1', [{ name: 'Rae Halbrook', phone: '5125559090', relationship: '' }]);
  });

  it('when the contact save fails, says so and retries only the contact, never a second household', async () => {
    createKinfolk.mockResolvedValue('new-kf-1');
    saveEmergencyContacts.mockRejectedValueOnce(new Error('network')).mockResolvedValueOnce([]);
    const onCreated = vi.fn();
    render(<AddKinfolkDialog onClose={vi.fn()} onCreated={onCreated} />);
    await fillHousehold();
    await userEvent.type(screen.getByLabelText('Name', { selector: '#add-kinfolk-ec-0-name' }), 'Rae Halbrook');
    await userEvent.type(screen.getByLabelText('Phone', { selector: '#add-kinfolk-ec-0-phone' }), '5125559090');
    await userEvent.click(screen.getByRole('button', { name: /^add kinfolk$/i }));
    expect(await screen.findByText(/^network The household was created/)).toBeInTheDocument();
    expect(screen.queryByText(/saveEmergencyContacts failed/)).toBeNull();
    expect(onCreated).not.toHaveBeenCalled();
    await userEvent.click(screen.getByRole('button', { name: 'Save Emergency Contact' }));
    await waitFor(() => expect(onCreated).toHaveBeenCalledWith('new-kf-1'));
    expect(createKinfolk).toHaveBeenCalledTimes(1);
  });

  it('re-validates the contact on retry: clearing it after a failed save refuses locally, never a second callable call', async () => {
    createKinfolk.mockResolvedValue('new-kf-1');
    saveEmergencyContacts.mockRejectedValueOnce(new Error('network'));
    const onCreated = vi.fn();
    render(<AddKinfolkDialog onClose={vi.fn()} onCreated={onCreated} />);
    await fillHousehold();
    await userEvent.type(screen.getByLabelText('Name', { selector: '#add-kinfolk-ec-0-name' }), 'Rae Halbrook');
    await userEvent.type(screen.getByLabelText('Phone', { selector: '#add-kinfolk-ec-0-phone' }), '5125559090');
    await userEvent.click(screen.getByRole('button', { name: /^add kinfolk$/i }));
    expect(await screen.findByText(/^network The household was created/)).toBeInTheDocument();
    expect(screen.queryByText(/saveEmergencyContacts failed/)).toBeNull();
    expect(saveEmergencyContacts).toHaveBeenCalledTimes(1);

    // The editor is still live during the retry (#829): clear it, then retry.
    await userEvent.clear(screen.getByLabelText('Name', { selector: '#add-kinfolk-ec-0-name' }));
    await userEvent.clear(screen.getByLabelText('Phone', { selector: '#add-kinfolk-ec-0-phone' }));
    await userEvent.click(screen.getByRole('button', { name: 'Save Emergency Contact' }));

    expect(await screen.findByText(EMERGENCY_CONTACT_REQUIRED)).toBeInTheDocument();
    // Refused locally: no second round trip, and never a second household.
    expect(saveEmergencyContacts).toHaveBeenCalledTimes(1);
    expect(createKinfolk).toHaveBeenCalledTimes(1);
    expect(onCreated).not.toHaveBeenCalled();
  });
});
