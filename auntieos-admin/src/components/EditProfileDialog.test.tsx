// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { type UserProfile } from '../api/account';

const { saveUserProfile } = vi.hoisted(() => ({ saveUserProfile: vi.fn() }));
vi.mock('../api/accountWrite', () => ({ saveUserProfile }));

import { EditProfileDialog } from './EditProfileDialog';

function profile(over: Partial<UserProfile> = {}): UserProfile {
  return {
    uid: 'op-1',
    email: 'auntie@tribetails.com',
    displayName: 'Auntie Nora',
    firstName: 'Nora',
    lastName: 'Brooks',
    phone: '555-0100',
    title: 'Head of Care',
    photoUrl: '',
    bio: 'Loves dogs.',
    ...over,
  };
}

beforeEach(() => {
  saveUserProfile.mockReset();
});

describe('EditProfileDialog', () => {
  it('opens pre-filled from the loaded profile, never blank', () => {
    render(<EditProfileDialog uid="op-1" profile={profile()} onClose={vi.fn()} onSaved={vi.fn()} />);
    expect(screen.getByLabelText('Display name')).toHaveValue('Auntie Nora');
    expect(screen.getByLabelText('First name')).toHaveValue('Nora');
    expect(screen.getByLabelText('Last name')).toHaveValue('Brooks');
    expect(screen.getByLabelText('Phone')).toHaveValue('555-0100');
    expect(screen.getByLabelText('Title')).toHaveValue('Head of Care');
    expect(screen.getByLabelText('Bio')).toHaveValue('Loves dogs.');
  });

  it('saves the trimmed edited fields and reports success via onSaved', async () => {
    saveUserProfile.mockResolvedValue(undefined);
    const onSaved = vi.fn();
    render(<EditProfileDialog uid="op-1" profile={profile()} onClose={vi.fn()} onSaved={onSaved} />);

    const title = screen.getByLabelText('Title');
    await userEvent.clear(title);
    await userEvent.type(title, '  Lead Auntie  ');

    await userEvent.click(screen.getByRole('button', { name: /^save$/i }));

    await waitFor(() =>
      expect(saveUserProfile).toHaveBeenCalledWith('op-1', {
        displayName: 'Auntie Nora',
        firstName: 'Nora',
        lastName: 'Brooks',
        phone: '555-0100',
        title: 'Lead Auntie',
        bio: 'Loves dogs.',
      }),
    );
    await waitFor(() => expect(onSaved).toHaveBeenCalledOnce());
  });

  it('rejects a blank display name without calling saveUserProfile', async () => {
    render(<EditProfileDialog uid="op-1" profile={profile()} onClose={vi.fn()} onSaved={vi.fn()} />);
    const name = screen.getByLabelText('Display name');
    await userEvent.clear(name);
    await userEvent.click(screen.getByRole('button', { name: /^save$/i }));

    expect(await screen.findByRole('alert')).toHaveTextContent(/blank/i);
    expect(saveUserProfile).not.toHaveBeenCalled();
  });

  it('disables Cancel and Save while a save is in flight', async () => {
    let resolveSave!: () => void;
    saveUserProfile.mockReturnValue(new Promise<void>((resolve) => (resolveSave = resolve)));
    render(<EditProfileDialog uid="op-1" profile={profile()} onClose={vi.fn()} onSaved={vi.fn()} />);

    await userEvent.click(screen.getByRole('button', { name: /^save$/i }));
    expect(screen.getByRole('button', { name: /saving/i })).toBeDisabled();
    expect(screen.getByRole('button', { name: /^cancel$/i })).toBeDisabled();
    expect(screen.getByLabelText('Display name')).toBeDisabled();

    resolveSave();
    await waitFor(() => expect(screen.queryByRole('button', { name: /saving/i })).toBeNull());
  });

  it('fails loud on a rejected save: names the callable, keeps the dialog open, never calls onSaved', async () => {
    saveUserProfile.mockRejectedValue(new Error('permission-denied'));
    const onSaved = vi.fn();
    render(<EditProfileDialog uid="op-1" profile={profile()} onClose={vi.fn()} onSaved={onSaved} />);

    await userEvent.click(screen.getByRole('button', { name: /^save$/i }));

    expect(await screen.findByText(/saveUserProfile failed:.*permission-denied/i)).toBeInTheDocument();
    expect(onSaved).not.toHaveBeenCalled();
    expect(screen.getByRole('button', { name: /^save$/i })).toBeEnabled();
  });

  it('calls onClose (discarding edits) when Cancel is clicked', async () => {
    const onClose = vi.fn();
    render(<EditProfileDialog uid="op-1" profile={profile()} onClose={onClose} onSaved={vi.fn()} />);
    await userEvent.click(screen.getByRole('button', { name: /^cancel$/i }));
    expect(onClose).toHaveBeenCalledOnce();
    expect(saveUserProfile).not.toHaveBeenCalled();
  });
});
