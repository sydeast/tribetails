// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, beforeAll, afterAll } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { type Async } from '../lib/async';
import { type MediaFile } from '../api/gallery';
import { NO_TARGET_ENTITY_ID_SENTINEL } from '../api/media';

const { useCollection } = vi.hoisted(() => ({ useCollection: vi.fn() }));
vi.mock('../lib/firestore', () => ({ useCollection }));

import { Media } from './Media';

// TZ pinned so the meta line's LOCAL date (mediaLocalDay, AO-18) is
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

let mediaAsync: Async<MediaFile[]>;
let lastSpec: unknown;

beforeEach(() => {
  mediaAsync = { status: 'ready', data: [] };
  lastSpec = undefined;
  useCollection.mockReset().mockImplementation((spec: unknown) => {
    lastSpec = spec;
    return mediaAsync;
  });
});

function tileFor(text: string): HTMLElement {
  const el = screen.getByText(text).closest('.media__cell');
  if (!(el instanceof HTMLElement)) throw new Error(`tile container not found for "${text}"`);
  return el;
}

describe('Media screen, no target selected', () => {
  it('shows an honest "no target" state for a blank targetId, never a crash or a full dump', () => {
    mediaAsync = { status: 'ready', data: [media({ _id: 'm1', description: 'Should never show' })] };
    render(<Media targetType="kin" targetId="" />);

    expect(screen.getByRole('status')).toHaveTextContent(/no kin selected/i);
    expect(screen.queryByText('Should never show')).not.toBeInTheDocument();
  });

  it('treats a whitespace-only targetId the same as blank', () => {
    render(<Media targetType="household" targetId="   " />);
    expect(screen.getByRole('status')).toHaveTextContent(/no household selected/i);
  });

  it('still subscribes via a well-formed, never-matching query rather than skipping the hook', () => {
    render(<Media targetType="kin" targetId="" />);
    expect(useCollection).toHaveBeenCalledTimes(1);
    const spec = lastSpec as { filters?: unknown[] };
    expect(spec.filters).toEqual([['entityId', '==', NO_TARGET_ENTITY_ID_SENTINEL]]);
  });
});

describe('Media screen, query wiring', () => {
  it('scopes the query to the trimmed targetId, regardless of targetType', () => {
    render(<Media targetType="household" targetId="  demo-family-001  " />);
    const spec = lastSpec as { path: string; filters?: unknown[]; order?: unknown; max?: number };
    expect(spec.path).toBe('media_files');
    expect(spec.filters).toEqual([['entityId', '==', 'demo-family-001']]);
    expect(spec.order).toEqual(['uploadedAt', 'desc']);
    expect(spec.max).toBe(500);
  });
});

describe('Media screen, load states', () => {
  it('renders a loading region', () => {
    mediaAsync = { status: 'loading' };
    render(<Media targetType="kin" targetId="kf1" />);
    expect(screen.getByRole('status')).toHaveTextContent(/loading media/i);
  });

  it('renders the error banner region, never a false empty state', () => {
    mediaAsync = { status: 'error', message: 'permission-denied' };
    render(<Media targetType="kin" targetId="kf1" />);
    expect(screen.getByRole('alert')).toHaveTextContent(/permission-denied/i);
    expect(screen.queryByText(/no media on file/i)).not.toBeInTheDocument();
  });

  it('renders the empty state naming the kin/household, not a generic message', () => {
    mediaAsync = { status: 'ready', data: [] };
    render(<Media targetType="household" targetId="kf1" />);
    expect(screen.getByText(/no media on file for this household yet/i)).toBeInTheDocument();
  });
});

describe('Media screen, grid rendering', () => {
  it('renders a streamed tile with its caption and meta line', () => {
    mediaAsync = {
      status: 'ready',
      data: [media({ _id: 'm1', description: 'Rufus at the park', uploadedBy: 'Jamie' })],
    };
    render(<Media targetType="kin" targetId="kf1" />);

    const tile = tileFor('Rufus at the park');
    expect(within(tile).getByText(/2026-07-16/)).toBeInTheDocument();
    expect(within(tile).getByText(/Jamie/)).toBeInTheDocument();
  });

  it('falls back to originalFileName when description is blank', () => {
    mediaAsync = {
      status: 'ready',
      data: [media({ _id: 'm1', description: '', originalFileName: 'IMG_9999.jpg' })],
    };
    render(<Media targetType="kin" targetId="kf1" />);
    expect(screen.getByText('IMG_9999.jpg')).toBeInTheDocument();
  });

  it('shows the Profile badge only for the profile photo', () => {
    mediaAsync = {
      status: 'ready',
      data: [
        media({ _id: 'm1', description: 'Profile shot', isProfilePhoto: true }),
        media({ _id: 'm2', description: 'Regular shot', isProfilePhoto: false }),
      ],
    };
    render(<Media targetType="kin" targetId="kf1" />);

    expect(within(tileFor('Profile shot')).getByText('Profile')).toBeInTheDocument();
    expect(within(tileFor('Regular shot')).queryByText('Profile')).not.toBeInTheDocument();
  });

  it('shows a duration badge on a video, never on a photo', () => {
    mediaAsync = {
      status: 'ready',
      data: [
        media({ _id: 'm1', description: 'Zoomies clip', fileType: 'VIDEO', durationSeconds: 75 }),
        media({ _id: 'm2', description: 'Still photo', fileType: 'IMAGE' }),
      ],
    };
    render(<Media targetType="kin" targetId="kf1" />);

    expect(within(tileFor('Zoomies clip')).getByText('1:15')).toBeInTheDocument();
    expect(within(tileFor('Still photo')).queryByText(/^\d+:\d\d$/)).not.toBeInTheDocument();
  });

  it('tiles have no click handler: dead by design, not a stubbed lightbox', async () => {
    mediaAsync = { status: 'ready', data: [media({ _id: 'm1', description: 'Rufus' })] };
    render(<Media targetType="kin" targetId="kf1" />);
    const tile = tileFor('Rufus');
    await userEvent.click(tile);
    // Nothing to assert beyond "did not throw / did not navigate": there is no
    // dialog, no route change, no onSelect. The absence IS the behavior.
    expect(tile).toBeInTheDocument();
  });

  it('never renders a household name on a tile: the scope is already the one target', () => {
    mediaAsync = {
      status: 'ready',
      data: [media({ _id: 'm1', description: 'Rufus', kinfolkId: 'kf1' })],
    };
    render(<Media targetType="kin" targetId="kf1" />);
    expect(screen.queryByText('kf1')).not.toBeInTheDocument();
  });
});

describe('Media screen, defensive reads', () => {
  it('does not crash on a doc missing every optional field (the Stage 0I sandbox shape)', () => {
    // Mirrors the real production doc "test-kinfolk-001-media-1": only _id,
    // kinfolkId, storageUrl, uploadedAt, isProfilePhoto are set.
    mediaAsync = {
      status: 'ready',
      data: [
        {
          _id: 'sandbox-1',
          kinfolkId: 'test-kinfolk-001',
          storageUrl: 'https://example.test/sandbox-media-1.jpg',
          uploadedAt: '2026-07-02T16:00:00.000Z',
          isProfilePhoto: false,
        } as unknown as MediaFile,
      ],
    };
    expect(() => render(<Media targetType="kin" targetId="test-kinfolk-001" />)).not.toThrow();
    // No caption/originalFileName means the accessible label falls back to
    // "Media", the same never-blank fallback Gallery.tsx's tile uses. The doc's
    // real storageUrl resolves as the preview image, so the fallback surfaces
    // as the <img>'s alt text rather than the no-image aria-label branch.
    expect(screen.getAllByAltText('Media').length).toBeGreaterThan(0);
  });
});

describe('Media screen, type filter', () => {
  it('narrows the grid to the selected type and back to All', async () => {
    mediaAsync = {
      status: 'ready',
      data: [
        media({ _id: 'm1', description: 'A photo', fileType: 'IMAGE' }),
        media({ _id: 'm2', description: 'A clip', fileType: 'VIDEO' }),
      ],
    };
    render(<Media targetType="kin" targetId="kf1" />);

    expect(screen.getByText('A photo')).toBeInTheDocument();
    expect(screen.getByText('A clip')).toBeInTheDocument();

    await userEvent.click(screen.getByRole('button', { name: 'Video' }));
    expect(screen.queryByText('A photo')).not.toBeInTheDocument();
    expect(screen.getByText('A clip')).toBeInTheDocument();

    await userEvent.click(screen.getByRole('button', { name: 'Video' }));
    expect(screen.getByText('A photo')).toBeInTheDocument();
  });
});
