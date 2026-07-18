// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { KinDetail } from '../api/kinView';

const { getKin } = vi.hoisted(() => ({ getKin: vi.fn() }));
vi.mock('../api/kinView', async (orig) => ({
  ...(await orig<typeof import('../api/kinView')>()),
  getKin,
}));
const { updateKin, setKinArchived } = vi.hoisted(() => ({ updateKin: vi.fn(), setKinArchived: vi.fn() }));
vi.mock('../api/directoryWrite', async (orig) => ({
  ...(await orig<typeof import('../api/directoryWrite')>()),
  updateKin,
  setKinArchived,
}));

import { KinEdit } from './KinEdit';
import { mergeKinDetail } from '../api/kinView';

function kin(over: Partial<KinDetail> = {}): KinDetail {
  return mergeKinDetail('p1', { name: 'Willow', species: 'Dog', status: 'active', ...over });
}

beforeEach(() => {
  getKin.mockReset();
  updateKin.mockReset();
  setKinArchived.mockReset();
});

describe('KinEdit', () => {
  it('loads the kin into the form, saves the edited fields, then signals done', async () => {
    getKin.mockResolvedValue(kin({ breed: 'Lab' }));
    updateKin.mockResolvedValue(undefined);
    const onDone = vi.fn();
    render(<KinEdit kinId="p1" kinName="Willow" onDone={onDone} onCancel={vi.fn()} />);

    const nameInput = (await screen.findByText('Name')).parentElement!.querySelector('input')!;
    expect(nameInput).toHaveValue('Willow');
    await userEvent.clear(nameInput);
    await userEvent.type(nameInput, 'Willow B');
    await userEvent.click(screen.getByRole('button', { name: /save changes/i }));

    await waitFor(() => expect(updateKin).toHaveBeenCalledTimes(1));
    const [id, patch] = updateKin.mock.calls[0]!;
    expect(id).toBe('p1');
    expect(patch.name).toBe('Willow B');
    expect(patch.breed).toBe('Lab');
    await waitFor(() => expect(onDone).toHaveBeenCalledOnce());
  });

  it('blocks save on a blank name', async () => {
    getKin.mockResolvedValue(kin());
    render(<KinEdit kinId="p1" kinName="Willow" onDone={vi.fn()} onCancel={vi.fn()} />);
    const nameInput = (await screen.findByText('Name')).parentElement!.querySelector('input')!;
    await userEvent.clear(nameInput);
    expect(screen.getByRole('button', { name: /save changes/i })).toBeDisabled();
    expect(updateKin).not.toHaveBeenCalled();
  });

  it('archives the pet via setKinArchived, then signals done', async () => {
    getKin.mockResolvedValue(kin({ status: 'active' }));
    setKinArchived.mockResolvedValue(undefined);
    const onDone = vi.fn();
    render(<KinEdit kinId="p1" kinName="Willow" onDone={onDone} onCancel={vi.fn()} />);
    await screen.findByText('Name');
    await userEvent.click(screen.getByRole('button', { name: /^archive$/i }));
    await waitFor(() => expect(setKinArchived).toHaveBeenCalledWith('p1', true));
    await waitFor(() => expect(onDone).toHaveBeenCalledOnce());
  });

  it('shows Restore (not Archive) for an already-archived pet', async () => {
    getKin.mockResolvedValue(kin({ status: 'archived' }));
    render(<KinEdit kinId="p1" kinName="Willow" onDone={vi.fn()} onCancel={vi.fn()} />);
    expect(await screen.findByRole('button', { name: /restore/i })).toBeInTheDocument();
  });

  it('fails loud (names the callable) when a save rejects, and does not signal done', async () => {
    getKin.mockResolvedValue(kin());
    updateKin.mockRejectedValue(new Error('permission-denied'));
    const onDone = vi.fn();
    render(<KinEdit kinId="p1" kinName="Willow" onDone={onDone} onCancel={vi.fn()} />);
    await screen.findByText('Name');
    await userEvent.click(screen.getByRole('button', { name: /save changes/i }));
    expect(await screen.findByText(/updateKin failed:.*permission-denied/i)).toBeInTheDocument();
    expect(onDone).not.toHaveBeenCalled();
  });

  it('calls onCancel from the header Cancel', async () => {
    getKin.mockResolvedValue(kin());
    const onCancel = vi.fn();
    render(<KinEdit kinId="p1" kinName="Willow" onDone={vi.fn()} onCancel={onCancel} />);
    await screen.findByText('Name');
    await userEvent.click(screen.getAllByRole('button', { name: /^cancel$/i })[0]!);
    expect(onCancel).toHaveBeenCalled();
  });
});
