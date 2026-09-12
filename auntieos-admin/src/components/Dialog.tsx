import { useEffect, useId, useRef, type ReactNode } from 'react';
import './Dialog.css';

interface DialogProps {
  title: string;
  onClose: () => void;
  children: ReactNode;
  /** Action row (e.g. Cancel / Confirm buttons). */
  footer?: ReactNode;
  /**
   * `'center'` (default) is the confirm/edit modal every screen already uses.
   * `'sheet'` is the full-height right-side panel the archive used for a
   * per-record detail view with several stacked sections
   * (`BookingDetailModal.kt`, 480dp). A modifier rather than a second
   * component, because the parts that are easy to get wrong (Escape, the Tab
   * focus trap, focus restore, backdrop dismissal, the labelled
   * `role="dialog"`) are identical and must not be re-implemented per shape.
   *
   * `'wizard'` is the wide, tall variant `WizardModal` needs: a step's worth of
   * form does not fit a 30rem confirm box, and a rail plus a body plus a
   * navigation footer needs the body — not the whole panel — to be the part
   * that scrolls, so the rail stays reachable at any scroll position.
   */
  variant?: 'center' | 'sheet' | 'wizard';
  /**
   * `'standard'` (default) is the 30rem column every confirm/edit modal has
   * always been. `'wide'` is for a modal that carries a second COLUMN rather
   * than more rows (BulkRescheduleDialog today; the template editor used it
   * until the #755 sweep made that editor a page of its own). A size modifier
   * on the shared shell, not a per-screen
   * override of `.dialog`, because a screen stylesheet reaching into another
   * component's class is how two rules end up fighting over the same width.
   *
   * `'full'` is the near-viewport panel a media viewer needs when the browser
   * will not hand it a real fullscreen element (#691). The Fullscreen API is
   * the first choice there; this is the fallback that still lets a 1080px photo
   * be looked at. It takes as much of the viewport as it can rather than a
   * fixed column, and its BODY is the part that scrolls, so a stage inside it
   * can grow to fill the height instead of pushing the footer off screen.
   *
   * Ignored by `variant="sheet"`, which is pinned to the trailing edge and
   * takes its width from that, and by `variant="wizard"`, whose width and
   * height are the shape of the step flow rather than a caller's choice.
   */
  size?: 'standard' | 'wide' | 'full';
}

/**
 * The shared modal. Ports AuntieDialog: a real `role="dialog" aria-modal="true"`
 * with a labelled title, Escape-to-close, backdrop-click-to-close, a close-X,
 * AND the three things a hand-rolled modal always drops, initial focus, a Tab
 * focus-trap, and focus restore to the trigger on close. Built once here so the
 * ~28 screens that need a confirm/edit modal do not each re-implement (and each
 * omit) these.
 */
export function Dialog({
  title,
  onClose,
  children,
  footer,
  variant = 'center',
  size = 'standard',
}: DialogProps) {
  const panelRef = useRef<HTMLDivElement>(null);
  const restoreRef = useRef<HTMLElement | null>(null);
  const titleId = useId();

  // onClose is read through a ref so this effect runs ONCE (mount), not on every
  // onClose identity change. A caller passing an inline arrow recreates onClose
  // each render; keying the effect on it re-ran it, and its panelRef.focus()
  // then stole focus back from any input on every keystroke. The ref keeps
  // Escape calling the current onClose while focus/listener setup stays mount-only.
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;

  useEffect(() => {
    restoreRef.current = document.activeElement as HTMLElement | null;
    panelRef.current?.focus();

    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') {
        e.stopPropagation();
        onCloseRef.current();
        return;
      }
      if (e.key === 'Tab') trapFocus(e, panelRef.current);
    }
    document.addEventListener('keydown', onKey, true);
    return () => {
      document.removeEventListener('keydown', onKey, true);
      restoreRef.current?.focus?.();
    };
  }, []);

  return (
    <div
      className={variant === 'sheet' ? 'dialog__backdrop dialog__backdrop--sheet' : 'dialog__backdrop'}
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div
        ref={panelRef}
        className={
          variant === 'sheet'
            ? 'dialog dialog--sheet'
            : variant === 'wizard'
              ? 'dialog dialog--wizard'
              : size === 'wide'
                ? 'dialog dialog--wide'
                : size === 'full'
                  ? 'dialog dialog--full'
                  : 'dialog'
        }
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        tabIndex={-1}
      >
        <header className="dialog__head">
          <h2 id={titleId} className="dialog__title">
            {title}
          </h2>
          <button type="button" className="dialog__close" aria-label="Close" onClick={onClose}>
            ×
          </button>
        </header>
        <div className="dialog__body">{children}</div>
        {footer ? <footer className="dialog__foot">{footer}</footer> : null}
      </div>
    </div>
  );
}

/** Cycle Tab focus within the panel so it can't escape to the background. */
function trapFocus(e: KeyboardEvent, panel: HTMLElement | null) {
  if (!panel) return;
  const focusables = Array.from(
    panel.querySelectorAll<HTMLElement>(
      'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])',
    ),
  ).filter((el) => !el.hasAttribute('disabled') && el.tabIndex !== -1);
  if (focusables.length === 0) {
    e.preventDefault();
    panel.focus();
    return;
  }
  const first = focusables[0]!;
  const last = focusables[focusables.length - 1]!;
  const active = document.activeElement;
  if (e.shiftKey && (active === first || active === panel)) {
    e.preventDefault();
    last.focus();
  } else if (!e.shiftKey && active === last) {
    e.preventDefault();
    first.focus();
  }
}
