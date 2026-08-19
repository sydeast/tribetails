// @vitest-environment jsdom
import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { type MediaFile } from '../api/gallery';
import { MediaViewerDialog } from './MediaViewerDialog';

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
