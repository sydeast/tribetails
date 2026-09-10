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
// The seeded breed bank, stubbed at the hook so these tests never reach a
// callable. `breedBanks` is what the Breed dropdown will offer; `breedsFailed`
// drives the disclosed-degradation note.
const { breedBanks, breedsFailed } = vi.hoisted(() => ({
  breedBanks: { current: { dogBreeds: ['Border Collie', 'Boxer'], catBreeds: ['Bengal'] } },
  breedsFailed: { current: false },
}));
vi.mock('../api/breeds', async (orig) => ({
  ...(await orig<typeof import('../api/breeds')>()),
  useBreedBanks: () => ({ banks: breedBanks.current, loading: false, failed: breedsFailed.current }),
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
  breedBanks.current = { dogBreeds: ['Border Collie', 'Boxer'], catBreeds: ['Bengal'] };
  breedsFailed.current = false;
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

  /**
   * #687: the kinfolk IS the owner, so a second contact record on the kin doc
   * is redundant and can drift. Dropped from the editor; the stored
   * ownerEmail/ownerPhone values are left untouched and unread on both
   * platforms (see api/kinView.ts and the Android Kin model).
   */
  it('has no Owner contact section and never sends ownerEmail/ownerPhone in the save patch', async () => {
    getKin.mockResolvedValue(kin());
    updateKin.mockResolvedValue(undefined);
    render(<KinEdit kinId="p1" kinName="Willow" onDone={vi.fn()} onCancel={vi.fn()} />);
    await screen.findByText('Name');
    expect(screen.queryByText('Owner contact')).not.toBeInTheDocument();
    expect(screen.queryByText('Owner email')).not.toBeInTheDocument();
    expect(screen.queryByText('Owner phone')).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: /save changes/i }));
    await waitFor(() => expect(updateKin).toHaveBeenCalledTimes(1));
    const [, patch] = updateKin.mock.calls[0]!;
    expect('ownerEmail' in patch).toBe(false);
    expect('ownerPhone' in patch).toBe(false);
  });
});
/**
 * Fix-backlog 5.4 (AuntieOS_Fix_Backlog_2026-06-02.md:90): "Remove vet info box
 * from the pet (Kin). Vets attach to the Kinfolk (owner), not the Kin. Stop
 * adding an add/edit vet info box to the pet profile. It may be shown READ-ONLY
 * on the Kin, but never as an entry box there." Android has complied since
 * DirectoryViewModel.kt:1067; React's editor had not.
 */
describe('KinEdit vet rule (fix-backlog 5.4: vets attach to the Kinfolk)', () => {
  it('offers no vet entry box on the pet, while still rendering the other Health fields', async () => {
    getKin.mockResolvedValue(kin({ vetInfo: 'Oak Hill Animal Clinic, (512) 555-0100' }));
    render(<KinEdit kinId="p1" kinName="Willow" onDone={vi.fn()} onCancel={vi.fn()} />);
    await screen.findByText('Name');
    // The Health panel is still here, so this asserts a removed FIELD, not a
    // removed panel (which would pass for the wrong reason).
    expect(screen.getByText('Health')).toBeInTheDocument();
    expect(screen.getByText('Vaccinations')).toBeInTheDocument();
    expect(screen.getByText('Medication / health notes')).toBeInTheDocument();
    expect(screen.queryByText('Vet info')).not.toBeInTheDocument();
    // Nothing anywhere on the editor is seeded with the stored vet value, so it
    // cannot be typed into some other input either.
    const inputs = [
      ...document.querySelectorAll<HTMLInputElement | HTMLTextAreaElement>('input, textarea'),
    ];
    expect(inputs.some((el) => el.value.includes('Oak Hill Animal Clinic'))).toBe(false);
  });
  it('never sends vetInfo in the save patch, so the stored household vet is left alone', async () => {
    getKin.mockResolvedValue(kin({ vetInfo: 'Oak Hill Animal Clinic, (512) 555-0100' }));
    updateKin.mockResolvedValue(undefined);
    render(<KinEdit kinId="p1" kinName="Willow" onDone={vi.fn()} onCancel={vi.fn()} />);
    await screen.findByText('Name');
    await userEvent.click(screen.getByRole('button', { name: /save changes/i }));
    await waitFor(() => expect(updateKin).toHaveBeenCalledTimes(1));
    const [, patch] = updateKin.mock.calls[0]!;
    // `updateKin` patches through `updateDoc`, a field-level MERGE, so an absent
    // key preserves the stored value. Present-but-blank would ERASE it, which is
    // why this asserts the key is missing rather than merely falsy.
    expect('vetInfo' in patch).toBe(false);
    // The rest of the Health panel still saves normally.
    expect('vaccinations' in patch).toBe(true);
    expect('medicationHealthNotes' in patch).toBe(true);
  });

  describe('breed dropdown', () => {
    it('offers the dog bank for a Dog and saves the picked breed', async () => {
      getKin.mockResolvedValue(kin({ species: 'Dog', breed: '' }));
      updateKin.mockResolvedValue(undefined);
      render(<KinEdit kinId="p1" kinName="Willow" onDone={vi.fn()} onCancel={vi.fn()} />);

      await userEvent.click(await screen.findByLabelText('Breed'));
      await userEvent.click(await screen.findByRole('option', { name: 'Boxer' }));
      await userEvent.click(screen.getByRole('button', { name: /save changes/i }));

      await waitFor(() => expect(updateKin).toHaveBeenCalledTimes(1));
      expect(updateKin.mock.calls[0]![1].breed).toBe('Boxer');
    });

    it('follows Species to the cat bank', async () => {
      getKin.mockResolvedValue(kin({ species: 'Cat', breed: '' }));
      render(<KinEdit kinId="p1" kinName="Willow" onDone={vi.fn()} onCancel={vi.fn()} />);
      await userEvent.click(await screen.findByLabelText('Breed'));
      const options = await screen.findAllByTestId('breedfield-option');
      expect(options.map((o) => o.textContent)).toEqual(['Bengal']);
    });

    it('offers no bank for a species that has none, and stays a plain free-text field', async () => {
      getKin.mockResolvedValue(kin({ species: 'Reptile', breed: '' }));
      render(<KinEdit kinId="p1" kinName="Willow" onDone={vi.fn()} onCancel={vi.fn()} />);
      const input = await screen.findByLabelText('Breed');
      await userEvent.click(input);
      expect(screen.queryByRole('listbox')).not.toBeInTheDocument();
      // No note either: an unseeded species is expected, not a fault.
      expect(screen.queryByTestId('breedfield-note')).not.toBeInTheDocument();
      await userEvent.type(input, 'Ball python');
      expect(input).toHaveValue('Ball python');
    });

    it('discloses a failed bank load for a species that should have one', async () => {
      breedBanks.current = { dogBreeds: [], catBreeds: [] };
      breedsFailed.current = true;
      getKin.mockResolvedValue(kin({ species: 'Dog', breed: '' }));
      render(<KinEdit kinId="p1" kinName="Willow" onDone={vi.fn()} onCancel={vi.fn()} />);
      expect(await screen.findByTestId('breedfield-note')).toHaveTextContent(
        'Breed list failed to load (getBreeds), type it in.',
      );
    });

    // The regression this pins: useBreedBanks's `failed` is only true when the
    // getBreeds call itself throws. When it resolves normally but the bank is
    // genuinely empty (dog_breeds / cat_breeds not seeded in this environment),
    // `failed` stays false, and a note gated on that flag alone renders NOTHING,
    // an operator-facing silent-empty field indistinguishable from "nothing to
    // see here". This must disclose too, and name the collections since it is a
    // seeding gap, not a fault a retry would fix.
    it('discloses an EMPTY bank load, not just a failed one, for a species that should have one', async () => {
      breedBanks.current = { dogBreeds: [], catBreeds: [] };
      breedsFailed.current = false;
      getKin.mockResolvedValue(kin({ species: 'Dog', breed: '' }));
      render(<KinEdit kinId="p1" kinName="Willow" onDone={vi.fn()} onCancel={vi.fn()} />);
      expect(await screen.findByTestId('breedfield-note')).toHaveTextContent(
        'Breed bank is empty (dog_breeds / cat_breeds not seeded), type it in.',
      );
    });

    it('still saves a breed the bank has never heard of', async () => {
      getKin.mockResolvedValue(kin({ species: 'Dog', breed: '' }));
      updateKin.mockResolvedValue(undefined);
      render(<KinEdit kinId="p1" kinName="Willow" onDone={vi.fn()} onCancel={vi.fn()} />);
      await userEvent.type(await screen.findByLabelText('Breed'), 'Lab / pit mix');
      await userEvent.click(screen.getByRole('button', { name: /save changes/i }));
      await waitFor(() => expect(updateKin).toHaveBeenCalledTimes(1));
      expect(updateKin.mock.calls[0]![1].breed).toBe('Lab / pit mix');
    });
  });
});
