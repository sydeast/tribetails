// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { TAG_PALETTE, DEFAULT_TAG_COLOR, type TagDef } from '../lib/tags/model';

const getBusinessSettings = vi.fn();
vi.mock('../api/settings', async (orig) => ({
  ...(await orig<typeof import('../api/settings')>()),
  getBusinessSettings: () => getBusinessSettings(),
}));
const saveBusinessSettings = vi.fn();
const changeBusinessTags = vi.fn();
vi.mock('../api/settingsWrite', () => ({
  saveBusinessSettings: (patch: unknown) => saveBusinessSettings(patch),
  changeBusinessTags: (changes: unknown) => changeBusinessTags(changes),
}));
// #2186: who is signed in, and the transport the Auntie's staff read goes over.
// Only these two are stood in; the api modules between them are the real ones.
const { currentSessionSeat, call } = vi.hoisted(() => ({ currentSessionSeat: vi.fn(), call: vi.fn() }));
vi.mock('../lib/sessionSeat', async (orig) => ({
  ...(await orig<typeof import('../lib/sessionSeat')>()),
  currentSessionSeat,
}));
vi.mock('../lib/fns', async (orig) => ({ ...(await orig<typeof import('../lib/fns')>()), call }));

import { ProfileTagsSection, TAG_SUGGESTIONS_LOADING } from './ProfileTagsSection';
import { AUNTIE_SEAT, OWNER_SEAT, STAFF_WORK_REPLY, staffOnlyCall } from '../testing/staffWorkSettings';

const orange = TAG_PALETTE[1]!;

function settings(household: TagDef[], pet: TagDef[]) {
  return { householdTags: household, petTags: pet };
}

beforeEach(() => {
  getBusinessSettings.mockReset();
  getBusinessSettings.mockResolvedValue(settings([], []));
  saveBusinessSettings.mockReset();
  saveBusinessSettings.mockResolvedValue({ updatedAt: 'now', updatedBy: 'auntie' });
  changeBusinessTags.mockReset();
  changeBusinessTags.mockResolvedValue({ householdTags: [], petTags: [] });
  currentSessionSeat.mockReset().mockResolvedValue(OWNER_SEAT);
  call.mockReset().mockImplementation(staffOnlyCall);
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

  it('promotes a new name to the vocabulary (one add, never the list) and assigns it', async () => {
    const onSaveTags = vi.fn().mockResolvedValue(undefined);
    render(<ProfileTagsSection scope="household" initialTags={[]} onSaveTags={onSaveTags} />);
    await userEvent.type(screen.getByLabelText(/add a household tag/i), 'Grooming');
    await userEvent.click(await screen.findByRole('button', { name: /add .*grooming.* to your tags/i }));

    await waitFor(() => expect(changeBusinessTags).toHaveBeenCalledTimes(1));
    expect(changeBusinessTags.mock.calls[0]![0]).toEqual([
      { action: 'add', scope: 'household', name: 'Grooming', color: DEFAULT_TAG_COLOR, icon: '' },
    ]);
    expect(saveBusinessSettings).not.toHaveBeenCalled();
    expect(onSaveTags).toHaveBeenCalledWith(['Grooming']);
  });

  it('targets the pet vocabulary when scope is pet', async () => {
    const onSaveTags = vi.fn().mockResolvedValue(undefined);
    render(<ProfileTagsSection scope="pet" initialTags={[]} onSaveTags={onSaveTags} />);
    await userEvent.type(screen.getByLabelText(/add a pet tag/i), 'Grooming');
    await userEvent.click(await screen.findByRole('button', { name: /add .*grooming.* to your tags/i }));
    await waitFor(() => expect(changeBusinessTags).toHaveBeenCalledTimes(1));
    expect(changeBusinessTags.mock.calls[0]![0]).toMatchObject([{ action: 'add', scope: 'pet', name: 'Grooming' }]);
  });

  it('#2205: after an add the suggestions are the list as stored, tags added elsewhere included', async () => {
    getBusinessSettings.mockResolvedValue(settings([{ name: 'VIP', color: orange, icon: '' }], []));
    // Since this panel loaded, another device added "Gate code"; the server keeps it.
    changeBusinessTags.mockResolvedValue({
      householdTags: [
        { name: 'VIP', color: orange, icon: '' },
        { name: 'Gate code', color: DEFAULT_TAG_COLOR, icon: '' },
        { name: 'Grooming', color: DEFAULT_TAG_COLOR, icon: '' },
      ],
      petTags: [],
    });
    render(<ProfileTagsSection scope="household" initialTags={[]} onSaveTags={vi.fn().mockResolvedValue(undefined)} />);
    await waitFor(() => expect(screen.queryByText(TAG_SUGGESTIONS_LOADING)).toBeNull());
    await userEvent.type(screen.getByLabelText(/add a household tag/i), 'Grooming');
    await userEvent.click(await screen.findByRole('button', { name: /add .*grooming.* to your tags/i }));
    await waitFor(() => expect(changeBusinessTags).toHaveBeenCalledTimes(1));

    await userEvent.type(screen.getByLabelText(/add a household tag/i), 'Gate');
    expect(await screen.findByRole('button', { name: 'Gate code' })).toBeInTheDocument();
  });

  it('#2205: a refused add (a duplicate added elsewhere) says so in plain words and keeps the assignment', async () => {
    changeBusinessTags.mockRejectedValue(new Error('A "Grooming" tag already exists.'));
    const onSaveTags = vi.fn().mockResolvedValue(undefined);
    render(<ProfileTagsSection scope="household" initialTags={[]} onSaveTags={onSaveTags} />);
    await userEvent.type(screen.getByLabelText(/add a household tag/i), 'Grooming');
    await userEvent.click(await screen.findByRole('button', { name: /add .*grooming.* to your tags/i }));
    expect(
      await screen.findByText(`Couldn't add that tag to your list: A "Grooming" tag already exists.`),
    ).toBeInTheDocument();
    expect(onSaveTags).toHaveBeenCalledWith(['Grooming']);
  });

  it('reverts the chip and surfaces the error fail-loud when a save fails', async () => {
    const onSaveTags = vi.fn().mockRejectedValue(new Error('permission-denied'));
    render(<ProfileTagsSection scope="household" initialTags={[]} onSaveTags={onSaveTags} />);
    await userEvent.type(screen.getByLabelText(/add a household tag/i), 'Slow pay{Enter}');
    expect(await screen.findByText(/couldn't save tags.*permission-denied/i)).toBeInTheDocument();
    // reverted: the optimistic chip is gone
    await waitFor(() => expect(screen.queryByText('Slow pay')).toBeNull());
  });

  // #1271: the host holds its close control on these, so a save cannot be
  // walked away from before the server has it.
  it('reports a save in flight until it settles, and the saved list only once the server accepts it', async () => {
    let ack: () => void = () => undefined;
    const onSaveTags = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          ack = resolve;
        }),
    );
    const onSavingChange = vi.fn();
    const onSaved = vi.fn();
    render(
      <ProfileTagsSection
        scope="pet"
        initialTags={['Reactive']}
        onSaveTags={onSaveTags}
        onSavingChange={onSavingChange}
        onSaved={onSaved}
      />,
    );
    await userEvent.click(await screen.findByRole('button', { name: /remove reactive tag/i }));
    expect(onSavingChange.mock.calls).toEqual([[true]]);
    expect(onSaved).not.toHaveBeenCalled();

    ack();
    await waitFor(() => expect(onSavingChange.mock.calls).toEqual([[true], [false]]));
    expect(onSaved).toHaveBeenCalledExactlyOnceWith([]);
  });

  it('settles the in-flight report on a refused save without reporting a saved list', async () => {
    const onSavingChange = vi.fn();
    const onSaved = vi.fn();
    render(
      <ProfileTagsSection
        scope="pet"
        initialTags={['Reactive']}
        onSaveTags={vi.fn().mockRejectedValue(new Error('permission-denied'))}
        onSavingChange={onSavingChange}
        onSaved={onSaved}
      />,
    );
    await userEvent.click(await screen.findByRole('button', { name: /remove reactive tag/i }));
    expect(await screen.findByText(/couldn't save tags.*permission-denied/i)).toBeInTheDocument();
    expect(onSavingChange.mock.calls).toEqual([[true], [false]]);
    expect(onSaved).not.toHaveBeenCalled();
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

  // #2186: the owner's read is unchanged, and it never takes the staff path.
  it('owner: reads the suggestions from her own settings read, never the staff read', async () => {
    getBusinessSettings.mockResolvedValue(settings([{ name: 'VIP', color: orange, icon: '⭐' }], []));
    render(<ProfileTagsSection scope="household" initialTags={[]} onSaveTags={vi.fn().mockResolvedValue(undefined)} />);
    await userEvent.type(screen.getByLabelText(/add a household tag/i), 'V');
    expect(await screen.findByRole('button', { name: /vip/i })).toBeInTheDocument();
    expect(getBusinessSettings).toHaveBeenCalledTimes(1);
    expect(call).not.toHaveBeenCalled();
  });

  it('shows a loading row while the suggestions load, and offers no "add to your tags" until they have', async () => {
    let land: (v: unknown) => void = () => undefined;
    getBusinessSettings.mockReturnValue(new Promise((resolve) => (land = resolve)));
    render(<ProfileTagsSection scope="household" initialTags={[]} onSaveTags={vi.fn().mockResolvedValue(undefined)} />);
    expect(await screen.findByText(TAG_SUGGESTIONS_LOADING)).toBeInTheDocument();
    await userEvent.type(screen.getByLabelText(/add a household tag/i), 'Grooming');
    // Before the list loads the field cannot tell a new name from one already on it.
    expect(screen.queryByRole('button', { name: /to your tags/i })).toBeNull();

    land(settings([{ name: 'VIP', color: orange, icon: '⭐' }], []));
    await waitFor(() => expect(screen.queryByText(TAG_SUGGESTIONS_LOADING)).toBeNull());
    expect(await screen.findByRole('button', { name: /add .*grooming.* to your tags/i })).toBeInTheDocument();
  });

  it('offers no "add to your tags" after a failed load, and Try again reads again', async () => {
    getBusinessSettings.mockRejectedValueOnce(new Error('offline.'));
    getBusinessSettings.mockResolvedValueOnce(settings([{ name: 'VIP', color: orange, icon: '⭐' }], []));
    render(<ProfileTagsSection scope="household" initialTags={[]} onSaveTags={vi.fn().mockResolvedValue(undefined)} />);
    expect(await screen.findByText("Couldn't load tag suggestions: offline. Tags you type still save.")).toBeInTheDocument();
    await userEvent.type(screen.getByLabelText(/add a household tag/i), 'Grooming');
    expect(screen.queryByRole('button', { name: /to your tags/i })).toBeNull();

    await userEvent.click(screen.getByRole('button', { name: 'Try again' }));
    await waitFor(() => expect(screen.queryByText(/couldn't load tag suggestions/i)).toBeNull());
    expect(getBusinessSettings).toHaveBeenCalledTimes(2);
  });
});

describe('ProfileTagsSection under an Auntie sign-in (#2186)', () => {
  beforeEach(() => {
    currentSessionSeat.mockResolvedValue(AUNTIE_SEAT);
  });

  it('suggests the household tags from the staff read and never reads the settings record', async () => {
    render(<ProfileTagsSection scope="household" initialTags={[]} onSaveTags={vi.fn().mockResolvedValue(undefined)} />);
    await waitFor(() => expect(screen.queryByText(TAG_SUGGESTIONS_LOADING)).toBeNull());
    await userEvent.click(screen.getByLabelText(/add a household tag/i));
    expect(await screen.findByRole('button', { name: 'VIP' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Gate code' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Reactive' })).toBeNull();
    expect(call).toHaveBeenCalledWith('getStaffWorkSettings', {});
    expect(getBusinessSettings).not.toHaveBeenCalled();
  });

  it('suggests the Kin tags on a Kin profile', async () => {
    render(<ProfileTagsSection scope="pet" initialTags={[]} onSaveTags={vi.fn().mockResolvedValue(undefined)} />);
    await waitFor(() => expect(screen.queryByText(TAG_SUGGESTIONS_LOADING)).toBeNull());
    await userEvent.type(screen.getByLabelText(/add a pet tag/i), 'o');
    expect(await screen.findByRole('button', { name: 'On meds' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'VIP' })).toBeNull();
  });

  it('picks a suggestion and saves it, with no way to add to the business tag list', async () => {
    const onSaveTags = vi.fn().mockResolvedValue(undefined);
    render(<ProfileTagsSection scope="household" initialTags={[]} onSaveTags={onSaveTags} />);
    await waitFor(() => expect(screen.queryByText(TAG_SUGGESTIONS_LOADING)).toBeNull());
    await userEvent.type(screen.getByLabelText(/add a household tag/i), 'Gate');
    await userEvent.click(await screen.findByRole('button', { name: 'Gate code' }));
    await waitFor(() => expect(onSaveTags).toHaveBeenCalledWith(['Gate code']));

    // A new name still saves on the profile, but she is never offered the edit
    // to Business Settings.
    await userEvent.type(screen.getByLabelText(/add a household tag/i), 'Grooming');
    expect(screen.queryByRole('button', { name: /to your tags/i })).toBeNull();
    await userEvent.keyboard('{Enter}');
    await waitFor(() => expect(onSaveTags).toHaveBeenLastCalledWith(['Gate code', 'Grooming']));
    expect(saveBusinessSettings).not.toHaveBeenCalled();
  });

  it('is sent no color or icon, so her chips draw with the default', async () => {
    render(<ProfileTagsSection scope="household" initialTags={['VIP']} onSaveTags={vi.fn().mockResolvedValue(undefined)} />);
    await waitFor(() => expect(screen.queryByText(TAG_SUGGESTIONS_LOADING)).toBeNull());
    expect(JSON.stringify(STAFF_WORK_REPLY)).not.toMatch(/color|icon/);
    expect(screen.getByText('VIP')).toBeInTheDocument();
  });

  it('says so when the staff read fails, and Try again recovers', async () => {
    call.mockRejectedValueOnce(new Error('The server did not answer.'));
    render(<ProfileTagsSection scope="household" initialTags={[]} onSaveTags={vi.fn().mockResolvedValue(undefined)} />);
    expect(
      await screen.findByText("Couldn't load tag suggestions: The server did not answer. Tags you type still save."),
    ).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Try again' }));
    await waitFor(() => expect(screen.queryByText(/couldn't load tag suggestions/i)).toBeNull());
    await userEvent.click(screen.getByLabelText(/add a household tag/i));
    expect(await screen.findByRole('button', { name: 'VIP' })).toBeInTheDocument();
    expect(getBusinessSettings).not.toHaveBeenCalled();
  });
});
