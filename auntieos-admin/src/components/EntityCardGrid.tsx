import type { CSSProperties, ReactNode } from 'react';
import './EntityCardGrid.css';

/**
 * The one card grid behind the list-shape rule.
 *
 * THE RULE (operator ruling 2026-08-06, "04 CARDS  One rule for list shape",
 * written out in full in `docs/2026-05-31-den-redesign-design.md`): a screen
 * that browses a set of PEER ENTITIES renders them as cards in this grid. A
 * single full-width column is for CHRONOLOGICAL FEEDS, where the reading order
 * is itself information. One screen is a named exception, Form Schemas, and the
 * design doc says why.
 *
 * Why a component rather than a shared class: before this, Directory, Vet
 * clinics and Invites each carried their own copy of the same
 * `repeat(auto-fill, minmax(…, 1fr))` declaration. Three copies is how they
 * drifted to three different card widths and two different gaps without anyone
 * deciding to, and it is why the review could not tell a deliberate difference
 * from an accidental one.
 *
 * WHAT IS SHARED AND WHAT IS NOT. The mechanism is shared: auto-fill (never
 * auto-fit, so one card keeps a card's width instead of stretching across the
 * panel and reading as a banner), the list reset, and the list semantics. The
 * card WIDTH is not, because the operator's mocks genuinely disagree, Directory
 * 290px, Vet clinics 300px, Template Bank 310px, and forcing one number would
 * put two screens off their own mock in the name of consistency.
 */
export interface EntityCardGridProps {
  /**
   * Names the list for assistive tech, e.g. "Kinfolk", "Templates". Required,
   * not optional: an unnamed list on a screen with two of them (Directory has a
   * Kinfolk grid and a Kin grid) announces as "list" twice and tells a screen
   * reader user nothing.
   */
  label: string;
  /**
   * The card min width this screen's mock draws, as a CSS length. Omit to take
   * the stylesheet's 290px default.
   */
  minCardWidth?: string;
  /**
   * `start` hangs cards from the top of their row instead of stretching them to
   * the tallest sibling. Directory opts in because its cards hold a
   * variable-length kin list; the default is the mocks' plain `.grid`, which
   * stretches.
   */
  align?: 'stretch' | 'start';
  /** Extra classes for screen-local decoration. The grid itself is not overridable. */
  className?: string;
  /** The cards, each an `<li>`. */
  children: ReactNode;
}

export function EntityCardGrid({
  label,
  minCardWidth,
  align = 'stretch',
  className,
  children,
}: EntityCardGridProps) {
  const classes = ['entity-grid'];
  if (align === 'start') classes.push('entity-grid--start');
  if (className) classes.push(className);

  // Only set the property when the caller named a width, so an omitted prop
  // leaves the stylesheet's default in charge rather than writing an empty
  // inline value over it.
  const style = minCardWidth
    ? ({ '--entity-card-min': minCardWidth } as CSSProperties)
    : undefined;

  return (
    // `role="list"` is redundant in the DOM and is not redundant in Safari,
    // which drops list semantics from a `list-style: none` list. The reset is
    // non-negotiable for a card grid, so the role is stated rather than assumed.
    <ul role="list" className={classes.join(' ')} aria-label={label} {...(style ? { style } : {})}>
      {children}
    </ul>
  );
}
