/**
 * #2323: THE ONE CUT FOR TEXT A PERSON READS. Every preview, push line and
 * text message the server shortens goes through `cutWhole`.
 *
 * A plain `slice(0, n)` counts storage units, not characters. An emoji is two
 * units, a flag is four, and a family or a "woman with a dog" emoji is several
 * emoji glued together with an invisible joiner. A cut inside any of them sends
 * half a character, which the phone draws as a box or a different emoji. The
 * cut here only ever ends between two whole characters as a reader sees them
 * (grapheme clusters, `Intl.Segmenter`).
 *
 * The budget stays in storage units, the same measure `.length` gives, so a
 * 200 limit still means what every caller and test already says it means: the
 * result is never longer than `max`, and is shorter only by the part of a
 * character that would not fit. A single character longer than the whole
 * budget is dropped, never halved.
 */
const graphemes: Intl.Segmenter | null =
  typeof Intl !== 'undefined' && typeof Intl.Segmenter === 'function'
    ? new Intl.Segmenter(undefined, { granularity: 'grapheme' })
    : null;

/** The longest start of `text` that is at most `max` units and ends on a whole character. PURE. */
export function cutWhole(text: string, max: number): string {
  if (text.length <= max) return text;
  if (max <= 0) return '';
  if (graphemes) {
    let end = 0;
    for (const { index, segment } of graphemes.segment(text)) {
      const next = index + segment.length;
      if (next > max) break;
      end = next;
    }
    return text.slice(0, end);
  }
  // No segmenter (never on Node 22): at least never split a surrogate pair.
  const last = text.charCodeAt(max - 1);
  return text.slice(0, last >= 0xd800 && last <= 0xdbff ? max - 1 : max);
}

/** `cutWhole` with an ellipsis when it cut, the whole being at most `max` units. PURE. */
export function cutWithEllipsis(text: string, max: number, ellipsis = '…'): string {
  if (text.length <= max) return text;
  return `${cutWhole(text, max - ellipsis.length).trimEnd()}${ellipsis}`;
}
