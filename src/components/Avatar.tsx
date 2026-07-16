import { useState, type CSSProperties, type ReactNode } from 'react';
import './Avatar.css';

export type AvatarShape = 'circle' | 'rounded';

/**
 * The brand gradients an avatar can be seeded onto, as tokens.
 *
 * FIDELITY GAP, deliberate and reported rather than papered over. The Compose
 * source (avatarPaletteFor in AuntieAvatar.kt) picks from FIVE two-stop pairings:
 *
 *   0 primary -> secondary   orange-pink    == --gradient-orange-pink
 *   1 accent  -> tertiary    teal-purple    == --gradient-teal-purple
 *   2 secondary -> tertiary  pink-purple    NO TOKEN
 *   3 primary -> accent      orange-teal    NO TOKEN
 *   4 tertiary -> secondary  purple-pink    NO TOKEN
 *
 * tokens.css defines four gradients and only the first two pairings survive the
 * translation. Minting --gradient-pink-purple and friends would be inventing
 * tokens, which the port is not allowed to do, and hand-writing the raw colour
 * stops would be worse. So the list below is the four real tokens.
 *
 * The consequence, stated plainly: the hash is reproduced EXACTLY, but the
 * modulo lands on a four-item list instead of a five-item one, so a given pet
 * keeps a stable colour HERE while not necessarily matching the colour the same
 * pet shows in the Compose app. Stability was the point of the seed; cross-app
 * identity was never enforced by anything but this list length.
 *
 * Order is chosen so the two exact pairings keep their Compose index (0 and 1).
 */
export const BRAND_GRADIENTS = [
  'var(--gradient-orange-pink)',
  'var(--gradient-teal-purple)',
  'var(--gradient-sunset-glow)',
  'var(--gradient-tribe)',
] as const;

export type BrandGradient = (typeof BRAND_GRADIENTS)[number];

/**
 * Maps an arbitrary seed to a stable brand gradient, so the same pet or person
 * always reads with the same colour signature.
 *
 * The hash is a faithful port of avatarPaletteFor's, not a new one. Kotlin:
 *
 *   var h = 0
 *   for (ch in key) h = (h * 31 + ch.code) and 0x7FFFFFFF
 *   return pairs[h % pairs.size]
 *
 * Two details that matter for matching it:
 *  - Math.imul mirrors Kotlin's 32-bit Int multiply. The mask each round keeps h
 *    non-negative and under 2^31, which is also what keeps the arithmetic exact.
 *  - charCodeAt walks UTF-16 code units, which is what Kotlin's `ch.code` yields.
 *    Iterating code points instead (for..of) would disagree on emoji seeds.
 *
 * The Compose source comments that this hash exists to avoid String.hashCode's
 * platform variance. Same reason it is spelled out here rather than reached for
 * from a library.
 */
export function gradientForSeed(seed: string): BrandGradient {
  if (seed.length === 0) return BRAND_GRADIENTS[0];

  let h = 0;
  for (let i = 0; i < seed.length; i++) {
    h = (Math.imul(h, 31) + seed.charCodeAt(i)) & 0x7fffffff;
  }

  // h is non-negative and the index is a modulo of the list length, so this is
  // always in range. The fallback is for noUncheckedIndexedAccess, which cannot
  // see that, and keeps the function total rather than returning T | undefined.
  return BRAND_GRADIENTS[h % BRAND_GRADIENTS.length] ?? BRAND_GRADIENTS[0];
}

/** Trim to a tidy one-or-two-character monogram, uppercased. Ports normalizeInitials. */
export function normalizeInitials(raw: string): string {
  const letters = raw.replace(/\s/g, '');
  return letters.slice(0, 2).toUpperCase();
}

interface Props {
  /**
   * The accessible name, e.g. the pet or person this avatar stands for. REQUIRED,
   * and the whole reason this component exists in the DOM.
   *
   * The wasm app renders to a canvas and publishes no accessibility tree at all:
   * verified 2026-07-15, zero labels, zero buttons. An avatar there is not a pet,
   * it is a coloured circle, because nothing can read it. A decorative div here
   * would ship that same nothing on a platform that hands us the fix for free.
   */
  label: string;
  /**
   * These four are fed straight from Firestore documents, where a missing photo or
   * a nameless pet is normal. Spelling `| undefined` alongside `?` lets a caller
   * pass `pet.photoUrl` directly under exactOptionalPropertyTypes instead of
   * building a conditional spread at every call site.
   */
  imageUrl?: string | undefined;
  initials?: string | undefined;
  emoji?: string | undefined;
  /** Defaults to `initials`, matching the Compose parameter default. */
  gradientSeed?: string | undefined;
  /** Caller-supplied glyph. No icon is hardcoded here, matching the Compose source. */
  glyph?: ReactNode;
  /** Rendered size in px. Type scales off it, as in the Compose source. */
  size?: number;
  shape?: AvatarShape;
  ring?: boolean;
  className?: string;
}

/**
 * The Den's single avatar primitive, ported from AuntieAvatar.kt.
 *
 * Resolution order (first usable wins), unchanged from the Compose source:
 *   1. imageUrl  on load error it falls back to the next representation rather
 *                than leaving a blank hole (fail-visible)
 *   2. initials  one or two letters on a deterministic brand gradient
 *   3. glyph     a caller-supplied icon centered on the gradient
 *   4. emoji     an emoji centered on the gradient
 *   5. (none)    gradient-only tile, still on-brand, never empty
 *
 * There is deliberately no empty branch. The gradient is always underneath, so
 * the worst case is an on-brand tile with a correct accessible name, never the
 * empty box a broken thumbnail would otherwise collapse to.
 */
export function Avatar({
  label,
  imageUrl,
  initials,
  emoji,
  gradientSeed,
  glyph,
  size = 42,
  shape = 'circle',
  ring = true,
  className,
}: Props) {
  // Track WHICH url failed, not a bare boolean. A changed url has to get its own
  // attempt, which is what `remember(cleanUrl) { mutableStateOf(false) }` buys in
  // Compose; a boolean would strand the avatar on the fallback after one bad url.
  // Derived at render, so no effect is needed to reset it.
  const [failedUrl, setFailedUrl] = useState<string | null>(null);

  const cleanUrl = blankToUndefined(imageUrl);
  const cleanInitials = initials !== undefined ? normalizeInitials(initials) : '';
  const cleanEmoji = blankToUndefined(emoji);
  const showImage = cleanUrl !== undefined && failedUrl !== cleanUrl;

  // Seeds off the RAW initials, not the normalized ones, matching the Compose
  // default `gradientSeed: Any? = initials`.
  const gradient = gradientForSeed(gradientSeed ?? initials ?? '');

  // The seeded gradient and the size ride down as custom properties so the
  // stylesheet can scale the type and the glyph off one number, rather than this
  // file computing pixel sizes the CSS would rather own.
  const style = {
    '--avatar-size': `${size}px`,
    '--avatar-gradient': gradient,
  } as CSSProperties;

  const className_ = ['avatar', ring ? 'avatar-ring' : '', className ?? '']
    .filter(Boolean)
    .join(' ');

  return (
    <span className={className_} style={style} data-shape={shape}>
      <span className={`avatar-inner${showImage ? ' avatar-inner-photo' : ''}`}>
        {showImage && cleanUrl !== undefined ? (
          <img
            className="avatar-photo"
            src={cleanUrl}
            alt={label}
            onError={() => setFailedUrl(cleanUrl)}
          />
        ) : (
          // role="img" + aria-label so the fallback keeps the SAME accessible name
          // the photo had. role="img" also prunes the monogram or emoji below it
          // from the accessibility tree, so "RU" is never announced beside "Rufus".
          <span className="avatar-fallback" role="img" aria-label={label}>
            {cleanInitials !== '' ? (
              <span className="avatar-initials">{cleanInitials}</span>
            ) : glyph !== undefined ? (
              <span className="avatar-glyph">{glyph}</span>
            ) : cleanEmoji !== undefined ? (
              <span className="avatar-emoji">{cleanEmoji}</span>
            ) : null /* gradient-only tile: intentional, on-brand, never blank */}
          </span>
        )}
      </span>
    </span>
  );
}

/** Ports Kotlin's `takeIf { it.isNotBlank() }`: whitespace-only is as absent as null. */
function blankToUndefined(s: string | undefined): string | undefined {
  if (s === undefined) return undefined;
  return s.trim() === '' ? undefined : s;
}
