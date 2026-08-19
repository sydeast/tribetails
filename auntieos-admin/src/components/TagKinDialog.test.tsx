// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { type MediaFile } from '../api/gallery';
import { type Kin } from '../api/directory';

const { saveMediaTags } = vi.hoisted(() => ({ saveMediaTags: vi.fn() }));
vi.mock('../api/mediaTags', async () => {
  const actual = await vi.importActual<typeof import('../api/mediaTags')>('../api/mediaTags');
  return { ...actual, saveMediaTags };
});

import { TagKinDialog } from './TagKinDialog';

function media(over: Partial<MediaFile> = {}): MediaFile {
  return {
    _id: 'm1',
    kinfolkId: 'fam1',
    fileType: 'IMAGE',
    storageUrl: 'https://cdn/full.jpg',
    thumbnailUrl: '',
    uploadedAt: '2026-07-16T09:00:00.000Z',
    uploadedBy: '',
    description: 'Rufus at the park',
    originalFileName: 'IMG_0001.jpg',
    isProfilePhoto: false,
    durationSeconds: 0,
    ...over,
  };
}

function kin(over: Partial<Kin> & { _id: string }): Kin {
  return { kinfolkId: 'fam1', name: 'Waddles', species: 'Dog', status: 'active', ...over };
}

const ROSTER: Kin[] = [
  kin({ _id: 'k1', name: 'Waddles' }),
  kin({ _id: 'k2', name: 'Biscuit', species: 'Cat' }),
  kin({ _id: 'k9', name: 'Stranger', kinfolkId: 'fam9' }),
];

function renderDialog(over: Partial<Parameters<typeof TagKinDialog>[0]> = {}) {
  const onClose = vi.fn();
  const onSaved = vi.fn();
  render(
    <TagKinDialog
      media={media()}
      allKin={ROSTER}
      kinLoading={false}
      kinError={null}
      onClose={onClose}
      onSaved={onSaved}
      {...over}
    />,
  );
  return { onClose, onSaved };
}

beforeEach(() => {
  saveMediaTags.mockReset();
});

describe('TagKinDialog: what it shows', () => {
  it('is a labelled dialog naming the job', () => {
    renderDialog();
    expect(screen.getByRole('dialog')).toHaveAccessibleName('Tag kin in this photo');
  });

  it('ticks the kin ALREADY tagged on the file, and leaves the rest clear', () => {
    renderDialog({ media: media({ taggedKinIds: ['k2'] }) });
    expect(screen.getByRole('checkbox', { name: /Biscuit/ })).toBeChecked();
    expect(screen.getByRole('checkbox', { name: /Waddles/ })).not.toBeChecked();
  });

  it('offers ONLY the photo household’s kin, never another household’s', () => {
    renderDialog();
    expect(screen.getByRole('checkbox', { name: /Waddles/ })).toBeInTheDocument();
    expect(screen.queryByRole('checkbox', { name: /Stranger/ })).toBeNull();
  });

  it('offers the whole roster for media with no household', () => {
    renderDialog({ media: media({ kinfolkId: '' }) });
    expect(screen.getByRole('checkbox', { name: /Stranger/ })).toBeInTheDocument();
  });

  it('every option is a real, named checkbox, so Tab and Space work with no extra code', () => {
    renderDialog();
    const box = screen.getByRole('checkbox', { name: /Waddles/ });
    expect(box).toHaveAccessibleName(expect.stringContaining('Waddles'));
    expect(box.tagName).toBe('INPUT');
  });
});

describe('TagKinDialog: the four empty states are told apart', () => {
  it('says the roster is LOADING rather than claiming the household has no kin', () => {
    renderDialog({ allKin: [], kinLoading: true });
    expect(screen.getByText('Loading kin…')).toBeInTheDocument();
    expect(screen.queryByText(/No kin on this household/)).toBeNull();
  });

  it('says the roster read FAILED rather than showing a false empty', () => {
    renderDialog({ allKin: [], kinLoading: false, kinError: 'permission denied' });
    expect(screen.getByRole('alert')).toHaveTextContent(/permission denied/);
    expect(screen.queryByText(/No kin on this household/)).toBeNull();
  });

  it('says the household genuinely has no kin when the roster resolved empty', () => {
    renderDialog({ allKin: [] });
    expect(screen.getByText('No kin on this household to tag.')).toBeInTheDocument();
  });

  it('points at Directory when there are no kin ANYWHERE and the photo has no household', () => {
    renderDialog({ media: media({ kinfolkId: '' }), allKin: [] });
    expect(screen.getByText(/Add one in Directory first/)).toBeInTheDocument();
  });
});

describe('TagKinDialog: saving', () => {
  it('ADDS a tag: sends the existing tags plus the newly ticked one', async () => {
    saveMediaTags.mockResolvedValue({ ok: true, mediaFileId: 'm1', taggedKinIds: ['k2', 'k1'] });
    const { onSaved } = renderDialog({ media: media({ taggedKinIds: ['k2'] }) });

    await userEvent.click(screen.getByRole('checkbox', { name: /Waddles/ }));
    await userEvent.click(screen.getByRole('button', { name: 'Save tags' }));

    await waitFor(() => expect(saveMediaTags).toHaveBeenCalledWith('m1', ['k2', 'k1']));
    await waitFor(() => expect(onSaved).toHaveBeenCalledWith(['k2', 'k1']));
  });

  it('REMOVES a tag: unticking sends the shorter list, not the original one', async () => {
    saveMediaTags.mockResolvedValue({ ok: true, mediaFileId: 'm1', taggedKinIds: ['k2'] });
    renderDialog({ media: media({ taggedKinIds: ['k1', 'k2'] }) });

    await userEvent.click(screen.getByRole('checkbox', { name: /Waddles/ }));
    await userEvent.click(screen.getByRole('button', { name: 'Save tags' }));

    await waitFor(() => expect(saveMediaTags).toHaveBeenCalledWith('m1', ['k2']));
  });

  it('REMOVES the last tag: an empty list is sent, never a skipped call', async () => {
    saveMediaTags.mockResolvedValue({ ok: true, mediaFileId: 'm1', taggedKinIds: [] });
    renderDialog({ media: media({ taggedKinIds: ['k1'] }) });

    await userEvent.click(screen.getByRole('checkbox', { name: /Waddles/ }));
    await userEvent.click(screen.getByRole('button', { name: 'Save tags' }));

    await waitFor(() => expect(saveMediaTags).toHaveBeenCalledWith('m1', []));
  });

  it('reports the list the SERVER stored, not the one that was sent', async () => {
    saveMediaTags.mockResolvedValue({ ok: true, mediaFileId: 'm1', taggedKinIds: ['k1'] });
    const { onSaved } = renderDialog({ media: media({ taggedKinIds: ['k1'] }) });

    await userEvent.click(screen.getByRole('checkbox', { name: /Biscuit/ }));
    await userEvent.click(screen.getByRole('button', { name: 'Save tags' }));

    await waitFor(() => expect(onSaved).toHaveBeenCalledWith(['k1']));
  });

  it('shows the SERVER’s own sentence when the save is refused, and does not close', async () => {
    saveMediaTags.mockRejectedValue(
      new Error('k9 is not a kin of household ‘fam1’, which this photo belongs to.'),
    );
    const { onSaved } = renderDialog();

    await userEvent.click(screen.getByRole('checkbox', { name: /Waddles/ }));
    await userEvent.click(screen.getByRole('button', { name: 'Save tags' }));

    await waitFor(() =>
      expect(screen.getByRole('alert')).toHaveTextContent(/is not a kin of household/),
    );
    expect(onSaved).not.toHaveBeenCalled();
  });

  it('KEEPS the operator’s selection after a failed save, so a retry does not start over', async () => {
    saveMediaTags.mockRejectedValue(new Error('Network unreachable'));
    renderDialog();

    await userEvent.click(screen.getByRole('checkbox', { name: /Waddles/ }));
    await userEvent.click(screen.getByRole('button', { name: 'Save tags' }));

    await waitFor(() => expect(screen.getByRole('alert')).toBeInTheDocument());
    expect(screen.getByRole('checkbox', { name: /Waddles/ })).toBeChecked();
    expect(screen.getByRole('button', { name: 'Save tags' })).toBeEnabled();
  });

  it('locks the picker and renames the button while the save is in flight', async () => {
    let release: (v: unknown) => void = () => undefined;
    saveMediaTags.mockReturnValue(new Promise((res) => { release = res; }));
    renderDialog();

    await userEvent.click(screen.getByRole('checkbox', { name: /Waddles/ }));
    await userEvent.click(screen.getByRole('button', { name: 'Save tags' }));

    await waitFor(() => expect(screen.getByRole('button', { name: 'Saving tags…' })).toBeDisabled());
    expect(screen.getByRole('checkbox', { name: /Waddles/ })).toBeDisabled();

    release({ ok: true, mediaFileId: 'm1', taggedKinIds: ['k1'] });
  });

  it('Cancel closes without saving anything', async () => {
    const { onClose } = renderDialog();
    await userEvent.click(screen.getByRole('checkbox', { name: /Waddles/ }));
    await userEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(onClose).toHaveBeenCalled();
    expect(saveMediaTags).not.toHaveBeenCalled();
  });
});
