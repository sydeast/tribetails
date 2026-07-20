import { useCallback, useRef, type KeyboardEvent } from 'react';

/**
 * WAI-ARIA "tablist" keyboard pattern (manual activation model):
 * https://www.w3.org/WAI/ARIA/apg/patterns/tabs/
 *
 * Every filter tablist in this app already renders real `<button role="tab">`
 * elements with `aria-selected` and an `onClick={() => setFilter(...)}`. They
 * are Tab-reachable but not arrow-navigable, and every tab sits in the Tab
 * order (tabIndex defaults to 0), which is the gap this hook closes:
 *
 *  - Left/Right (or Up/Down when `orientation: 'vertical'`) move DOM focus
 *    between tabs, wrapping at the ends.
 *  - Home/End jump focus to the first/last tab.
 *  - Enter/Space activate whichever tab currently has focus. For a native
 *    `<button>` this is what already happens by default, so this only
 *    matters once focus has moved away from the selected tab via arrow keys;
 *    it deliberately reuses the caller's own onClick (via `.click()`)
 *    instead of taking a second "activate" callback, so filter/selection
 *    logic is never duplicated here.
 *  - Roving tabindex: only the active (selected) tab is tabIndex=0; every
 *    other tab is tabIndex=-1, so one Tab keypress leaves the whole
 *    tablist rather than stepping through every tab in it.
 *
 * Callers keep 100% of their existing aria-selected / className / onClick
 * logic. This hook only ever adds tabIndex + onKeyDown + a ref.
 */

export interface UseRovingTabsOptions {
  /** Total number of tabs currently rendered in this tablist. */
  count: number;
  /** Index of the tab that should carry tabIndex=0 (the selected/active one). */
  activeIndex: number;
  /** Arrow-key axis. Defaults to 'horizontal' (Left/Right). */
  orientation?: 'horizontal' | 'vertical';
}

export interface RovingTabProps {
  ref: (el: HTMLButtonElement | null) => void;
  tabIndex: 0 | -1;
  onKeyDown: (event: KeyboardEvent<HTMLButtonElement>) => void;
}

export function useRovingTabs({ count, activeIndex, orientation = 'horizontal' }: UseRovingTabsOptions) {
  const tabRefs = useRef<Array<HTMLButtonElement | null>>([]);
  tabRefs.current.length = count;

  const focusTabAt = useCallback((index: number) => {
    tabRefs.current[index]?.focus();
  }, []);

  const getTabProps = useCallback(
    (index: number): RovingTabProps => ({
      ref: (el) => {
        tabRefs.current[index] = el;
      },
      tabIndex: index === activeIndex ? 0 : -1,
      onKeyDown: (event) => {
        if (count === 0) return;
        const nextKey = orientation === 'horizontal' ? 'ArrowRight' : 'ArrowDown';
        const prevKey = orientation === 'horizontal' ? 'ArrowLeft' : 'ArrowUp';

        switch (event.key) {
          case nextKey:
            event.preventDefault();
            focusTabAt((index + 1) % count);
            return;
          case prevKey:
            event.preventDefault();
            focusTabAt((index - 1 + count) % count);
            return;
          case 'Home':
            event.preventDefault();
            focusTabAt(0);
            return;
          case 'End':
            event.preventDefault();
            focusTabAt(count - 1);
            return;
          case 'Enter':
          case ' ':
            event.preventDefault();
            event.currentTarget.click();
            return;
          default:
            return;
        }
      },
    }),
    [activeIndex, count, orientation, focusTabAt]
  );

  return { getTabProps };
}
