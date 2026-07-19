// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { TAG_PALETTE, DEFAULT_TAG_COLOR, type TagDef } from '../lib/tags/model';

const getBusinessSettings = vi.fn();
vi.mock('../api/settings', () => ({ getBusinessSettings: () => getBusinessSettings() }));
const saveBusinessSettings = vi.fn();
vi.mock('../api/settingsWrite', () => ({ saveBusinessSettings: (patch: unknown) => saveBusinessSettings(patch) }));

import { ProfileTagsSection } from './ProfileTagsSection';

const orange = TAG_PALETTE[1]!;

function settings(household: TagDef[], pet: TagDef[]) {
  return { householdTags: household, petTags: pet };
}

beforeEach(() => {
  getBusinessSettings.mockReset();
  getBusinessSettings.mockResolvedValue(settings([], []));
  saveBusinessSettings.mockReset();
  saveBusinessSettings.mockResolvedValue({ updatedAt: 'now', updatedBy: 'auntie' });
});

describe('ProfileTagsSection', () => {
  it('renders the assigned tags as rich chips once the vocabulary loads', async () => {
    getBusinessSettings.mockResolvedValue(settings([{ name: 'VIP', color: orange, icon: '⭐' }], []));
    render(<ProfileTagsSection scope="household" initialTags={['VIP']} onSaveTags={vi.fn().mockResolvedValue(undefined)} />);
    expect(await screen.findByText('⭐')).toBeInTheDocument();
    expect(screen.getByText('VIP')).toBeInTheDocument();
  });

  it('adds a free-form tag and saves the next list', async () => {
    const onSaveTags = vi.fn().mockResolvedValue(undefined);
    render(<ProfileTagsSection scope="household" initialTags={['VIP']} onSaveTags={onSaveTags} />);
    await userEvent.type(screen.getByLabelText(/add a household tag/i), 'Slow pay{Enter}');
    await waitFor(() => expect(onSaveTags).toHaveBeenCalledWith(['VIP', 'Slow pay']));
  });

  it('removes a tag and saves the shortened list', async () => {
    const onSaveTags = vi.fn().mockResolvedValue(undefined);
    render(<ProfileTagsSection scope="pet" initialTags={['Reactive']} onSaveTags={onSaveTags} />);
    await userEvent.click(await screen.findByRole('button', { name: /remove reactive tag/i }));
    await waitFor(() => expect(onSaveTags).toHaveBeenCalledWith([]));
  });

  it('promotes a new name to the vocabulary (saveBusinessSettings) and assigns it', async () => {
    const onSaveTags = vi.fn().mockResolvedValue(undefined);
    render(<ProfileTagsSection scope="household" initialTags={[]} onSaveTags={onSaveTags} />);
    await userEvent.type(screen.getByLabelText(/add a household tag/i), 'Grooming');
    await userEvent.click(await screen.findByRole('button', { name: /add .*grooming.* to your tags/i }));

    await waitFor(() => expect(saveBusinessSettings).toHaveBeenCalledTimes(1));
    expect(saveBusinessSettings.mock.calls[0]![0]).toEqual({
      householdTags: [{ name: 'Grooming', color: DEFAULT_TAG_COLOR, icon: '' }],
    });
    expect(onSaveTags).toHaveBeenCalledWith(['Grooming']);
  });

  it('targets the pet vocabulary field when scope is pet', async () => {
    const onSaveTags = vi.fn().mockResolvedValue(undefined);
    render(<ProfileTagsSection scope="pet" initialTags={[]} onSaveTags={onSaveTags} />);
    await userEvent.type(screen.getByLabelText(/add a pet tag/i), 'Grooming');
    await userEvent.click(await screen.findByRole('button', { name: /add .*grooming.* to your tags/i }));
    await waitFor(() => expect(saveBusinessSettings).toHaveBeenCalledTimes(1));
    expect(Object.keys(saveBusinessSettings.mock.calls[0]![0])).toEqual(['petTags']);
  });

  it('reverts the chip and surfaces the error fail-loud when a save fails', async () => {
    const onSaveTags = vi.fn().mockRejectedValue(new Error('permission-denied'));
    render(<ProfileTagsSection scope="household" initialTags={[]} onSaveTags={onSaveTags} />);
    await userEvent.type(screen.getByLabelText(/add a household tag/i), 'Slow pay{Enter}');
    expect(await screen.findByText(/couldn't save tags.*permission-denied/i)).toBeInTheDocument();
    // reverted: the optimistic chip is gone
    await waitFor(() => expect(screen.queryByText('Slow pay')).toBeNull());
  });

  it('warns fail-loud if the vocabulary suggestions cannot be loaded, without blocking edits', async () => {
    getBusinessSettings.mockRejectedValue(new Error('offline'));
    const onSaveTags = vi.fn().mockResolvedValue(undefined);
    render(<ProfileTagsSection scope="household" initialTags={[]} onSaveTags={onSaveTags} />);
    expect(await screen.findByText(/couldn't load tag suggestions.*offline/i)).toBeInTheDocument();
    // still editable
    await userEvent.type(screen.getByLabelText(/add a household tag/i), 'VIP{Enter}');
    await waitFor(() => expect(onSaveTags).toHaveBeenCalledWith(['VIP']));
  });
});
