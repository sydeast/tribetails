// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, within, fireEvent } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { type Async } from '../lib/async';
import { type MediaFile } from '../api/gallery';
import { type Kinfolk } from '../api/directory';

const { useCollection } = vi.hoisted(() => ({ useCollection: vi.fn() }));
vi.mock('../lib/firestore', () => ({ useCollection }));

import { Gallery } from './Gallery';

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

let mediaAsync: Async<MediaFile[]>;
let kinfolkAsync: Async<Kinfolk[]>;

beforeEach(() => {
  mediaAsync = { status: 'ready', data: [] };
  kinfolkAsync = { status: 'ready', data: [] };
  useCollection.mockReset().mockImplementation((spec: { path: string }) =>
    spec.path === 'kinfolk' ? kinfolkAsync : mediaAsync,
  );
});

function tileFor(text: string): HTMLElement {
  const el = screen.getByText(text).closest('.gallery__cell');
  if (!(el instanceof HTMLElement)) throw new Error(`tile container not found for "${text}"`);
  return el;
}

describe('Gallery screen — media stream', () => {
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

  it('shows "No household on file" when the kinfolkId does not resolve to a known household', () => {
    mediaAsync = { status: 'ready', data: [media({ kinfolkId: 'ghost' })] };
    kinfolkAsync = { status: 'ready', data: [] };
    render(<Gallery />);
    expect(screen.getByText('No household on file')).toBeInTheDocument();
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
    // role="img" fallback carrying the same caption as its name — never an
    // empty hole where the broken thumbnail used to be.
    expect(within(tile).getByRole('img', { name: 'Broken photo' })).toBeInTheDocument();
  });
});

describe('Gallery screen — async states', () => {
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
    expect(screen.getByText('No household on file')).toBeInTheDocument();
    // ...but the failure is disclosed, not hidden.
    expect(screen.getByText(/couldn.t load households/i)).toBeInTheDocument();
    expect(screen.getByText(/deadline-exceeded/i)).toBeInTheDocument();
  });
});

describe('Gallery screen — filters', () => {
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
        media({ _id: 'a', description: 'June shot', uploadedAt: '2026-06-01T00:00:00.000Z' }),
        media({ _id: 'b', description: 'July shot', uploadedAt: '2026-07-01T00:00:00.000Z' }),
      ],
    };
    render(<Gallery />);
    await userEvent.click(screen.getByRole('button', { name: '2026-06' }));
    expect(screen.getByText('June shot')).toBeInTheDocument();
    expect(screen.queryByText('July shot')).toBeNull();
  });

  it('does not render a filter row for an axis with no distinct values', () => {
    mediaAsync = { status: 'ready', data: [media({ kinfolkId: '' })] };
    render(<Gallery />);
    expect(screen.queryByText('Household')).toBeNull();
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
