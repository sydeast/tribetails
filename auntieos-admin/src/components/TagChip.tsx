import type { CSSProperties } from 'react';
import { resolveTag, type TagDef } from '../lib/tags/model';
import './TagChip.css';

interface TagChipProps {
  /** The tag NAME as stored on the assignment. Resolved against `vocab` for color/icon. */
  name: string;
  /** The relevant vocabulary (household or pet). A name not in it renders a neutral chip. */
  vocab: TagDef[];
  /** When provided, the chip shows an × that calls this (used in the assign field). */
  onRemove?: () => void;
}

/**
 * A single tag chip: the resolved emoji + name, tinted to the tag's palette
 * color. A name with no vocab entry (a free-form tag, or one whose vocab def was
 * removed) resolves to a NEUTRAL chip rather than an error, matching
 * `resolveTag` (the design's "removed vocab tag still renders" rule). Color is
 * derived from the tone with color-mix, the Banner convention, so this file
 * carries no literal colors and a token edit reaches every chip.
 */
export function TagChip({ name, vocab, onRemove }: TagChipProps) {
  const resolved = resolveTag(name, vocab);
  const neutral = resolved.color === null;
  const style = resolved.color !== null ? ({ '--tag-tone': resolved.color.css } as CSSProperties) : undefined;
  const className = ['tag-chip', neutral ? 'tag-chip--neutral' : null].filter(Boolean).join(' ');

  return (
    <span
      className={className}
      style={style}
      {...(resolved.color !== null ? { 'data-token': resolved.color.token } : {})}
    >
      {resolved.icon !== null && resolved.icon !== '' && (
        <span className="tag-chip__icon" aria-hidden="true">
          {resolved.icon}
        </span>
      )}
      <span className="tag-chip__name">{resolved.name}</span>
      {onRemove !== undefined && (
        <button
          type="button"
          className="tag-chip__remove"
          aria-label={`Remove ${resolved.name} tag`}
          onClick={onRemove}
        >
          <svg viewBox="0 0 24 24" focusable="false" aria-hidden="true">
            <path d="M7 7 L17 17 M17 7 L7 17" />
          </svg>
        </button>
      )}
    </span>
  );
}
