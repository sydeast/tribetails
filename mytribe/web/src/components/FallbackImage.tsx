import { useState } from 'react';
import type { CSSProperties, ReactNode } from 'react';

/**
 * One `<img>`, with a caller-supplied fallback for the two states that look
 * identical to a kinfolk but were handled in exactly zero of the portal's
 * `<img>` tags before this component existed: no url at all, and a url that
 * is present but dead (404, DNS failure, a since-deleted Cloudinary asset,
 * offline). BrandLogo.tsx was the only place that bothered with an `onError`
 * handler; every other image in Kin.tsx, Gallery.tsx, Account.tsx,
 * TribeHub.tsx, KinDetail.tsx, KinTales.tsx and SignedImageUpload.tsx only
 * null-checked the url BEFORE render, which does nothing once the browser
 * actually tries to fetch a url that turns out to be dead.
 *
 * `fallback` is markup, not another image url. That is what stops the
 * obvious retry loop: there is no second `<img src>` for the browser to
 * fail again, so `onError` can fire at most once per url.
 */
export function FallbackImage(props: {
  src: string | null | undefined;
  /** Accessible name for the successfully-loaded image. '' is a deliberate, valid choice when a sibling already names the thing (a visible caption, a kin's name in the row). */
  alt: string;
  /** Rendered in place of the `<img>` when there is no url, or the url failed to load. Pick this per surface: an avatar wants the kin's species, a gallery photo wants "photo unavailable", a logo wants nothing at all. */
  fallback: ReactNode;
  className?: string;
  style?: CSSProperties;
  loading?: 'lazy' | 'eager';
}) {
  const url = (props.src ?? '').trim();
  // Keyed on the url, following BrandLogo's pattern: a later fix to the url
  // (a re-upload, a corrected Cloudinary link) must clear a previous
  // failure, or the fallback would keep showing after the real photo started
  // working again.
  const [failedUrl, setFailedUrl] = useState('');

  if (url === '' || failedUrl === url) {
    return <>{props.fallback}</>;
  }

  return (
    <img
      src={url}
      alt={props.alt}
      className={props.className}
      style={props.style}
      loading={props.loading}
      onError={() => setFailedUrl(url)}
    />
  );
}

/**
 * The portal's one glyph for "there was supposed to be a photo here and it
 * failed to load" — a Kin gallery memory, not an identity. Deliberately NOT
 * the same glyph as an avatar's species emoji (which means "no photo was
 * ever set") or the video glyph (which means "this really is a video,
 * showing correctly"). Reusing either would make a genuine failure read as
 * an intentional empty state or a video that isn't there.
 */
export const PHOTO_UNAVAILABLE_GLYPH = '\u{1F5BC}\u{FE0F}';
