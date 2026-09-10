// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { type MediaFile } from '../api/gallery';
// #397 S3. Mocked at the api seam, not at `firebase/firestore`: these tests
// cover the dialog's wiring, and `api/mediaWrite.test.ts` covers the write.
const { updateMediaCaption } = vi.hoisted(() => ({ updateMediaCaption: vi.fn() }));
vi.mock('../api/mediaWrite', async () => {
  const actual = await vi.importActual<typeof import('../api/mediaWrite')>('../api/mediaWrite');
  return { ...actual, updateMediaCaption };
});
import { MediaViewerDialog } from './MediaViewerDialog';
beforeEach(() => {
  updateMediaCaption.mockReset().mockResolvedValue(undefined);
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

describe('MediaViewerDialog', () => {
  it('shows the original storageUrl, not the thumbnail: the tile prefers the thumbnail, the viewer wants the original', () => {
    render(
      <MediaViewerDialog
        media={media({ description: 'Rufus at the park', storageUrl: 'https://cdn/full.jpg', thumbnailUrl: 'https://cdn/thumb.jpg' })}
        onClose={vi.fn()}
      />,
    );
    expect(screen.getByAltText('Rufus at the park')).toHaveAttribute('src', 'https://cdn/full.jpg');
  });

  it('falls back to thumbnailUrl when no storageUrl was ever recorded', () => {
    render(
      <MediaViewerDialog
        media={media({ description: 'Backup shot', storageUrl: '', thumbnailUrl: 'https://cdn/thumb.jpg' })}
        onClose={vi.fn()}
      />,
    );
    expect(screen.getByAltText('Backup shot')).toHaveAttribute('src', 'https://cdn/thumb.jpg');
  });

  it('is a labelled dialog whose title is the caption', () => {
    render(<MediaViewerDialog media={media({ description: 'Rufus at the park' })} onClose={vi.fn()} />);
    expect(screen.getByRole('dialog')).toHaveAccessibleName('Rufus at the park');
  });

  it('titles the dialog "Media" when there is no caption to show', () => {
    render(<MediaViewerDialog media={media({ description: '', originalFileName: '' })} onClose={vi.fn()} />);
    expect(screen.getByRole('dialog')).toHaveAccessibleName('Media');
  });

  it('shows a glyph, never a real <img>, for a document: no visual frame to preview', () => {
    const { container } = render(
      <MediaViewerDialog media={media({ fileType: 'DOCUMENT', description: 'Vet notes' })} onClose={vi.fn()} />,
    );
    expect(container.querySelector('img')).toBeNull();
    // The fallback is `role="img"`, not a real `<img>`: same accessible name,
    // no broken-image icon a real <img> with no src would show.
    expect(screen.getByRole('img', { name: 'Vet notes' })).toBeInTheDocument();
  });

  it('shows a glyph, never a real <img>, for audio', () => {
    const { container } = render(
      <MediaViewerDialog media={media({ fileType: 'AUDIO', description: 'Voicemail' })} onClose={vi.fn()} />,
    );
    expect(container.querySelector('img')).toBeNull();
    expect(screen.getByRole('img', { name: 'Voicemail' })).toBeInTheDocument();
  });

  it('shows the glyph fallback, never an empty <img>, for the degenerate row: no fileType, no caption, no preview URL at all', () => {
    const { container } = render(
      <MediaViewerDialog
        media={
          {
            _id: 'sandbox-1',
            isProfilePhoto: false,
            durationSeconds: 0,
          } as MediaFile
        }
        onClose={vi.fn()}
      />,
    );
    expect(container.querySelector('img')).toBeNull();
    expect(screen.getByRole('img', { name: 'Media' })).toBeInTheDocument();
  });

  it('falls back to the glyph, never a blank hole, when the image fails to load', () => {
    render(
      <MediaViewerDialog
        media={media({ description: 'Broken photo', storageUrl: 'https://dead/full.jpg' })}
        onClose={vi.fn()}
      />,
    );
    const img = screen.getByAltText('Broken photo');
    fireEvent.error(img);
    expect(screen.getByRole('img', { name: 'Broken photo' })).toBeInTheDocument();
    expect(screen.queryByAltText('Broken photo')).toBeNull();
  });

  it('shows a video-preview hint and never claims playback: Android has no in-app player either', () => {
    render(
      <MediaViewerDialog
        media={media({ fileType: 'VIDEO', description: 'Walkies', storageUrl: 'https://cdn/clip.jpg', durationSeconds: 75 })}
        onClose={vi.fn()}
      />,
    );
    expect(screen.getByText(/video preview only/i)).toBeInTheDocument();
    expect(screen.getByText(/duration 1:15/i)).toBeInTheDocument();
  });

  it('calls onClose on Escape (Dialog behavior, wired through)', async () => {
    const onClose = vi.fn();
    render(<MediaViewerDialog media={media({ description: 'Rufus' })} onClose={onClose} />);
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(onClose).toHaveBeenCalledOnce();
  });
});

describe('MediaViewerDialog, kin tagging (#447)', () => {
  it('offers NO "Tag kin" button when the caller does not pass the hand-off', () => {
    // Media.tsx's entity-scoped grid is exactly this case, matching Android's
    // MediaGalleryScreen.kt, whose viewer has no tag affordance either.
    render(<MediaViewerDialog media={media({ description: 'Rufus' })} onClose={vi.fn()} />);
    expect(screen.queryByRole('button', { name: 'Tag kin' })).toBeNull();
  });

  it('offers a named, keyboard-reachable "Tag kin" button when the caller passes one', async () => {
    const onTagKin = vi.fn();
    render(
      <MediaViewerDialog media={media({ description: 'Rufus' })} onClose={vi.fn()} onTagKin={onTagKin} />,
    );
    const button = screen.getByRole('button', { name: 'Tag kin' });
    button.focus();
    fireEvent.keyDown(button, { key: 'Enter' });
    fireEvent.click(button);
    expect(onTagKin).toHaveBeenCalled();
  });

  it('names the kin tagged in the photo', () => {
    render(
      <MediaViewerDialog
        media={media({ description: 'Rufus' })}
        taggedNames={['Waddles', 'Biscuit']}
        onClose={vi.fn()}
      />,
    );
    expect(screen.getByText('Waddles, Biscuit')).toBeInTheDocument();
  });

  it('shows no "Tagged kin" line at all when nobody is tagged, rather than an empty label', () => {
    render(<MediaViewerDialog media={media({ description: 'Rufus' })} taggedNames={[]} onClose={vi.fn()} />);
    expect(screen.queryByText('Tagged kin')).toBeNull();
  });
});
describe('MediaViewerDialog, caption editing (#397 S3)', () => {
  async function openEditor() {
    await userEvent.click(screen.getByRole('button', { name: 'Edit caption' }));
  }
  it('offers the editor on every viewer, since neither grid could fix a caption before', () => {
    render(<MediaViewerDialog media={media({ description: 'Rufus' })} onClose={vi.fn()} />);
    expect(screen.getByRole('button', { name: 'Edit caption' })).toBeInTheDocument();
  });
  it('seeds the field from the STORED description, not from the filename fallback', async () => {
    render(
      <MediaViewerDialog
        media={media({ description: '', originalFileName: 'IMG_4821.jpg' })}
        onClose={vi.fn()}
      />,
    );
    await openEditor();
    // The heading falls back to the filename; the editor must not, or the first
    // Save would store a caption the operator never typed.
    expect(screen.getByLabelText('Caption')).toHaveValue('');
  });
  it('saves the new caption against the media id', async () => {
    render(<MediaViewerDialog media={media({ _id: 'm7', description: 'old' })} onClose={vi.fn()} />);
    await openEditor();
    const field = screen.getByLabelText('Caption');
    await userEvent.clear(field);
    await userEvent.type(field, 'Rufus at the park');
    await userEvent.click(screen.getByRole('button', { name: 'Save caption' }));
    await waitFor(() => expect(updateMediaCaption).toHaveBeenCalledWith('m7', 'Rufus at the park'));
  });
  it('shows the saved caption immediately, because the grid holds a stale copy of the row', async () => {
    render(<MediaViewerDialog media={media({ _id: 'm7', description: 'old caption' })} onClose={vi.fn()} />);
    await openEditor();
    const field = screen.getByLabelText('Caption');
    await userEvent.clear(field);
    await userEvent.type(field, 'new caption');
    await userEvent.click(screen.getByRole('button', { name: 'Save caption' }));
    await waitFor(() => expect(screen.queryByLabelText('Caption')).toBeNull());
    expect(screen.getByRole('dialog')).toHaveTextContent('new caption');
    expect(screen.queryByText('old caption')).toBeNull();
  });
  it('lets an empty caption CLEAR the description, which falls back to the filename', async () => {
    render(
      <MediaViewerDialog
        media={media({ _id: 'm7', description: 'wrong', originalFileName: 'IMG_9.jpg' })}
        onClose={vi.fn()}
      />,
    );
    await openEditor();
    await userEvent.clear(screen.getByLabelText('Caption'));
    await userEvent.click(screen.getByRole('button', { name: 'Save caption' }));
    await waitFor(() => expect(updateMediaCaption).toHaveBeenCalledWith('m7', ''));
    expect(screen.getByRole('dialog')).toHaveTextContent('IMG_9.jpg');
  });
  it('surfaces a refusal and KEEPS the typed words, rather than swallowing both', async () => {
    updateMediaCaption.mockRejectedValue(new Error('Missing or insufficient permissions.'));
    render(<MediaViewerDialog media={media({ _id: 'm7', description: 'old' })} onClose={vi.fn()} />);
    await openEditor();
    const field = screen.getByLabelText('Caption');
    await userEvent.clear(field);
    await userEvent.type(field, 'my new words');
    await userEvent.click(screen.getByRole('button', { name: 'Save caption' }));
    await waitFor(() =>
      expect(screen.getByRole('alert')).toHaveTextContent(/insufficient permissions/i),
    );
    // Still open, still holding what was typed: a failed save must not eat it.
    expect(screen.getByLabelText('Caption')).toHaveValue('my new words');
  });
  it('does not change the shown caption when the save was refused', async () => {
    updateMediaCaption.mockRejectedValue(new Error('nope'));
    render(<MediaViewerDialog media={media({ _id: 'm7', description: 'old caption' })} onClose={vi.fn()} />);
    await openEditor();
    const field = screen.getByLabelText('Caption');
    await userEvent.clear(field);
    await userEvent.type(field, 'never stored');
    await userEvent.click(screen.getByRole('button', { name: 'Save caption' }));
    await waitFor(() => expect(screen.getByRole('alert')).toBeInTheDocument());
    expect(screen.getByRole('dialog')).toHaveTextContent('old caption');
  });
  it('Cancel closes the editor and writes nothing', async () => {
    render(<MediaViewerDialog media={media({ _id: 'm7', description: 'old' })} onClose={vi.fn()} />);
    await openEditor();
    await userEvent.type(screen.getByLabelText('Caption'), ' edited');
    await userEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(screen.queryByLabelText('Caption')).toBeNull();
    expect(updateMediaCaption).not.toHaveBeenCalled();
  });
});
describe('MediaViewerDialog, seeing the whole photo (#691)', () => {
  it('links out to the original file for an image, the way the video hint has always promised', () => {
    render(
      <MediaViewerDialog
        media={media({ description: 'Rufus at the park', storageUrl: 'https://cdn/full.jpg', thumbnailUrl: 'https://cdn/thumb.jpg' })}
        onClose={vi.fn()}
      />,
    );
    const link = screen.getByRole('link', { name: 'Open original' });
    // The full-resolution file, never the 300px thumbnail the tile uses.
    expect(link).toHaveAttribute('href', 'https://cdn/full.jpg');
    expect(link).toHaveAttribute('target', '_blank');
  });

  it('links out to the original for a video too', () => {
    render(
      <MediaViewerDialog
        media={media({ fileType: 'VIDEO', description: 'Walkies', storageUrl: 'https://cdn/clip.mp4' })}
        onClose={vi.fn()}
      />,
    );
    expect(screen.getByRole('link', { name: 'Open original' })).toHaveAttribute('href', 'https://cdn/clip.mp4');
  });

  it('offers no "Open original" link for a document: there is no frame to open', () => {
    render(<MediaViewerDialog media={media({ fileType: 'DOCUMENT', description: 'Vet notes' })} onClose={vi.fn()} />);
    expect(screen.queryByRole('link', { name: 'Open original' })).toBeNull();
  });

  it('offers a fullscreen toggle on the stage itself, not in the footer the fullscreen element would hide', () => {
    const { container } = render(
      <MediaViewerDialog media={media({ description: 'Rufus', storageUrl: 'https://cdn/full.jpg' })} onClose={vi.fn()} />,
    );
    const toggle = screen.getByRole('button', { name: 'Fullscreen' });
    expect(toggle).toHaveAttribute('aria-pressed', 'false');
    expect(toggle.closest('.media-viewer__stage')).toBe(container.querySelector('.media-viewer__stage'));
  });

  it('falls back to the larger modal when the browser has no Fullscreen API, rather than swallowing the click', async () => {
    // jsdom implements neither `Element.requestFullscreen` nor
    // `document.exitFullscreen`, which is exactly the case this fallback is for
    // (iOS Safari, an iframe with no `allow="fullscreen"`, a locked-down
    // webview). The button must still make the picture bigger.
    const { container } = render(
      <MediaViewerDialog media={media({ description: 'Rufus', storageUrl: 'https://cdn/full.jpg' })} onClose={vi.fn()} />,
    );
    expect(container.querySelector('.dialog--full')).toBeNull();
    await userEvent.click(screen.getByRole('button', { name: 'Fullscreen' }));
    expect(container.querySelector('.dialog--full')).not.toBeNull();
    expect(screen.getByRole('button', { name: 'Exit fullscreen' })).toHaveAttribute('aria-pressed', 'true');
    await userEvent.click(screen.getByRole('button', { name: 'Exit fullscreen' }));
    expect(container.querySelector('.dialog--full')).toBeNull();
  });

  it('uses the Fullscreen API when the browser has one, and does not open the fallback modal instead', async () => {
    const requestFullscreen = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(Element.prototype, 'requestFullscreen', {
      value: requestFullscreen,
      configurable: true,
      writable: true,
    });
    try {
      const { container } = render(
        <MediaViewerDialog media={media({ description: 'Rufus', storageUrl: 'https://cdn/full.jpg' })} onClose={vi.fn()} />,
      );
      await userEvent.click(screen.getByRole('button', { name: 'Fullscreen' }));
      expect(requestFullscreen).toHaveBeenCalledOnce();
      // The real thing was granted, so the fallback must NOT also fire: two
      // "bigger" states at once is a panel the operator cannot get out of.
      expect(container.querySelector('.dialog--full')).toBeNull();
    } finally {
      Reflect.deleteProperty(Element.prototype, 'requestFullscreen');
    }
  });

  it('falls back to the larger modal when the browser REFUSES the fullscreen request', async () => {
    const requestFullscreen = vi.fn().mockRejectedValue(new Error('permissions policy'));
    Object.defineProperty(Element.prototype, 'requestFullscreen', {
      value: requestFullscreen,
      configurable: true,
      writable: true,
    });
    try {
      const { container } = render(
        <MediaViewerDialog media={media({ description: 'Rufus', storageUrl: 'https://cdn/full.jpg' })} onClose={vi.fn()} />,
      );
      await userEvent.click(screen.getByRole('button', { name: 'Fullscreen' }));
      await waitFor(() => expect(container.querySelector('.dialog--full')).not.toBeNull());
    } finally {
      Reflect.deleteProperty(Element.prototype, 'requestFullscreen');
    }
  });
});
