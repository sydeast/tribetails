import type { DashSize } from '../lib/dashboardLayout';
import { IconButton } from './Buttons';
import './WidgetEditBar.css';

/**
 * 17.3 Dashboard customization: the edit chrome that sits above one Home widget
 * while the board is in Customize mode. Port of android `HomeScreen.kt`'s
 * private `WidgetEditBar` (move up / move down / hide), plus the resize control
 * android deliberately does not have: a phone board is one column, so `compact`
 * versus `wide` is a wide-screen concern. The size still round-trips through
 * `dashboardLayout.ts` on both surfaces, so setting it here is preserved on the
 * phone rather than being flattened by it.
 *
 * Every control is a real <button> with a real accessible name that names the
 * widget ("Move Care flags up", not "Up"), because four unnamed arrows repeated
 * down a seven-card board is unusable by voice or by screen reader. The bar
 * itself carries no logic: it renders what it is told and calls back. All order
 * and size arithmetic lives in the model, and all persistence in the screen.
 *
 * The bounds arrive as `canMoveUp` / `canMoveDown` rather than being inferred
 * here, and a control that cannot act is genuinely `disabled` rather than
 * styled-out. The model's move helpers are no-ops out of bounds, so a live
 * button at the top of the board would announce a move that did not happen.
 */
export interface WidgetEditBarProps {
  /** Human name of the widget, e.g. "Supplies tracker". Names every control. */
  label: string;
  /** Current size, which decides what the resize control offers to do next. */
  size: DashSize;
  canMoveUp: boolean;
  canMoveDown: boolean;
  /**
   * False for the stat row, which the model forces wide. Rendering a resize
   * button there would offer a change `setWidgetSize` refuses to make.
   */
  canResize: boolean;
  onMoveUp: () => void;
  onMoveDown: () => void;
  /** Called with the size the operator asked for, not with a toggle. */
  onResize: (size: DashSize) => void;
  onRemove: () => void;
}

export function WidgetEditBar({
  label,
  size,
  canMoveUp,
  canMoveDown,
  canResize,
  onMoveUp,
  onMoveDown,
  onResize,
  onRemove,
}: WidgetEditBarProps) {
  const nextSize: DashSize = size === 'wide' ? 'compact' : 'wide';

  return (
    <div className="widget-edit-bar">
      <span className="widget-edit-bar__label">{label}</span>
      <span className="widget-edit-bar__size">{size === 'wide' ? 'Full width' : 'Half width'}</span>
      <IconButton
        icon={<ArrowUpGlyph />}
        label={`Move ${label} up`}
        onClick={onMoveUp}
        disabled={!canMoveUp}
        size={30}
      />
      <IconButton
        icon={<ArrowDownGlyph />}
        label={`Move ${label} down`}
        onClick={onMoveDown}
        disabled={!canMoveDown}
        size={30}
      />
      {canResize && (
        <IconButton
          icon={size === 'wide' ? <ShrinkGlyph /> : <ExpandGlyph />}
          label={
            nextSize === 'wide' ? `Make ${label} full width` : `Make ${label} half width`
          }
          onClick={() => onResize(nextSize)}
          size={30}
        />
      )}
      <IconButton
        icon={<CloseGlyph />}
        label={`Remove ${label} from Home`}
        onClick={onRemove}
        destructive
        size={30}
      />
    </div>
  );
}

/* Glyphs are inline for the same reason DenScreenKit's chevron is: no icon
   package is installed in this app, and four strokes are not worth one. Each is
   aria-hidden by IconButton's wrapper, so the button's label is its only name. */

function glyphProps() {
  return {
    viewBox: '0 0 24 24',
    width: '100%',
    height: '100%',
    fill: 'none',
    stroke: 'currentColor',
    strokeWidth: 2,
    strokeLinecap: 'round' as const,
    strokeLinejoin: 'round' as const,
  };
}

function ArrowUpGlyph() {
  return (
    <svg {...glyphProps()}>
      <path d="M12 19V5M5 12l7-7 7 7" />
    </svg>
  );
}

function ArrowDownGlyph() {
  return (
    <svg {...glyphProps()}>
      <path d="M12 5v14M19 12l-7 7-7-7" />
    </svg>
  );
}

function ExpandGlyph() {
  return (
    <svg {...glyphProps()}>
      <path d="M9 4H4v5M15 20h5v-5M4 15v5h5M20 9V4h-5" />
    </svg>
  );
}

function ShrinkGlyph() {
  return (
    <svg {...glyphProps()}>
      <path d="M4 9h5V4M20 15h-5v5M9 20v-5H4M15 4v5h5" />
    </svg>
  );
}

function CloseGlyph() {
  return (
    <svg {...glyphProps()}>
      <path d="M6 6l12 12M18 6L6 18" />
    </svg>
  );
}
