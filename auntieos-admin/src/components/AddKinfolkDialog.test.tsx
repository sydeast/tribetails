// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

const { createKinfolk, mapboxSuggest, mapboxRetrieve } = vi.hoisted(() => ({
  createKinfolk: vi.fn(),
  mapboxSuggest: vi.fn(),
  mapboxRetrieve: vi.fn(),
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

import { AddKinfolkDialog } from './AddKinfolkDialog';

beforeEach(() => {
  createKinfolk.mockReset();
  mapboxSuggest.mockReset().mockResolvedValue([]);
  mapboxRetrieve.mockReset();
});

describe('AddKinfolkDialog', () => {
  it('opens blank, status defaulted to active', () => {
    render(<AddKinfolkDialog onClose={vi.fn()} onCreated={vi.fn()} />);
    expect(screen.getByLabelText('First name')).toHaveValue('');
    expect(screen.getByLabelText('Last name')).toHaveValue('');
    expect(screen.getByLabelText('Phone')).toHaveValue('');
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
    await userEvent.type(screen.getByLabelText('Phone'), '(512) 555-1234');
    await userEvent.type(screen.getByLabelText('Email'), 'jamie@example.com');
    await userEvent.type(screen.getByLabelText('Address'), '123 Bark Ave');

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
});
