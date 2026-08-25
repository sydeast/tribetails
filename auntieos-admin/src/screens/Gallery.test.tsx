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

    await userEvent.click(within(tileFor('Biscuit napping')).getByRole('button'));

    const dialog = screen.getByRole('dialog');
    expect(dialog).toHaveAccessibleName('Biscuit napping');
    // The viewer image, not the grid's two thumbnails: the right item opened.
    expect(within(dialog).getByAltText('Biscuit napping')).toHaveAttribute('src', 'https://cdn/b-full.jpg');
  });

  it('opens the viewer when a tile is keyboard-activated with Enter', async () => {
    mediaAsync = { status: 'ready', data: [media({ description: 'Rufus at the park' })] };
    render(<Gallery />);

    const tileButton = within(tileFor('Rufus at the park')).getByRole('button');
    tileButton.focus();
    await userEvent.keyboard('{Enter}');

    expect(screen.getByRole('dialog')).toHaveAccessibleName('Rufus at the park');
  });

  it('opens the viewer when a tile is keyboard-activated with Space', async () => {
    mediaAsync = { status: 'ready', data: [media({ description: 'Rufus at the park' })] };
    render(<Gallery />);

    const tileButton = within(tileFor('Rufus at the park')).getByRole('button');
    tileButton.focus();
    await userEvent.keyboard(' ');

    expect(screen.getByRole('dialog')).toHaveAccessibleName('Rufus at the park');
  });

  it('Escape closes the viewer and returns focus to the tile that opened it', async () => {
    mediaAsync = { status: 'ready', data: [media({ description: 'Rufus at the park' })] };
    render(<Gallery />);

    const tileButton = within(tileFor('Rufus at the park')).getByRole('button');
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
    expect(screen.queryByText(/no media uploaded yet/i)).toBeNull();
  });

  it('a media load failure is surfaced, never rendered as an empty grid', () => {
    mediaAsync = { status: 'error', message: 'permission-denied' };
    render(<Gallery />);
    expect(screen.getByText(/permission-denied/i)).toBeInTheDocument();
    expect(screen.queryByText(/no media uploaded yet/i)).toBeNull();
    expect(screen.queryByText(/no media matches/i)).toBeNull();
  });

  it('renders the proven-empty state only when the stream is ready and genuinely empty', () => {
    mediaAsync = { status: 'ready', data: [] };
    render(<Gallery />);
    expect(screen.getByText(/no media uploaded yet/i)).toBeInTheDocument();
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
  it('filters the grid by household when a household chip is clicked', async () => {
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

    await userEvent.click(screen.getByRole('button', { name: 'Amy Adams' }));
    expect(screen.getByText('Household A photo')).toBeInTheDocument();
    expect(screen.queryByText('Household B photo')).toBeNull();

    // Clicking the same chip again toggles back to "All".
    await userEvent.click(screen.getByRole('button', { name: 'Amy Adams' }));
    expect(screen.getByText('Household B photo')).toBeInTheDocument();
  });

  it('filters the grid by type when a type chip is clicked', async () => {
    mediaAsync = {
      status: 'ready',
      data: [
        media({ _id: 'a', description: 'A photo', fileType: 'IMAGE' }),
        media({ _id: 'b', description: 'A clip', fileType: 'VIDEO' }),
      ],
    };
    render(<Gallery />);
    await userEvent.click(screen.getByRole('button', { name: 'Video' }));
    expect(screen.queryByText('A photo')).toBeNull();
    expect(screen.getByText('A clip')).toBeInTheDocument();
  });

  it('filters the grid by month when a month chip is clicked', async () => {
    mediaAsync = {
      status: 'ready',
      data: [
        media({ _id: 'a', description: 'June shot', uploadedAt: '2026-06-01T12:00:00.000Z' }),
        media({ _id: 'b', description: 'July shot', uploadedAt: '2026-07-01T12:00:00.000Z' }),
      ],
    };
    render(<Gallery />);
    await userEvent.click(screen.getByRole('button', { name: '2026-06' }));
    expect(screen.getByText('June shot')).toBeInTheDocument();
    expect(screen.queryByText('July shot')).toBeNull();
  });

  it('does not render a filter row for an axis with no distinct values (Type, when every row omits it)', () => {
    mediaAsync = { status: 'ready', data: [media({ kinfolkId: 'kf1', fileType: '' })] };
    kinfolkAsync = { status: 'ready', data: [kinfolkRow({ _id: 'kf1' })] };
    render(<Gallery />);
    expect(screen.queryByText('Type')).toBeNull();
  });

  it('shows a "No household" chip (never hides the Household axis) when every row is unattached', () => {
    mediaAsync = { status: 'ready', data: [media({ kinfolkId: '' })] };
    render(<Gallery />);
    expect(screen.getByText('Household')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'No household' })).toBeInTheDocument();
  });

  it('the "No household" chip does not appear when every row already has a household', () => {
    mediaAsync = { status: 'ready', data: [media({ kinfolkId: 'kf1' })] };
    kinfolkAsync = { status: 'ready', data: [kinfolkRow({ _id: 'kf1' })] };
    render(<Gallery />);
    expect(screen.queryByRole('button', { name: 'No household' })).toBeNull();
  });

  it('filters the grid to unattached media only when the "No household" chip is clicked, and toggles back to All', async () => {
    mediaAsync = {
      status: 'ready',
      data: [
        media({ _id: 'a', description: 'Company party photo', kinfolkId: '' }),
        media({ _id: 'b', description: 'Household photo', kinfolkId: 'kf1' }),
      ],
    };
    kinfolkAsync = { status: 'ready', data: [kinfolkRow({ _id: 'kf1' })] };
    render(<Gallery />);

    await userEvent.click(screen.getByRole('button', { name: 'No household' }));
    expect(screen.getByText('Company party photo')).toBeInTheDocument();
    expect(screen.queryByText('Household photo')).toBeNull();

    await userEvent.click(screen.getByRole('button', { name: 'No household' }));
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
    await userEvent.click(screen.getByRole('button', { name: 'Video' }));
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

  it('collapses two or more names to a count: a 132px tile cannot show three names', () => {
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
