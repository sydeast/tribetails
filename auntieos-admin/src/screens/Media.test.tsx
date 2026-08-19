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

/**
 * A tile now carries its caption/meta TWICE: once in the always-visible
 * `.media__tile-body` block (the accessible carrier, and the only copy a touch
 * device or Android ever sees) and once in the `aria-hidden` hover strip drawn
 * over the thumbnail (the mock's `.cap`). So the harness matches on the first
 * occurrence rather than asserting there is exactly one.
 */
function tileFor(text: string): HTMLElement {
  const first = screen.getAllByText(text)[0];
  const el = first?.closest('.media__cell');
  if (!(el instanceof HTMLElement)) throw new Error(`tile container not found for "${text}"`);
  return el;
}

/** How many tiles render `text` in their always-visible body block. */
function captionedTiles(text: string): number {
  return screen
    .queryAllByText(text)
    .filter((el) => el.closest('.media__tile-body') !== null).length;
}

/** The heading count chip, or null when the screen refuses to claim a number. */
function countChip(): HTMLElement | null {
  return document.querySelector('.media__count-chip');
}

/** Every type-filter pill's text, in render order (e.g. `['All 3', 'Image 2', 'Video 1']`). */
function chipLabels(): string[] {
  return Array.from(document.querySelectorAll('.media__chip')).map((c) =>
    (c.textContent ?? '').trim(),
  );
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

    // Scoped to the always-visible body block: the tile also carries an
    // aria-hidden copy in its hover strip, so an unscoped match finds both.
    const body = tileFor('Rufus at the park').querySelector('.media__tile-body');
    if (!(body instanceof HTMLElement)) throw new Error('tile body not found');
    expect(within(body).getByText(/2026-07-16/)).toBeInTheDocument();
    expect(within(body).getByText(/Jamie/)).toBeInTheDocument();
  });

  it('falls back to originalFileName when description is blank', () => {
    mediaAsync = {
      status: 'ready',
      data: [media({ _id: 'm1', description: '', originalFileName: 'IMG_9999.jpg' })],
    };
    render(<Media targetType="kin" targetId="kf1" />);
    expect(captionedTiles('IMG_9999.jpg')).toBe(1);
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

  it('never renders a household name on a tile: the scope is already the one target', () => {
    mediaAsync = {
      status: 'ready',
      data: [media({ _id: 'm1', description: 'Rufus', kinfolkId: 'kf1' })],
    };
    render(<Media targetType="kin" targetId="kf1" />);
    expect(screen.queryByText('kf1')).not.toBeInTheDocument();
  });
});

describe('Media screen, media viewer (#388: tapping a photo did nothing)', () => {
  it('is a real, named button: reachable by Tab, not a plain <li> with no click handler', () => {
    mediaAsync = { status: 'ready', data: [media({ _id: 'm1', description: 'Rufus' })] };
    render(<Media targetType="kin" targetId="kf1" />);
    const tileButton = within(tileFor('Rufus')).getByRole('button', { name: /open rufus/i });
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
    render(<Media targetType="kin" targetId="kf1" />);

    await userEvent.click(within(tileFor('Biscuit napping')).getByRole('button'));

    const dialog = screen.getByRole('dialog');
    expect(dialog).toHaveAccessibleName('Biscuit napping');
    expect(within(dialog).getByAltText('Biscuit napping')).toHaveAttribute('src', 'https://cdn/b-full.jpg');
  });

  it('opens the viewer when a tile is keyboard-activated with Enter', async () => {
    mediaAsync = { status: 'ready', data: [media({ _id: 'm1', description: 'Rufus' })] };
    render(<Media targetType="kin" targetId="kf1" />);

    const tileButton = within(tileFor('Rufus')).getByRole('button');
    tileButton.focus();
    await userEvent.keyboard('{Enter}');

    expect(screen.getByRole('dialog')).toHaveAccessibleName('Rufus');
  });

  it('Escape closes the viewer and returns focus to the tile that opened it', async () => {
    mediaAsync = { status: 'ready', data: [media({ _id: 'm1', description: 'Rufus' })] };
    render(<Media targetType="kin" targetId="kf1" />);

    const tileButton = within(tileFor('Rufus')).getByRole('button');
    await userEvent.click(tileButton);
    expect(screen.getByRole('dialog')).toBeInTheDocument();

    await userEvent.keyboard('{Escape}');
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(tileButton).toHaveFocus();
  });

  it('offers NO "Tag kin" button: Android does not offer one on this screen either (#447)', async () => {
    // Kin tagging is a GLOBAL Gallery affordance on both clients
    // (GalleryScreen.kt / Gallery.tsx). MediaGalleryScreen.kt's
    // FullscreenMediaViewer has no tag hand-off, so neither does this. The
    // shared viewer takes it as an optional prop precisely so this screen can
    // leave it off rather than inventing parity Android never had.
    mediaAsync = { status: 'ready', data: [media({ _id: 'm1', description: 'Rufus' })] };
    render(<Media targetType="kin" targetId="kf1" />);

    await userEvent.click(within(tileFor('Rufus')).getByRole('button'));

    expect(screen.getByRole('dialog')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Tag kin' })).toBeNull();
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

    expect(captionedTiles('A photo')).toBe(1);
    expect(captionedTiles('A clip')).toBe(1);

    // The pill is named "Video 1" now that it carries its real count, so match
    // on the leading label rather than the whole accessible name.
    await userEvent.click(screen.getByRole('button', { name: /^Video/ }));
    expect(captionedTiles('A photo')).toBe(0);
    expect(captionedTiles('A clip')).toBe(1);

    await userEvent.click(screen.getByRole('button', { name: /^Video/ }));
    expect(captionedTiles('A photo')).toBe(1);
  });

  it('labels every type pill with its real per-type count, like the mock and the Compose/Android pills', () => {
    mediaAsync = {
      status: 'ready',
      data: [
        media({ _id: 'm1', fileType: 'IMAGE' }),
        media({ _id: 'm2', fileType: 'IMAGE' }),
        media({ _id: 'm3', fileType: 'VIDEO' }),
      ],
    };
    render(<Media targetType="kin" targetId="kf1" />);
    expect(chipLabels()).toEqual(['All 3', 'Image 2', 'Video 1']);
  });

  it('keeps the pill counts on the whole stream, not on the current slice', async () => {
    mediaAsync = {
      status: 'ready',
      data: [
        media({ _id: 'm1', fileType: 'IMAGE' }),
        media({ _id: 'm2', fileType: 'VIDEO' }),
      ],
    };
    render(<Media targetType="kin" targetId="kf1" />);

    await userEvent.click(screen.getByRole('button', { name: /^Video/ }));
    // Narrowing to Video must not restate Image as 0: the counts describe the
    // stream, and a filter is a view over it.
    expect(chipLabels()).toEqual(['All 2', 'Image 1', 'Video 1']);
  });
});

describe('Media screen, count chip', () => {
  it('claims no number while the stream is still loading', () => {
    mediaAsync = { status: 'loading' };
    render(<Media targetType="kin" targetId="kf1" />);
    expect(countChip()).toBeNull();
  });

  it('claims no number when the read failed: unknown is not zero', () => {
    mediaAsync = { status: 'error', message: 'permission-denied' };
    render(<Media targetType="kin" targetId="kf1" />);
    expect(countChip()).toBeNull();
  });

  it('claims no number before a target is even selected', () => {
    mediaAsync = { status: 'ready', data: [media({ _id: 'm1' })] };
    render(<Media targetType="kin" targetId="" />);
    expect(countChip()).toBeNull();
  });

  it('shows the real streamed total once the read resolves', () => {
    mediaAsync = {
      status: 'ready',
      data: [media({ _id: 'm1' }), media({ _id: 'm2' }), media({ _id: 'm3' })],
    };
    render(<Media targetType="kin" targetId="kf1" />);
    expect(countChip()).toHaveTextContent('3 files');
  });

  it('singularises a one-file gallery', () => {
    mediaAsync = { status: 'ready', data: [media({ _id: 'm1' })] };
    render(<Media targetType="kin" targetId="kf1" />);
    expect(countChip()).toHaveTextContent('1 file');
  });

  it('counts the whole stream, not the filtered slice', async () => {
    mediaAsync = {
      status: 'ready',
      data: [
        media({ _id: 'm1', fileType: 'IMAGE' }),
        media({ _id: 'm2', fileType: 'IMAGE' }),
        media({ _id: 'm3', fileType: 'VIDEO' }),
      ],
    };
    render(<Media targetType="kin" targetId="kf1" />);

    await userEvent.click(screen.getByRole('button', { name: /^Video/ }));
    expect(countChip()).toHaveTextContent('3 files');
  });
});

describe('Media screen, hover caption strip', () => {
  function strip(tile: HTMLElement): HTMLElement | null {
    return tile.querySelector('.media__tile-caption-strip');
  }

  it('draws the mock caption strip over the tile, carrying the same real description and meta', () => {
    mediaAsync = {
      status: 'ready',
      data: [media({ _id: 'm1', description: 'Rufus at the park', uploadedBy: 'Jamie' })],
    };
    render(<Media targetType="kin" targetId="kf1" />);

    const s = strip(tileFor('Rufus at the park'));
    expect(s).not.toBeNull();
    expect(s).toHaveTextContent('Rufus at the park');
    expect(s).toHaveTextContent('2026-07-16');
    expect(s).toHaveTextContent('Jamie');
  });

  it('hides the strip from assistive tech: the always-visible body block is the accessible carrier', () => {
    mediaAsync = {
      status: 'ready',
      data: [media({ _id: 'm1', description: 'Rufus at the park' })],
    };
    render(<Media targetType="kin" targetId="kf1" />);

    // jsdom has no user-agent stylesheet, so `toBeVisible()` would pass on the
    // hover-hidden strip regardless. Assert the state carrier instead.
    expect(strip(tileFor('Rufus at the park'))).toHaveAttribute('aria-hidden', 'true');
  });

  it('keeps the same three values always visible below the tile, so nothing is hover-gated', () => {
    mediaAsync = {
      status: 'ready',
      data: [media({ _id: 'm1', description: 'Rufus at the park', uploadedBy: 'Jamie' })],
    };
    render(<Media targetType="kin" targetId="kf1" />);

    const body = tileFor('Rufus at the park').querySelector('.media__tile-body');
    expect(body).toHaveTextContent('Rufus at the park');
    expect(body).toHaveTextContent('2026-07-16 · Jamie');
  });

  it('renders no orphan strip when there is neither a caption nor a meta line', () => {
    mediaAsync = {
      status: 'ready',
      data: [
        {
          _id: 'bare-1',
          storageUrl: 'https://example.test/bare.jpg',
        } as unknown as MediaFile,
      ],
    };
    render(<Media targetType="kin" targetId="kf1" />);

    const cell = document.querySelector('.media__cell');
    expect(cell).not.toBeNull();
    expect(cell?.querySelector('.media__tile-caption-strip')).toBeNull();
  });
});
