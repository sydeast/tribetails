// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, beforeAll, afterAll } from 'vitest';
import { render, screen, within, fireEvent, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { type Async } from '../lib/async';
import { type MediaFile } from '../api/gallery';
import { type Kinfolk, type Kin } from '../api/directory';

const { useCollection } = vi.hoisted(() => ({ useCollection: vi.fn() }));
vi.mock('../lib/firestore', () => ({ useCollection }));

// The tag dialog's only write path (#447). Mocked at the api seam, not at
// `lib/fns`, so these tests exercise the screen's wiring rather than the
// callable client `api/mediaTags.test.ts` already covers.
const { saveMediaTags } = vi.hoisted(() => ({ saveMediaTags: vi.fn() }));
vi.mock('../api/mediaTags', async () => {
  const actual = await vi.importActual<typeof import('../api/mediaTags')>('../api/mediaTags');
  return { ...actual, saveMediaTags };
});

// The tile delete's only write path (#692). Mocked at the api seam, not at
// `lib/fns`, so these tests exercise the screen's wiring rather than the
// callable client `api/mediaWrite.test.ts` already covers. Same seam
// Media.test.tsx mocks for the same callable.
const { deleteMediaFile } = vi.hoisted(() => ({ deleteMediaFile: vi.fn() }));
vi.mock('../api/mediaWrite', async () => {
  const actual = await vi.importActual<typeof import('../api/mediaWrite')>('../api/mediaWrite');
  return { ...actual, deleteMediaFile };
});

import { Gallery } from './Gallery';

// TZ pinned so month-chip keys (derived LOCAL from UTC uploadedAt, AO-18) are
// deterministic across runners, not the machine's zone.
let fileOriginalTz: string | undefined;
beforeAll(() => {
  fileOriginalTz = process.env.TZ;
  process.env.TZ = 'America/Chicago';
});
afterAll(() => {
  if (fileOriginalTz === undefined) delete process.env.TZ;
  else process.env.TZ = fileOriginalTz;
});

function media(over: Partial<MediaFile>): MediaFile {
  return {
    _id: 'm1',
    kinfolkId: '',
    fileType: 'IMAGE',
    storageUrl: '',
    thumbnailUrl: '',
    uploadedAt: '2026-07-16T09:00:00.000Z',
    uploadedBy: '',
    description: '',
    originalFileName: 'IMG_0001.jpg',
    isProfilePhoto: false,
    durationSeconds: 0,
    ...over,
  };
}

function kinfolkRow(over: Partial<Kinfolk>): Kinfolk {
  return {
    _id: 'kf1',
    firstName: 'Jamie',
    lastName: 'Halbrook',
    phoneNumber: '',
    email: '',
    profilePictureUrl: '',
    status: 'active',
    joinDate: '2026-01-01',
    ...over,
  };
}

function kinRow(over: Partial<Kin> & { _id: string }): Kin {
  return { kinfolkId: 'kf1', name: 'Waddles', species: 'Dog', status: 'active', ...over };
}

let mediaAsync: Async<MediaFile[]>;
let kinfolkAsync: Async<Kinfolk[]>;
let kinAsync: Async<Kin[]>;

beforeEach(() => {
  mediaAsync = { status: 'ready', data: [] };
  kinfolkAsync = { status: 'ready', data: [] };
  kinAsync = { status: 'ready', data: [] };
  saveMediaTags.mockReset();
  deleteMediaFile.mockReset().mockResolvedValue({
    ok: true,
    mediaFileId: 'm1',
    entityType: 'KINFOLK',
    entityId: 'kf1',
    clearedProfilePhoto: false,
  });
  useCollection.mockReset().mockImplementation((spec: { path: string }) => {
    if (spec.path === 'kinfolk') return kinfolkAsync;
    if (spec.path === 'kin') return kinAsync;
    return mediaAsync;
  });
});

function tileFor(text: string): HTMLElement {
  const el = screen.getByText(text).closest('.gallery__cell');
  if (!(el instanceof HTMLElement)) throw new Error(`tile container not found for "${text}"`);
  return el;
}

describe('Gallery screen, media stream', () => {
  it('renders a streamed tile with its caption, household, and meta line', () => {
    mediaAsync = {
      status: 'ready',
      data: [media({ description: 'Rufus at the park', kinfolkId: 'kf1', uploadedBy: 'Jamie' })],
    };
    kinfolkAsync = { status: 'ready', data: [kinfolkRow({ _id: 'kf1' })] };
    render(<Gallery />);
    const tile = tileFor('Rufus at the park');
    expect(within(tile).getByText('Rufus at the park')).toBeInTheDocument();
    expect(within(tile).getByText('Jamie Halbrook')).toBeInTheDocument();
    expect(within(tile).getByText('2026-07-16 · Jamie')).toBeInTheDocument();
  });

  it('falls back to originalFileName when description is blank', () => {
    mediaAsync = { status: 'ready', data: [media({ description: '', originalFileName: 'IMG_0042.jpg' })] };
    render(<Gallery />);
    expect(screen.getByText('IMG_0042.jpg')).toBeInTheDocument();
  });

  it('shows "No household on file" for media with no resolvable kinfolkId', () => {
    mediaAsync = { status: 'ready', data: [media({ kinfolkId: '' })] };
    render(<Gallery />);
    expect(screen.getByText('No household on file')).toBeInTheDocument();
  });

  it('shows "Household unavailable" (not "No household on file") when a present kinfolkId does not resolve', () => {
    mediaAsync = { status: 'ready', data: [media({ kinfolkId: 'ghost' })] };
    kinfolkAsync = { status: 'ready', data: [] };
    render(<Gallery />);
    // unresolved is not absent: the doc HAS a household, the roster just could
    // not name it. Never collapse that into the "no household" claim.
    expect(screen.getByText('Household unavailable')).toBeInTheDocument();
    expect(screen.queryByText('No household on file')).toBeNull();
  });

  it('shows a duration badge only for a video with a real duration', () => {
    mediaAsync = {
      status: 'ready',
      data: [
        media({ _id: 'v1', fileType: 'VIDEO', description: 'Walkies', durationSeconds: 75 }),
        media({ _id: 'p1', fileType: 'IMAGE', description: 'Photo', durationSeconds: 0 }),
      ],
    };
    render(<Gallery />);
    expect(within(tileFor('Walkies')).getByText('1:15')).toBeInTheDocument();
    expect(within(tileFor('Photo')).queryByText('1:15')).toBeNull();
  });

  it('#593 badges a video whose location strip FAILED, and only that one', () => {
    // The one strip state an operator has to see without reading a log: this
    // video still carries the coordinates it was recorded with, and the retry
    // sweep has stopped trying. PENDING is ordinary progress measured in
    // seconds and STRIPPED is the expected outcome, so neither is decorated.
    mediaAsync = {
      status: 'ready',
      data: [
        media({ _id: 'v1', fileType: 'VIDEO', description: 'Failed clip', gpsStripStatus: 'FAILED' }),
        media({ _id: 'v2', fileType: 'VIDEO', description: 'Pending clip', gpsStripStatus: 'PENDING' }),
        media({ _id: 'v3', fileType: 'VIDEO', description: 'Clean clip', gpsStripStatus: 'STRIPPED' }),
        media({ _id: 'p1', fileType: 'IMAGE', description: 'A photo' }),
      ],
    };
    render(<Gallery />);
    expect(within(tileFor('Failed clip')).getByText('Location not removed')).toBeInTheDocument();
    expect(within(tileFor('Pending clip')).queryByText('Location not removed')).toBeNull();
    expect(within(tileFor('Clean clip')).queryByText('Location not removed')).toBeNull();
    expect(within(tileFor('A photo')).queryByText('Location not removed')).toBeNull();
  });
  it('shows a Profile badge only on the household\'s designated profile photo', () => {
    mediaAsync = {
      status: 'ready',
      data: [
        media({ _id: 'p1', description: 'Profile shot', isProfilePhoto: true }),
        media({ _id: 'p2', description: 'Other shot', isProfilePhoto: false }),
      ],
    };
    render(<Gallery />);
    expect(within(tileFor('Profile shot')).getByText('Profile')).toBeInTheDocument();
    expect(within(tileFor('Other shot')).queryByText('Profile')).toBeNull();
  });

  it('falls back to the type glyph, never a blank tile, when the thumbnail fails to load', () => {
    mediaAsync = {
      status: 'ready',
      data: [media({ description: 'Broken photo', thumbnailUrl: 'https://dead/thumb.jpg' })],
    };
    render(<Gallery />);
    const tile = tileFor('Broken photo');
    const img = within(tile).getByRole('img', { hidden: true }) as HTMLImageElement;
    fireEvent.error(img);
    // Avatar's own fallback takes over: the img is replaced by an accessible
    // role="img" fallback carrying the same caption as its name, never an
    // empty hole where the broken thumbnail used to be.
    expect(within(tile).getByRole('img', { name: 'Broken photo' })).toBeInTheDocument();
  });
});

describe('Gallery screen, media viewer (#388: tapping a photo did nothing)', () => {
  it('is a real, named button: reachable by Tab, not a plain <li> with no click handler', () => {
    mediaAsync = { status: 'ready', data: [media({ description: 'Rufus at the park' })] };
    render(<Gallery />);
    const tileButton = within(tileFor('Rufus at the park')).getByRole('button', { name: /open rufus at the park/i });
    expect(tileButton.tagName).toBe('BUTTON');
  });

  it('opens the viewer, with the right item, when a tile is clicked', async () => {
    mediaAsync = {
      status: 'ready',
      data: [
        media({ _id: 'a', description: 'Rufus at the park', storageUrl: 'https://cdn/a-full.jpg' }),
        media({ _id: 'b', description: 'Biscuit napping', storageUrl: 'https://cdn/b-full.jpg' }),
      ],
    };
    render(<Gallery />);

    await userEvent.click(within(tileFor('Biscuit napping')).getByRole('button', { name: /^Open/ }));

    const dialog = screen.getByRole('dialog');
    expect(dialog).toHaveAccessibleName('Biscuit napping');
    // The viewer image, not the grid's two thumbnails: the right item opened.
    expect(within(dialog).getByAltText('Biscuit napping')).toHaveAttribute('src', 'https://cdn/b-full.jpg');
  });

  it('opens the viewer when a tile is keyboard-activated with Enter', async () => {
    mediaAsync = { status: 'ready', data: [media({ description: 'Rufus at the park' })] };
    render(<Gallery />);

    const tileButton = within(tileFor('Rufus at the park')).getByRole('button', { name: /^Open/ });
    tileButton.focus();
    await userEvent.keyboard('{Enter}');

    expect(screen.getByRole('dialog')).toHaveAccessibleName('Rufus at the park');
  });

  it('opens the viewer when a tile is keyboard-activated with Space', async () => {
    mediaAsync = { status: 'ready', data: [media({ description: 'Rufus at the park' })] };
    render(<Gallery />);

    const tileButton = within(tileFor('Rufus at the park')).getByRole('button', { name: /^Open/ });
    tileButton.focus();
    await userEvent.keyboard(' ');

    expect(screen.getByRole('dialog')).toHaveAccessibleName('Rufus at the park');
  });

  it('Escape closes the viewer and returns focus to the tile that opened it', async () => {
    mediaAsync = { status: 'ready', data: [media({ description: 'Rufus at the park' })] };
    render(<Gallery />);

    const tileButton = within(tileFor('Rufus at the park')).getByRole('button', { name: /^Open/ });
    await userEvent.click(tileButton);
    expect(screen.getByRole('dialog')).toBeInTheDocument();

    await userEvent.keyboard('{Escape}');
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(tileButton).toHaveFocus();
  });
});

describe('Gallery screen, async states', () => {
  it('shows the loading state, never a false empty, while the stream is in flight', () => {
    mediaAsync = { status: 'loading' };
    render(<Gallery />);
    expect(screen.getByText(/loading media/i)).toBeInTheDocument();
    expect(screen.queryByText(/no media files found/i)).toBeNull();
  });

  it('a media load failure is surfaced, never rendered as an empty grid', () => {
    mediaAsync = { status: 'error', message: 'permission-denied' };
    render(<Gallery />);
    expect(screen.getByText(/permission-denied/i)).toBeInTheDocument();
    expect(screen.queryByText(/no media files found/i)).toBeNull();
    expect(screen.queryByText(/no media matches/i)).toBeNull();
  });

  it('renders the proven-empty state only when the stream is ready and genuinely empty', () => {
    mediaAsync = { status: 'ready', data: [] };
    render(<Gallery />);
    expect(screen.getByText('No media files found')).toBeInTheDocument();
  });

  it('a broken kinfolk stream is disclosed by a banner rather than silently hiding every household name', () => {
    mediaAsync = { status: 'ready', data: [media({ description: 'Rufus', kinfolkId: 'kf1' })] };
    kinfolkAsync = { status: 'error', message: 'deadline-exceeded' };
    render(<Gallery />);
    // The tile still renders...
    expect(screen.getByText('Rufus')).toBeInTheDocument();
    expect(screen.getByText('Household unavailable')).toBeInTheDocument();
    // ...but the failure is disclosed, not hidden.
    expect(screen.getByText(/couldn.t load households/i)).toBeInTheDocument();
    expect(screen.getByText(/deadline-exceeded/i)).toBeInTheDocument();
  });
});

describe('Gallery screen, filters', () => {
  it('filters the grid by household when a household is picked from the select', async () => {
    mediaAsync = {
      status: 'ready',
      data: [
        media({ _id: 'a', description: 'Household A photo', kinfolkId: 'kf-a' }),
        media({ _id: 'b', description: 'Household B photo', kinfolkId: 'kf-b' }),
      ],
    };
    kinfolkAsync = {
      status: 'ready',
      data: [kinfolkRow({ _id: 'kf-a', firstName: 'Amy', lastName: 'Adams' }), kinfolkRow({ _id: 'kf-b', firstName: 'Bo', lastName: 'Banks' })],
    };
    render(<Gallery />);
    expect(screen.getByText('Household A photo')).toBeInTheDocument();
    expect(screen.getByText('Household B photo')).toBeInTheDocument();

    const household = screen.getByRole('combobox', { name: 'Household' });
    await userEvent.selectOptions(household, 'kf-a');
    expect(screen.getByText('Household A photo')).toBeInTheDocument();
    expect(screen.queryByText('Household B photo')).toBeNull();

    // Back to "All households" and both are visible again.
    await userEvent.selectOptions(household, screen.getByRole('option', { name: 'All households' }));
    expect(screen.getByText('Household B photo')).toBeInTheDocument();
  });

  it('filters the grid by type when a type pill is clicked, and toggles back off', async () => {
    mediaAsync = {
      status: 'ready',
      data: [
        media({ _id: 'a', description: 'A photo', fileType: 'IMAGE' }),
        media({ _id: 'b', description: 'A clip', fileType: 'VIDEO' }),
      ],
    };
    render(<Gallery />);
    await userEvent.click(screen.getByRole('button', { name: /^Videos/ }));
    expect(screen.queryByText('A photo')).toBeNull();
    expect(screen.getByText('A clip')).toBeInTheDocument();

    await userEvent.click(screen.getByRole('button', { name: /^Videos/ }));
    expect(screen.getByText('A photo')).toBeInTheDocument();
  });

  it('carries a per-type count on every pill, counted over the WHOLE stream and not the filtered slice', async () => {
    mediaAsync = {
      status: 'ready',
      data: [
        media({ _id: 'a', description: 'A photo', fileType: 'IMAGE' }),
        media({ _id: 'b', description: 'Another photo', fileType: 'IMAGE' }),
        media({ _id: 'c', description: 'A clip', fileType: 'VIDEO' }),
      ],
    };
    render(<Gallery />);
    const pills = screen.getByRole('group', { name: 'Filter by type' });
    expect(within(pills).getByRole('button', { name: 'All 3' })).toBeInTheDocument();
    expect(within(pills).getByRole('button', { name: 'Images 2' })).toBeInTheDocument();
    expect(within(pills).getByRole('button', { name: 'Videos 1' })).toBeInTheDocument();

    // Narrowing to Videos must not restate Images as 0: the counts describe the
    // stream, not the slice on screen.
    await userEvent.click(within(pills).getByRole('button', { name: 'Videos 1' }));
    expect(within(pills).getByRole('button', { name: 'Images 2' })).toBeInTheDocument();
    expect(within(pills).getByRole('button', { name: 'All 3' })).toBeInTheDocument();
  });

  it('names the pills the way the mock does, plural and by kind, not by the raw fileType string', () => {
    mediaAsync = {
      status: 'ready',
      data: [
        media({ _id: 'a', fileType: 'IMAGE', description: 'A photo' }),
        media({ _id: 'b', fileType: 'VIDEO', description: 'A clip' }),
        media({ _id: 'c', fileType: 'DOCUMENT', description: 'Vet notes' }),
        media({ _id: 'd', fileType: 'AUDIO', description: 'A bark' }),
      ],
    };
    render(<Gallery />);
    const pills = screen.getByRole('group', { name: 'Filter by type' });
    for (const name of ['Images 1', 'Videos 1', 'Documents 1', 'Audio 1']) {
      expect(within(pills).getByRole('button', { name })).toBeInTheDocument();
    }
  });

  it('filters the grid by month when a month is picked from the select', async () => {
    mediaAsync = {
      status: 'ready',
      data: [
        media({ _id: 'a', description: 'June shot', uploadedAt: '2026-06-01T12:00:00.000Z' }),
        media({ _id: 'b', description: 'July shot', uploadedAt: '2026-07-01T12:00:00.000Z' }),
      ],
    };
    render(<Gallery />);
    await userEvent.selectOptions(screen.getByRole('combobox', { name: 'Month' }), '2026-06');
    expect(screen.getByText('June shot')).toBeInTheDocument();
    expect(screen.queryByText('July shot')).toBeNull();
  });

  it('does not render the type pills at all for a stream where every row omits fileType', () => {
    mediaAsync = { status: 'ready', data: [media({ kinfolkId: 'kf1', fileType: '' })] };
    kinfolkAsync = { status: 'ready', data: [kinfolkRow({ _id: 'kf1' })] };
    render(<Gallery />);
    expect(screen.queryByRole('group', { name: 'Filter by type' })).toBeNull();
  });

  it('shows a "No household" option (never hides the Household axis) when every row is unattached', () => {
    mediaAsync = { status: 'ready', data: [media({ kinfolkId: '' })] };
    render(<Gallery />);
    const household = screen.getByRole('combobox', { name: 'Household' });
    expect(within(household).getByRole('option', { name: 'No household' })).toBeInTheDocument();
  });

  it('the "No household" option does not appear when every row already has a household', () => {
    mediaAsync = { status: 'ready', data: [media({ kinfolkId: 'kf1' })] };
    kinfolkAsync = { status: 'ready', data: [kinfolkRow({ _id: 'kf1' })] };
    render(<Gallery />);
    expect(screen.queryByRole('option', { name: 'No household' })).toBeNull();
  });

  it('filters the grid to unattached media only when "No household" is picked, and back to All', async () => {
    mediaAsync = {
      status: 'ready',
      data: [
        media({ _id: 'a', description: 'Company party photo', kinfolkId: '' }),
        media({ _id: 'b', description: 'Household photo', kinfolkId: 'kf1' }),
      ],
    };
    kinfolkAsync = { status: 'ready', data: [kinfolkRow({ _id: 'kf1' })] };
    render(<Gallery />);

    const household = screen.getByRole('combobox', { name: 'Household' });
    await userEvent.selectOptions(household, screen.getByRole('option', { name: 'No household' }));
    expect(screen.getByText('Company party photo')).toBeInTheDocument();
    expect(screen.queryByText('Household photo')).toBeNull();

    // "No household" is a REAL filter value (the empty kinfolkId), so it must be
    // distinguishable from "no filter at all", which is what this round trip
    // proves: picking All again brings the attached row back.
    await userEvent.selectOptions(household, screen.getByRole('option', { name: 'All households' }));
    expect(screen.getByText('Household photo')).toBeInTheDocument();
  });

  it('shows the visible-of-total count, updated as filters narrow the grid', async () => {
    mediaAsync = {
      status: 'ready',
      data: [
        media({ _id: 'a', description: 'A photo', fileType: 'IMAGE' }),
        media({ _id: 'b', description: 'A clip', fileType: 'VIDEO' }),
      ],
    };
    render(<Gallery />);
    expect(screen.getByText('2 of 2')).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: /^Videos/ }));
    expect(screen.getByText('1 of 2')).toBeInTheDocument();
  });
});

describe('Gallery screen, kin tagging (#447)', () => {
  function withOnePhoto(taggedKinIds?: string[]) {
    mediaAsync = {
      status: 'ready',
      data: [media({ _id: 'm1', description: 'Rufus at the park', kinfolkId: 'kf1', ...(taggedKinIds ? { taggedKinIds } : {}) })],
    };
    kinfolkAsync = { status: 'ready', data: [kinfolkRow({ _id: 'kf1' })] };
    kinAsync = {
      status: 'ready',
      data: [kinRow({ _id: 'k1', name: 'Waddles' }), kinRow({ _id: 'k2', name: 'Biscuit' })],
    };
  }

  it('names the tagged kin on the tile itself, so the grid answers "which photos have Waddles in them"', () => {
    withOnePhoto(['k1']);
    render(<Gallery />);
    expect(within(tileFor('Rufus at the park')).getByText('Waddles')).toBeInTheDocument();
  });

  it('collapses two or more names to a count: a tile cannot show three names', () => {
    withOnePhoto(['k1', 'k2']);
    render(<Gallery />);
    expect(within(tileFor('Rufus at the park')).getByText('2 kin')).toBeInTheDocument();
  });

  it('shows no tag line on an untagged photo, rather than an empty chip', () => {
    withOnePhoto();
    render(<Gallery />);
    expect(within(tileFor('Rufus at the park')).queryByText(/kin$/)).toBeNull();
  });

  it('the viewer names who is tagged and offers "Tag kin"', async () => {
    withOnePhoto(['k1']);
    render(<Gallery />);
    await userEvent.click(screen.getByRole('button', { name: 'Open Rufus at the park' }));
    const dialog = screen.getByRole('dialog');
    expect(within(dialog).getByText('Waddles')).toBeInTheDocument();
    expect(within(dialog).getByRole('button', { name: 'Tag kin' })).toBeInTheDocument();
  });

  it('"Tag kin" HANDS OFF: the viewer closes and the tag dialog opens, never both at once', async () => {
    withOnePhoto();
    render(<Gallery />);
    await userEvent.click(screen.getByRole('button', { name: 'Open Rufus at the park' }));
    await userEvent.click(screen.getByRole('button', { name: 'Tag kin' }));

    expect(screen.getAllByRole('dialog')).toHaveLength(1);
    expect(screen.getByRole('dialog')).toHaveAccessibleName('Tag kin in this photo');
  });

  it('adds a tag end to end, and closes the dialog on success', async () => {
    withOnePhoto();
    saveMediaTags.mockResolvedValue({ ok: true, mediaFileId: 'm1', taggedKinIds: ['k1'] });
    render(<Gallery />);

    await userEvent.click(screen.getByRole('button', { name: 'Open Rufus at the park' }));
    await userEvent.click(screen.getByRole('button', { name: 'Tag kin' }));
    await userEvent.click(screen.getByRole('checkbox', { name: /Waddles/ }));
    await userEvent.click(screen.getByRole('button', { name: 'Save tags' }));

    await waitFor(() => expect(saveMediaTags).toHaveBeenCalledWith('m1', ['k1']));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
  });

  it('a rejected save keeps the dialog open and shows why', async () => {
    withOnePhoto();
    saveMediaTags.mockRejectedValue(new Error('Admin claim required.'));
    render(<Gallery />);

    await userEvent.click(screen.getByRole('button', { name: 'Open Rufus at the park' }));
    await userEvent.click(screen.getByRole('button', { name: 'Tag kin' }));
    await userEvent.click(screen.getByRole('checkbox', { name: /Waddles/ }));
    await userEvent.click(screen.getByRole('button', { name: 'Save tags' }));

    await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent(/Admin claim required/));
    expect(screen.getByRole('dialog')).toHaveAccessibleName('Tag kin in this photo');
  });

  it('closing the tag dialog returns focus to the tile the whole flow started from', async () => {
    withOnePhoto();
    render(<Gallery />);
    const tile = screen.getByRole('button', { name: 'Open Rufus at the park' });

    await userEvent.click(tile);
    await userEvent.click(screen.getByRole('button', { name: 'Tag kin' }));
    await userEvent.click(screen.getByRole('button', { name: 'Cancel' }));

    await waitFor(() => expect(document.activeElement).toBe(tile));
  });

  it('a failed kin stream never reads as "no kin on this household"', async () => {
    withOnePhoto();
    kinAsync = { status: 'error', message: 'permission denied', retry: () => undefined };
    render(<Gallery />);

    await userEvent.click(screen.getByRole('button', { name: 'Open Rufus at the park' }));
    await userEvent.click(screen.getByRole('button', { name: 'Tag kin' }));

    expect(screen.getByRole('alert')).toHaveTextContent(/permission denied/);
    expect(screen.queryByText('No kin on this household to tag.')).toBeNull();
  });
});
describe('Gallery screen, mock parity (#692)', () => {
  it('renders one tile per streamed row, in one grid', () => {
    mediaAsync = {
      status: 'ready',
      data: [
        media({ _id: 'a', description: 'One' }),
        media({ _id: 'b', description: 'Two' }),
        media({ _id: 'c', description: 'Three' }),
        media({ _id: 'd', description: 'Four' }),
      ],
    };
    const { container } = render(<Gallery />);
    expect(container.querySelectorAll('.gallery__grid')).toHaveLength(1);
    expect(container.querySelectorAll('.gallery__cell')).toHaveLength(4);
  });

  it('prints nothing under a tile at rest: the caption, household and meta all live in the hover strip', () => {
    mediaAsync = {
      status: 'ready',
      data: [media({ description: 'Rufus at the park', kinfolkId: 'kf1', uploadedBy: 'Jamie' })],
    };
    kinfolkAsync = { status: 'ready', data: [kinfolkRow({ _id: 'kf1' })] };
    const { container } = render(<Gallery />);
    // jsdom applies no stylesheet, so `toBeVisible()` would pass on the strip
    // whatever its opacity. The state carrier is WHERE the text sits: every one
    // of these three lines is inside the strip, and the always-on body block
    // that used to hold them is gone.
    expect(container.querySelector('.gallery__tile-body')).toBeNull();
    // Scoped to the tile: the household name is also an option in the household
    // select now, and this assertion is about the TILE.
    const tile = tileFor('Rufus at the park');
    for (const text of ['Rufus at the park', 'Jamie Halbrook', '2026-07-16 · Jamie']) {
      expect(within(tile).getByText(text).closest('.gallery__tile-caption-strip')).not.toBeNull();
    }
  });

  it('does not aria-hide the strip: it is the tile\'s only carrier for that text now', () => {
    mediaAsync = { status: 'ready', data: [media({ description: 'Rufus at the park' })] };
    const { container } = render(<Gallery />);
    const strip = container.querySelector('.gallery__tile-caption-strip');
    // Media.tsx's strip IS aria-hidden, because an always-visible block there
    // repeats it word for word. Nothing repeats this one, so hiding it from
    // assistive tech would drop the text rather than de-duplicate it. Folding it
    // into the strip is a VISUAL change: the same nodes, in the same labelled
    // button, seen by the same tools.
    expect(strip).not.toBeNull();
    expect(strip?.getAttribute('aria-hidden')).toBeNull();
  });

  it('puts a count chip beside the title and the upload action in the same header row', () => {
    mediaAsync = {
      status: 'ready',
      data: [media({ _id: 'a', description: 'One' }), media({ _id: 'b', description: 'Two' })],
    };
    const { container } = render(<Gallery />);
    const header = container.querySelector('.gallery__header-actions');
    expect(header).not.toBeNull();
    expect(within(header as HTMLElement).getByText('2')).toBeInTheDocument();
    expect(within(header as HTMLElement).getByText('files')).toBeInTheDocument();
    expect(within(header as HTMLElement).getByRole('button', { name: 'Upload media' })).toBeInTheDocument();
  });

  it('says "file", not "files", for a stream of one', () => {
    mediaAsync = { status: 'ready', data: [media({ description: 'Only one' })] };
    render(<Gallery />);
    expect(screen.getByText('file')).toBeInTheDocument();
  });

  it('never prints a confident count while the stream is still in flight', () => {
    mediaAsync = { status: 'loading' };
    const { container } = render(<Gallery />);
    expect(container.querySelector('.gallery__count-chip')).toBeNull();
  });

  it('offers a delete control on every tile', () => {
    mediaAsync = {
      status: 'ready',
      data: [media({ _id: 'a', description: 'One' }), media({ _id: 'b', description: 'Two' })],
    };
    render(<Gallery />);
    expect(screen.getByRole('button', { name: 'Delete One' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Delete Two' })).toBeInTheDocument();
  });

  it('the delete control is a SIBLING of the open button, never nested inside it', () => {
    mediaAsync = { status: 'ready', data: [media({ description: 'Rufus at the park' })] };
    render(<Gallery />);
    const del = screen.getByRole('button', { name: 'Delete Rufus at the park' });
    // Nesting one interactive element in another is invalid HTML and jsdom
    // accepts it silently, so this is asserted rather than assumed.
    expect(del.closest('.gallery__tile')).toBeNull();
  });

  it('the delete control asks for confirmation and writes nothing on its own', async () => {
    mediaAsync = { status: 'ready', data: [media({ _id: 'm7', description: 'Rufus at the park' })] };
    render(<Gallery />);
    await userEvent.click(screen.getByRole('button', { name: 'Delete Rufus at the park' }));
    const dialog = screen.getByRole('dialog');
    expect(dialog).toHaveAccessibleName('Delete Media');
    expect(within(dialog).getByText('Are you sure you want to delete this image?')).toBeInTheDocument();
    expect(deleteMediaFile).not.toHaveBeenCalled();
  });

  it('names the file type in the confirm body, the way the mock and Android both do', async () => {
    mediaAsync = { status: 'ready', data: [media({ _id: 'v1', fileType: 'VIDEO', description: 'Walkies' })] };
    render(<Gallery />);
    await userEvent.click(screen.getByRole('button', { name: 'Delete Walkies' }));
    expect(screen.getByText('Are you sure you want to delete this video?')).toBeInTheDocument();
  });

  it('Cancel closes the confirm and deletes nothing', async () => {
    mediaAsync = { status: 'ready', data: [media({ _id: 'm7', description: 'Rufus at the park' })] };
    render(<Gallery />);
    await userEvent.click(screen.getByRole('button', { name: 'Delete Rufus at the park' }));
    await userEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(deleteMediaFile).not.toHaveBeenCalled();
  });

  it('confirming deletes through the callable, with NO entity scope: this grid spans every household', async () => {
    mediaAsync = { status: 'ready', data: [media({ _id: 'm7', kinfolkId: 'kf1', description: 'Rufus at the park' })] };
    kinfolkAsync = { status: 'ready', data: [kinfolkRow({ _id: 'kf1' })] };
    render(<Gallery />);
    await userEvent.click(screen.getByRole('button', { name: 'Delete Rufus at the park' }));
    await userEvent.click(screen.getByRole('button', { name: 'Delete' }));
    await waitFor(() => expect(deleteMediaFile).toHaveBeenCalledWith('m7'));
  });

  it('a refused delete is surfaced and the tile stays: no optimistic splice', async () => {
    mediaAsync = { status: 'ready', data: [media({ _id: 'm7', description: 'Rufus at the park' })] };
    deleteMediaFile.mockRejectedValue(new Error('Admin claim required.'));
    render(<Gallery />);
    await userEvent.click(screen.getByRole('button', { name: 'Delete Rufus at the park' }));
    await userEvent.click(screen.getByRole('button', { name: 'Delete' }));
    await waitFor(() => expect(screen.getByText(/admin claim required/i)).toBeInTheDocument());
    // The listener owns the grid: the row is still there because the document is.
    expect(screen.getByText('Rufus at the park')).toBeInTheDocument();
  });

  it('shows the PROFILE badge on the profile photo, and warns when that is the one being deleted', async () => {
    mediaAsync = {
      status: 'ready',
      data: [media({ _id: 'p1', description: 'Profile shot', isProfilePhoto: true })],
    };
    render(<Gallery />);
    expect(within(tileFor('Profile shot')).getByText('Profile')).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Delete Profile shot' }));
    expect(screen.getByText(/this is a profile photo/i)).toBeInTheDocument();
  });
});
describe('Gallery screen, glass sweep (#755)', () => {
  it('draws the kit hero with the nav kicker and the mock-shaped title, accent word "media"', () => {
    const { container } = render(<Gallery />);
    expect(container.querySelector('.den-heading')).not.toBeNull();
    expect(screen.getByText('The Den · Gallery')).toBeInTheDocument();
    const h1 = screen.getByRole('heading', { level: 1 });
    expect(h1).toHaveTextContent('All media');
    expect(h1.querySelector('.den-heading-accent')?.textContent).toBe('media');
    // The explanation is the tooltip, never a line of copy (#758).
    expect(container.querySelector('.den-heading-subtitle')).not.toBeNull();
    expect(screen.queryByText('All media from every KinTale, tagged to its household.')?.closest('.den-heading-subtitle')).not.toBeNull();
  });
  it('marks the profile photo with the kit compact teal StatusPill, not a local badge', () => {
    mediaAsync = { status: 'ready', data: [media({ _id: 'p1', description: 'Profile shot', isProfilePhoto: true })] };
    render(<Gallery />);
    const pill = within(tileFor('Profile shot')).getByText('Profile');
    expect(pill.classList.contains('den-statuspill')).toBe(true);
    expect(pill.classList.contains('den-statuspill--compact')).toBe(true);
    expect(pill.getAttribute('data-tone')).toBe('teal');
  });
  it('draws a document as the mock file cell: glyph and file name in the tile at rest, and no repeat in the strip', () => {
    mediaAsync = {
      status: 'ready',
      data: [media({ _id: 'd1', fileType: 'DOCUMENT', description: '', originalFileName: 'vet-summary.pdf' })],
    };
    const { container } = render(<Gallery />);
    const cell = container.querySelector('.gallery__cell') as HTMLElement;
    const file = cell.querySelector('.gallery__tile-file');
    expect(file).not.toBeNull();
    expect(within(file as HTMLElement).getByText('vet-summary.pdf')).toBeInTheDocument();
    expect(file?.querySelector('svg')).not.toBeNull();
    // No Avatar for a kind with nothing to preview.
    expect(cell.querySelector('.gallery__tile-avatar')).toBeNull();
    // The name is printed once: the strip drops its caption line when it would
    // only repeat the file name the cell already shows.
    expect(within(cell).getAllByText('vet-summary.pdf')).toHaveLength(1);
    expect(cell.querySelector('.gallery__tile-caption')).toBeNull();
    expect(screen.getByRole('button', { name: 'Open vet-summary.pdf' })).toBeInTheDocument();
  });
  it('an audio file with a caption keeps the file name in the cell and the caption in the strip', () => {
    mediaAsync = {
      status: 'ready',
      data: [media({ _id: 'a1', fileType: 'AUDIO', description: 'Happy bark', originalFileName: 'happy-bark-clip.m4a' })],
    };
    const { container } = render(<Gallery />);
    const cell = container.querySelector('.gallery__cell') as HTMLElement;
    expect(within(cell).getByText('happy-bark-clip.m4a').closest('.gallery__tile-file')).not.toBeNull();
    expect(within(cell).getByText('Happy bark').closest('.gallery__tile-caption-strip')).not.toBeNull();
  });
  it('an image keeps the Avatar preview and the caption in the strip, never a file cell', () => {
    mediaAsync = { status: 'ready', data: [media({ _id: 'i1', fileType: 'IMAGE', description: 'Biscuit on the porch' })] };
    const { container } = render(<Gallery />);
    const cell = container.querySelector('.gallery__cell') as HTMLElement;
    expect(cell.querySelector('.gallery__tile-file')).toBeNull();
    expect(cell.querySelector('.gallery__tile-avatar')).not.toBeNull();
    expect(within(cell).getByText('Biscuit on the porch').closest('.gallery__tile-caption-strip')).not.toBeNull();
  });
  it('the tile wears the shared lift class, and the delete control does not', () => {
    mediaAsync = { status: 'ready', data: [media({ description: 'Rufus at the park' })] };
    render(<Gallery />);
    const tile = screen.getByRole('button', { name: 'Open Rufus at the park' });
    expect(tile.classList.contains('lift')).toBe(true);
    expect(screen.getByRole('button', { name: 'Delete Rufus at the park' }).classList.contains('lift')).toBe(false);
  });
  it('draws the proven-empty read as the mock block with its two lines of copy', () => {
    mediaAsync = { status: 'ready', data: [] };
    const { container } = render(<Gallery />);
    const empty = container.querySelector('.gallery__empty') as HTMLElement;
    expect(empty).not.toBeNull();
    expect(empty.querySelector('.gallery__empty-glyph')).not.toBeNull();
    expect(within(empty).getByText('No media files found').classList.contains('gallery__empty-title')).toBe(true);
    expect(within(empty).getByText('Upload photos and videos to see them here')).toBeInTheDocument();
    // No count chip and no grid beside an empty block.
    expect(container.querySelector('.gallery__count-chip')).toBeNull();
    expect(container.querySelector('.gallery__grid')).toBeNull();
  });
  it('uses the kit hint for a filter that matches nothing', async () => {
    // One row, uploaded in one month; picking a month the row is not in
    // empties the grid without emptying the stream.
    mediaAsync = {
      status: 'ready',
      data: [
        media({ _id: 'a', description: 'July photo', uploadedAt: '2026-07-16T09:00:00.000Z' }),
        media({ _id: 'b', description: 'June photo', uploadedAt: '2026-06-16T09:00:00.000Z', kinfolkId: 'kf1' }),
      ],
    };
    kinfolkAsync = { status: 'ready', data: [kinfolkRow({ _id: 'kf1' })] };
    render(<Gallery />);
    await userEvent.selectOptions(screen.getByRole('combobox', { name: 'Month' }), '2026-06');
    await userEvent.selectOptions(screen.getByRole('combobox', { name: 'Household' }), screen.getByRole('option', { name: 'No household' }));
    const hint = screen.getByText('No media matches these filters.');
    expect(hint.classList.contains('den-hint')).toBe(true);
    expect(document.querySelector('.gallery__hint')).toBeNull();
  });
  it('uses the kit loading row while the stream is in flight', () => {
    mediaAsync = { status: 'loading' };
    const { container } = render(<Gallery />);
    expect(container.querySelector('.loadingRow.den-hint')).not.toBeNull();
    expect(container.querySelector('.gallery__hint')).toBeNull();
  });
});
