// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

const { createKin } = vi.hoisted(() => ({ createKin: vi.fn() }));
vi.mock('../api/directoryWrite', async () => {
  const actual = await vi.importActual<typeof import('../api/directoryWrite')>('../api/directoryWrite');
  return { ...actual, createKin };
});

import { AddKinDialog, type KinfolkOption } from './AddKinDialog';

const OPTIONS: KinfolkOption[] = [
  { id: 'kf1', label: 'Jamie Halbrook' },
  { id: 'kf2', label: 'Amy Adams' },
];

beforeEach(() => {
  createKin.mockReset();
});

describe('AddKinDialog', () => {
  it('opens with no household chosen and species/gender defaulted per the controlled vocabulary', () => {
    render(<AddKinDialog kinfolkOptions={OPTIONS} onClose={vi.fn()} onCreated={vi.fn()} />);
    expect(screen.getByLabelText('Household')).toHaveValue('');
    expect(screen.getByLabelText('Name')).toHaveValue('');
    expect(screen.getByLabelText('Species')).toHaveValue('Dog');
    expect(screen.getByLabelText('Gender')).toHaveValue('');
  });

  it('preselects a household when initialKinfolkId is given (launched-from-household case)', () => {
    render(
      <AddKinDialog kinfolkOptions={OPTIONS} initialKinfolkId="kf2" onClose={vi.fn()} onCreated={vi.fn()} />,
    );
    expect(screen.getByLabelText('Household')).toHaveValue('kf2');
  });

  it('lists every household option by label', () => {
    render(<AddKinDialog kinfolkOptions={OPTIONS} onClose={vi.fn()} onCreated={vi.fn()} />);
    expect(screen.getByRole('option', { name: 'Jamie Halbrook' })).toBeInTheDocument();
    expect(screen.getByRole('option', { name: 'Amy Adams' })).toBeInTheDocument();
  });

  it('creates the kin with the trimmed fields, tied to the chosen household, and reports success via onCreated', async () => {
    createKin.mockResolvedValue('new-kin-1');
    const onCreated = vi.fn();
    render(<AddKinDialog kinfolkOptions={OPTIONS} onClose={vi.fn()} onCreated={onCreated} />);

    await userEvent.selectOptions(screen.getByLabelText('Household'), 'kf1');
    await userEvent.type(screen.getByLabelText('Name'), '  Biscuit  ');
    await userEvent.selectOptions(screen.getByLabelText('Species'), 'Cat');
    await userEvent.type(screen.getByLabelText('Breed'), 'Tabby');
    await userEvent.type(screen.getByLabelText('Age'), '3');
    await userEvent.selectOptions(screen.getByLabelText('Gender'), 'Female');

    await userEvent.click(screen.getByRole('button', { name: /^add kin$/i }));

    await waitFor(() =>
      expect(createKin).toHaveBeenCalledWith({
        kinfolkId: 'kf1',
        name: '  Biscuit  ',
        species: 'Cat',
        breed: 'Tabby',
        age: '3',
        sex: 'Female',
      }),
    );
    await waitFor(() => expect(onCreated).toHaveBeenCalledWith('new-kin-1'));
  });

  it('rejects saving with no household, no name, or no gender chosen', async () => {
    render(<AddKinDialog kinfolkOptions={OPTIONS} onClose={vi.fn()} onCreated={vi.fn()} />);
    await userEvent.click(screen.getByRole('button', { name: /^add kin$/i }));

    expect(await screen.findAllByRole('alert')).toHaveLength(3);
    expect(createKin).not.toHaveBeenCalled();
  });

  it('surfaces a required-field error on blur alone, before any save attempt (AO-44)', async () => {
    render(<AddKinDialog kinfolkOptions={OPTIONS} onClose={vi.fn()} onCreated={vi.fn()} />);
    // Focus the name field, then leave it blank. Its error appears without a save
    // click, and the still-untouched household/gender fields stay silent.
    await userEvent.click(screen.getByLabelText('Name'));
    await userEvent.tab();
    expect(await screen.findByText(/name can't be blank/i)).toBeInTheDocument();
    expect(screen.queryByText(/pick a household/i)).toBeNull();
    expect(screen.queryByText(/pick a gender/i)).toBeNull();
    expect(createKin).not.toHaveBeenCalled();
  });

  it('disables Cancel and Add while a create is in flight', async () => {
    let resolveCreate!: (id: string) => void;
    createKin.mockReturnValue(new Promise<string>((resolve) => (resolveCreate = resolve)));
    render(<AddKinDialog kinfolkOptions={OPTIONS} onClose={vi.fn()} onCreated={vi.fn()} />);

    await userEvent.selectOptions(screen.getByLabelText('Household'), 'kf1');
    await userEvent.type(screen.getByLabelText('Name'), 'Biscuit');
    await userEvent.selectOptions(screen.getByLabelText('Gender'), 'Female');
    await userEvent.click(screen.getByRole('button', { name: /^add kin$/i }));

    expect(screen.getByRole('button', { name: /adding/i })).toBeDisabled();
    expect(screen.getByRole('button', { name: /^cancel$/i })).toBeDisabled();
    expect(screen.getByLabelText('Name')).toBeDisabled();

    resolveCreate('new-kin-2');
    await waitFor(() => expect(screen.queryByRole('button', { name: /adding/i })).toBeNull());
  });

  it('fails loud on a rejected create: names the call, keeps the dialog open, never calls onCreated', async () => {
    createKin.mockRejectedValue(new Error('permission-denied'));
    const onCreated = vi.fn();
    render(<AddKinDialog kinfolkOptions={OPTIONS} onClose={vi.fn()} onCreated={onCreated} />);

    await userEvent.selectOptions(screen.getByLabelText('Household'), 'kf1');
    await userEvent.type(screen.getByLabelText('Name'), 'Biscuit');
    await userEvent.selectOptions(screen.getByLabelText('Gender'), 'Female');
    await userEvent.click(screen.getByRole('button', { name: /^add kin$/i }));

    expect(await screen.findByText(/createKin failed:.*permission-denied/i)).toBeInTheDocument();
    expect(onCreated).not.toHaveBeenCalled();
    expect(screen.getByRole('button', { name: /^add kin$/i })).toBeEnabled();
  });

  it('calls onClose (discarding the draft) when Cancel is clicked', async () => {
    const onClose = vi.fn();
    render(<AddKinDialog kinfolkOptions={OPTIONS} onClose={onClose} onCreated={vi.fn()} />);
    await userEvent.click(screen.getByRole('button', { name: /^cancel$/i }));
    expect(onClose).toHaveBeenCalledOnce();
    expect(createKin).not.toHaveBeenCalled();
  });
});
