// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, within, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { TAG_PALETTE, DEFAULT_TAG_COLOR, type TagChange, type TagDef } from '../lib/tags/model';

const getBusinessSettings = vi.fn();
vi.mock('../api/settings', () => ({ getBusinessSettings: () => getBusinessSettings() }));
const saveBusinessSettings = vi.fn();
const changeBusinessTags = vi.fn();
const removeBusinessTag = vi.fn();
vi.mock('../api/settingsWrite', () => ({
  saveBusinessSettings: (patch: unknown) => saveBusinessSettings(patch),
  changeBusinessTags: (changes: unknown) => changeBusinessTags(changes),
  removeBusinessTag: (scope: unknown, name: unknown) => removeBusinessTag(scope, name),
}));

/**
 * #2205: the lists as the SERVER holds them, which a test can move on from what
 * the editor loaded (another device adding or deleting a tag). The fake applies
 * each change the way `changeBusinessTags` does and answers with both lists.
 */
let server: { householdTags: TagDef[]; petTags: TagDef[] };
function serverApplies(changes: TagChange[]) {
  for (const c of changes) {
    const key = c.scope === 'household' ? 'householdTags' : 'petTags';
    const list = server[key];
    const at = list.findIndex((t) => t.name.toLowerCase() === c.name.toLowerCase());
    if (c.action === 'add') {
      if (at >= 0) return Promise.reject(new Error(`A "${list[at]!.name}" tag already exists.`));
      server[key] = [...list, { name: c.name, color: c.color, icon: c.icon }];
    } else {
      if (at < 0) {
        return Promise.reject(
          new Error(`The tag list changed since this screen opened: "${c.name}" is no longer on it. Reload and try again.`),
        );
      }
      server[key] = list.map((t, i) => (i === at ? { ...t, color: c.color, icon: c.icon } : t));
    }
  }
  return Promise.resolve({ householdTags: server.householdTags, petTags: server.petTags });
}

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
  server = { householdTags: [], petTags: [] };
  changeBusinessTags.mockReset();
  changeBusinessTags.mockImplementation((changes: TagChange[]) => serverApplies(changes));
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

  it('adds a household tag: Save sends that one name (default color, no emoji), never a list', async () => {
    getBusinessSettings.mockResolvedValue(settings([], []));
    render(<TagsEditor onBack={vi.fn()} />);
    const panel = await householdPanel();
    await userEvent.type(within(panel).getByLabelText('New household tag name'), 'VIP');
    await userEvent.click(within(panel).getByRole('button', { name: /add tag/i }));
    await userEvent.click(screen.getByRole('button', { name: /save tags/i }));

    await waitFor(() => expect(changeBusinessTags).toHaveBeenCalledTimes(1));
    expect(changeBusinessTags.mock.calls[0]![0]).toEqual([
      { action: 'add', scope: 'household', name: 'VIP', color: DEFAULT_TAG_COLOR, icon: '' },
    ]);
    expect(saveBusinessSettings).not.toHaveBeenCalled();
    expect(await screen.findByText('Saved')).toBeInTheDocument();
  });

  it('keeps the two lists independent: adding a household tag sends nothing for the Kin list', async () => {
    server = { householdTags: [], petTags: [{ name: 'Reactive', color: coral, icon: '' }] };
    getBusinessSettings.mockResolvedValue(settings([], [{ name: 'Reactive', color: coral, icon: '' }]));
    render(<TagsEditor onBack={vi.fn()} />);
    const panel = await householdPanel();
    await userEvent.type(within(panel).getByLabelText('New household tag name'), 'VIP');
    await userEvent.click(within(panel).getByRole('button', { name: /add tag/i }));
    await userEvent.click(screen.getByRole('button', { name: /save tags/i }));

    await waitFor(() => expect(changeBusinessTags).toHaveBeenCalledTimes(1));
    const changes = changeBusinessTags.mock.calls[0]![0] as TagChange[];
    expect(changes.map((c) => [c.scope, c.name])).toEqual([['household', 'VIP']]);
  });

  // #2205: a screen left open never undoes tag changes made elsewhere.

  it('#2205: a tag added elsewhere after this screen loaded is kept, and shows once saved', async () => {
    getBusinessSettings.mockResolvedValue(settings([{ name: 'VIP', color: orange, icon: '' }], []));
    // Another device adds "Slow pay" after the editor read the list.
    server = {
      householdTags: [{ name: 'VIP', color: orange, icon: '' }, { name: 'Slow pay', color: coral, icon: '' }],
      petTags: [],
    };
    render(<TagsEditor onBack={vi.fn()} />);
    const panel = await householdPanel();
    expect(within(panel).queryByText('Slow pay')).toBeNull();
    await userEvent.type(within(panel).getByLabelText('New household tag name'), 'Gate code');
    await userEvent.click(within(panel).getByRole('button', { name: /add tag/i }));
    await userEvent.click(screen.getByRole('button', { name: /save tags/i }));

    await waitFor(() => expect(changeBusinessTags).toHaveBeenCalledTimes(1));
    expect(server.householdTags.map((t) => t.name)).toEqual(['VIP', 'Slow pay', 'Gate code']);
    expect(await within(await householdPanel()).findByText('Slow pay')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /save tags/i })).toBeDisabled();
  });

  it('#2205: a tag deleted elsewhere does not come back when this screen saves', async () => {
    getBusinessSettings.mockResolvedValue(
      settings([{ name: 'VIP', color: orange, icon: '' }, { name: 'Slow pay', color: coral, icon: '' }], []),
    );
    // Another device deletes "Slow pay" after the editor read the list.
    server = { householdTags: [{ name: 'VIP', color: orange, icon: '' }], petTags: [] };
    render(<TagsEditor onBack={vi.fn()} />);
    const panel = await householdPanel();
    await userEvent.type(within(panel).getByLabelText('New household tag name'), 'Gate code');
    await userEvent.click(within(panel).getByRole('button', { name: /add tag/i }));
    await userEvent.click(screen.getByRole('button', { name: /save tags/i }));

    await waitFor(() => expect(changeBusinessTags).toHaveBeenCalledTimes(1));
    expect(server.householdTags.map((t) => t.name)).toEqual(['VIP', 'Gate code']);
    await waitFor(() => expect(within(panel).queryByText('Slow pay')).toBeNull());
  });

  it('#2205: recolouring a tag deleted elsewhere is refused in plain words, with a way to reload', async () => {
    getBusinessSettings.mockResolvedValue(settings([{ name: 'VIP', color: DEFAULT_TAG_COLOR, icon: '' }], []));
    server = { householdTags: [], petTags: [] };
    render(<TagsEditor onBack={vi.fn()} />);
    const panel = await householdPanel();
    const row = within(panel).getByText('VIP').closest('.tagsEditor__row') as HTMLElement;
    await userEvent.click(within(row).getByRole('button', { name: /orange/i }));
    await userEvent.click(screen.getByRole('button', { name: /save tags/i }));

    expect(await screen.findByText(/the tag list changed since this screen opened/i)).toBeInTheDocument();
    expect(server.householdTags).toEqual([]);
    getBusinessSettings.mockResolvedValue(settings([], []));
    await userEvent.click(screen.getByRole('button', { name: 'Reload tags' }));
    await waitFor(() => expect(getBusinessSettings).toHaveBeenCalledTimes(2));
    expect(await screen.findByText(/no household tags yet/i)).toBeInTheDocument();
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
    server = { householdTags: [{ name: 'VIP', color: DEFAULT_TAG_COLOR, icon: '' }], petTags: [] };
    getBusinessSettings.mockResolvedValue(settings([{ name: 'VIP', color: DEFAULT_TAG_COLOR, icon: '' }], []));
    render(<TagsEditor onBack={vi.fn()} />);
    const panel = await householdPanel();
    const row = (within(panel).getByText('VIP').closest('.tagsEditor__row')) as HTMLElement;
    await userEvent.click(within(row).getByRole('button', { name: /orange/i }));
    await userEvent.click(screen.getByRole('button', { name: /save tags/i }));

    await waitFor(() => expect(changeBusinessTags).toHaveBeenCalledTimes(1));
    expect(changeBusinessTags.mock.calls[0]![0]).toEqual([
      { action: 'style', scope: 'household', name: 'VIP', color: orange, icon: '' },
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
    changeBusinessTags.mockRejectedValue(new Error('permission-denied'));
    render(<TagsEditor onBack={vi.fn()} />);
    const panel = await householdPanel();
    await userEvent.type(within(panel).getByLabelText('New household tag name'), 'VIP');
    await userEvent.click(within(panel).getByRole('button', { name: /add tag/i }));
    await userEvent.click(screen.getByRole('button', { name: /save tags/i }));

    expect(await screen.findByText(/couldn't save tags.*permission-denied/i)).toBeInTheDocument();
    expect(within(await householdPanel()).getByText('VIP')).toBeInTheDocument();
  });
});
// ISSUE #1612: Settings mounts this editor inline, under the Settings page's
// own heading and section nav. Its own page heading drew a second header
// inside the panel.
describe('TagsEditor inside Settings', () => {
  it('draws no page heading of its own when opened inline', async () => {
    getBusinessSettings.mockResolvedValue(settings([], []));
    render(<TagsEditor />);
    await householdPanel();
    expect(screen.queryByRole('heading', { level: 1 })).not.toBeInTheDocument();
    expect(screen.queryByText('The Den · Admin')).not.toBeInTheDocument();
  });

  it('keeps the heading and the way back when opened on its own', async () => {
    getBusinessSettings.mockResolvedValue(settings([], []));
    render(<TagsEditor onBack={vi.fn()} />);
    await householdPanel();
    expect(screen.getByRole('heading', { level: 1 })).toHaveTextContent('Tags');
    expect(screen.getByRole('button', { name: 'Back to settings' })).toBeInTheDocument();
  });
});
