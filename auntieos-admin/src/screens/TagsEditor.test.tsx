// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, within, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { TAG_PALETTE, DEFAULT_TAG_COLOR, type TagDef } from '../lib/tags/model';

const getBusinessSettings = vi.fn();
vi.mock('../api/settings', () => ({ getBusinessSettings: () => getBusinessSettings() }));
const saveBusinessSettings = vi.fn();
const removeBusinessTag = vi.fn();
vi.mock('../api/settingsWrite', () => ({
  saveBusinessSettings: (patch: unknown) => saveBusinessSettings(patch),
  removeBusinessTag: (scope: unknown, name: unknown) => removeBusinessTag(scope, name),
}));

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

async function petPanel(): Promise<HTMLElement> {
  return (await screen.findByText('Kin tags')).closest('section') as HTMLElement;
}

beforeEach(() => {
  getBusinessSettings.mockReset();
  saveBusinessSettings.mockReset();
  saveBusinessSettings.mockResolvedValue({ updatedAt: 'now', updatedBy: 'auntie' });
  removeBusinessTag.mockReset();
  removeBusinessTag.mockImplementation((scope: string, name: string) =>
    Promise.resolve({ ok: true, scope, name, recordsTouched: 0, vocabRemoved: true }),
  );
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

  // ── Remove is a cascade now (#713) ──────────────────────────────────────
  //
  // "IF THE TAG IS DELETED THEN IT GOES AWAY COMPLETELY." Pressing Remove no
  // longer edits the local list and waits for Save; it confirms, then calls
  // `removeBusinessTag`, which also strips the name off every kinfolk/kin doc.

  it('asks before deleting, and calls nothing until the operator confirms', async () => {
    getBusinessSettings.mockResolvedValue(settings([{ name: 'VIP', color: orange, icon: '⭐' }], []));
    render(<TagsEditor onBack={vi.fn()} />);
    const panel = await householdPanel();
    await userEvent.click(within(panel).getByRole('button', { name: /^remove$/i }));

    const dialog = screen.getByRole('dialog', { name: /remove "vip"\?/i });
    expect(
      within(dialog).getByText(/off every household carrying it/i),
    ).toBeInTheDocument();
    expect(removeBusinessTag).not.toHaveBeenCalled();

    await userEvent.click(within(dialog).getByRole('button', { name: /^cancel$/i }));
    expect(removeBusinessTag).not.toHaveBeenCalled();
    expect(within(await householdPanel()).getByText('VIP')).toBeInTheDocument();
  });

  it('confirming calls removeBusinessTag with the scope and name, and never saves the list', async () => {
    getBusinessSettings.mockResolvedValue(settings([{ name: 'VIP', color: orange, icon: '⭐' }], []));
    removeBusinessTag.mockResolvedValue({
      ok: true,
      scope: 'household',
      name: 'VIP',
      recordsTouched: 3,
      vocabRemoved: true,
    });
    render(<TagsEditor onBack={vi.fn()} />);
    const panel = await householdPanel();
    await userEvent.click(within(panel).getByRole('button', { name: /^remove$/i }));
    await userEvent.click(screen.getByRole('button', { name: /remove everywhere/i }));

    await waitFor(() => expect(removeBusinessTag).toHaveBeenCalledWith('household', 'VIP'));
    // The row is gone from the editor, and the CASCADE is reported by count.
    expect(within(await householdPanel()).queryByText('VIP')).toBeNull();
    expect(await screen.findByText(/"VIP" is gone\. It came off 3 households\./)).toBeInTheDocument();
    // Not a settings write: the callable did both halves server-side, so Save
    // must not be armed with a change that has already happened.
    expect(saveBusinessSettings).not.toHaveBeenCalled();
    expect(screen.getByRole('button', { name: /save tags/i })).toBeDisabled();
  });

  it('sends the pet scope from the Kin panel, so a household tag of the same name is untouched', async () => {
    getBusinessSettings.mockResolvedValue(
      settings([{ name: 'Meds Needed', color: orange, icon: '' }], [{ name: 'Meds Needed', color: coral, icon: '' }]),
    );
    render(<TagsEditor onBack={vi.fn()} />);
    const panel = await petPanel();
    await userEvent.click(within(panel).getByRole('button', { name: /^remove$/i }));
    await userEvent.click(screen.getByRole('button', { name: /remove everywhere/i }));

    await waitFor(() => expect(removeBusinessTag).toHaveBeenCalledWith('pet', 'Meds Needed'));
    expect(within(await petPanel()).queryByText('Meds Needed')).toBeNull();
    expect(within(await householdPanel()).getByText('Meds Needed')).toBeInTheDocument();
  });

  it('reports plainly when the tag was on nobody', async () => {
    getBusinessSettings.mockResolvedValue(settings([{ name: 'Unused', color: orange, icon: '' }], []));
    render(<TagsEditor onBack={vi.fn()} />);
    await userEvent.click(within(await householdPanel()).getByRole('button', { name: /^remove$/i }));
    await userEvent.click(screen.getByRole('button', { name: /remove everywhere/i }));

    expect(
      await screen.findByText(/"Unused" is gone\. No households were carrying it\./),
    ).toBeInTheDocument();
  });

  it('a failed remove is fail-loud and leaves the tag on the list to retry', async () => {
    getBusinessSettings.mockResolvedValue(settings([{ name: 'VIP', color: orange, icon: '' }], []));
    removeBusinessTag.mockRejectedValue(new Error('permission-denied'));
    render(<TagsEditor onBack={vi.fn()} />);
    await userEvent.click(within(await householdPanel()).getByRole('button', { name: /^remove$/i }));
    await userEvent.click(screen.getByRole('button', { name: /remove everywhere/i }));

    expect(await screen.findByText(/couldn't remove "VIP".*permission-denied/i)).toBeInTheDocument();
    expect(within(await householdPanel()).getByText('VIP')).toBeInTheDocument();
  });

  it('the heads-up banner states the cascade, not the old label-only behavior', async () => {
    getBusinessSettings.mockResolvedValue(settings([], []));
    render(<TagsEditor onBack={vi.fn()} />);
    await householdPanel();
    expect(
      screen.getByText(/removing a tag deletes it everywhere/i),
    ).toBeInTheDocument();
    expect(screen.queryByText(/suggestion list/i)).toBeNull();
    expect(screen.queryByText(/keep it, shown plainly/i)).toBeNull();
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
