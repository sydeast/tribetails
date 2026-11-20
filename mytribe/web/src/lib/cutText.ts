/**
 * #2323: a cut that never ends on part of a character. `slice(0, n)` counts
 * storage units: an emoji is two, a flag four, and a family emoji is several
 * emoji glued with an invisible joiner. A cut inside one draws a box or a
 * different emoji. This ends only between whole characters as a reader sees
 * them (`Intl.Segmenter`), and is never longer than `max` units. The same rule
 * as the server's `lib/cutText.ts`.
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
  // An older browser with no segmenter: at least never split a surrogate pair.
  const last = text.charCodeAt(max - 1);
  return text.slice(0, last >= 0xd800 && last <= 0xdbff ? max - 1 : max);
}
