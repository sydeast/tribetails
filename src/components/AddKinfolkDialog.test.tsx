// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

const { createKinfolk } = vi.hoisted(() => ({ createKinfolk: vi.fn() }));
vi.mock('../api/directoryWrite', async () => {
  const actual = await vi.importActual<typeof import('../api/directoryWrite')>('../api/directoryWrite');
  return { ...actual, createKinfolk };
});

import { AddKinfolkDialog } from './AddKinfolkDialog';

beforeEach(() => {
  createKinfolk.mockReset();
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

  it('rejects a blank first/last name without calling createKinfolk', async () => {
    render(<AddKinfolkDialog onClose={vi.fn()} onCreated={vi.fn()} />);
    await userEvent.click(screen.getByRole('button', { name: /^add kinfolk$/i }));

    expect(await screen.findAllByRole('alert')).toHaveLength(2);
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
