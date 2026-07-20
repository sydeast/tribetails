// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, within, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { TAG_PALETTE, DEFAULT_TAG_COLOR, type TagDef } from '../lib/tags/model';

const getBusinessSettings = vi.fn();
vi.mock('../api/settings', () => ({ getBusinessSettings: () => getBusinessSettings() }));
const saveBusinessSettings = vi.fn();
vi.mock('../api/settingsWrite', () => ({ saveBusinessSettings: (patch: unknown) => saveBusinessSettings(patch) }));

import { TagsEditor } from './TagsEditor';

const orange = TAG_PALETTE[1]!;
const coral = TAG_PALETTE[4]!;

/** The two fields TagsEditor reads off business settings; the rest is irrelevant here. */
function settings(household: TagDef[], pet: TagDef[]) {
  return { householdTags: household, petTags: pet };
}

async function householdPanel(): Promise<HTMLElement> {
  return (await screen.findByText('Household tags')).closest('section') as HTMLElement;
}

beforeEach(() => {
  getBusinessSettings.mockReset();
  saveBusinessSettings.mockReset();
  saveBusinessSettings.mockResolvedValue({ updatedAt: 'now', updatedBy: 'auntie' });
});

describe('TagsEditor', () => {
  it('surfaces a load failure fail-loud instead of an empty editor', async () => {
    getBusinessSettings.mockRejectedValue(new Error('permission-denied'));
    render(<TagsEditor onBack={vi.fn()} />);
    expect(await screen.findByText(/couldn't read tags.*permission-denied/i)).toBeInTheDocument();
  });

  it('adds a household tag and saves both lists (default color, no emoji)', async () => {
    getBusinessSettings.mockResolvedValue(settings([], []));
    render(<TagsEditor onBack={vi.fn()} />);
    const panel = await householdPanel();
    await userEvent.type(within(panel).getByLabelText('New household tag name'), 'VIP');
    await userEvent.click(within(panel).getByRole('button', { name: /add tag/i }));
    await userEvent.click(screen.getByRole('button', { name: /save tags/i }));

    await waitFor(() => expect(saveBusinessSettings).toHaveBeenCalledTimes(1));
    const payload = saveBusinessSettings.mock.calls[0]![0];
    expect(payload.householdTags).toEqual([{ name: 'VIP', color: DEFAULT_TAG_COLOR, icon: '' }]);
    expect(payload.petTags).toEqual([]);
  });

  it('keeps the two lists independent: adding a household tag leaves petTags untouched', async () => {
    getBusinessSettings.mockResolvedValue(settings([], [{ name: 'Reactive', color: coral, icon: '' }]));
    render(<TagsEditor onBack={vi.fn()} />);
    const panel = await householdPanel();
    await userEvent.type(within(panel).getByLabelText('New household tag name'), 'VIP');
    await userEvent.click(within(panel).getByRole('button', { name: /add tag/i }));
    await userEvent.click(screen.getByRole('button', { name: /save tags/i }));

    await waitFor(() => expect(saveBusinessSettings).toHaveBeenCalledTimes(1));
    const payload = saveBusinessSettings.mock.calls[0]![0];
    expect(payload.householdTags.map((t: TagDef) => t.name)).toEqual(['VIP']);
    expect(payload.petTags).toEqual([{ name: 'Reactive', color: coral, icon: '' }]);
  });

  it('removes a tag so the saved list no longer carries it', async () => {
    getBusinessSettings.mockResolvedValue(settings([{ name: 'VIP', color: orange, icon: '⭐' }], []));
    render(<TagsEditor onBack={vi.fn()} />);
    const panel = await householdPanel();
    await userEvent.click(within(panel).getByRole('button', { name: /^remove$/i }));
    await userEvent.click(screen.getByRole('button', { name: /save tags/i }));

    await waitFor(() => expect(saveBusinessSettings).toHaveBeenCalledTimes(1));
    expect(saveBusinessSettings.mock.calls[0]![0].householdTags).toEqual([]);
  });

  it('edits an existing tag color in place (name unchanged)', async () => {
    getBusinessSettings.mockResolvedValue(settings([{ name: 'VIP', color: DEFAULT_TAG_COLOR, icon: '' }], []));
    render(<TagsEditor onBack={vi.fn()} />);
    const panel = await householdPanel();
    const row = (within(panel).getByText('VIP').closest('.tagsEditor__row')) as HTMLElement;
    await userEvent.click(within(row).getByRole('button', { name: /orange/i }));
    await userEvent.click(screen.getByRole('button', { name: /save tags/i }));

    await waitFor(() => expect(saveBusinessSettings).toHaveBeenCalledTimes(1));
    expect(saveBusinessSettings.mock.calls[0]![0].householdTags).toEqual([
      { name: 'VIP', color: orange, icon: '' },
    ]);
  });

  it('rejects a duplicate tag name fail-loud without saving', async () => {
    getBusinessSettings.mockResolvedValue(settings([{ name: 'VIP', color: orange, icon: '' }], []));
    render(<TagsEditor onBack={vi.fn()} />);
    const panel = await householdPanel();
    await userEvent.type(within(panel).getByLabelText('New household tag name'), 'vip');
    await userEvent.click(within(panel).getByRole('button', { name: /add tag/i }));
    expect(within(panel).getByText(/already exists/i)).toBeInTheDocument();
  });

  it('surfaces a save failure fail-loud and does not clear the edit', async () => {
    getBusinessSettings.mockResolvedValue(settings([], []));
    saveBusinessSettings.mockRejectedValue(new Error('permission-denied'));
    render(<TagsEditor onBack={vi.fn()} />);
    const panel = await householdPanel();
    await userEvent.type(within(panel).getByLabelText('New household tag name'), 'VIP');
    await userEvent.click(within(panel).getByRole('button', { name: /add tag/i }));
    await userEvent.click(screen.getByRole('button', { name: /save tags/i }));

    expect(await screen.findByText(/couldn't save tags.*permission-denied/i)).toBeInTheDocument();
    expect(within(await householdPanel()).getByText('VIP')).toBeInTheDocument();
  });
});
